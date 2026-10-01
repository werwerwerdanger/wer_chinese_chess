/**
 * 本地蒸馏模型适配器 — 包装 @wer-chess/engine 的 Board，think 转发本地 NNUE 服务
 *
 * 架构与 PikafishAdapter 同构：规则能力全部委托本地引擎（LocalEngineAdapter），
 * AI 思考经 HTTP 转发 tools/distill/nnue-serve.mjs（onnxruntime-node，端口 8789）。
 * 坐标换算：UCI "h2e2"，file a-i = col 0-8，rank 0-9 = 9-row。
 */
import type { Move } from '@wer-chess/engine';
import { LocalEngineAdapter } from './local-adapter.js';
import { EngineError, type EngineAdapter, type PositionView } from './types.js';

interface NnueReply {
  move: string;
  score: number;
  depth: number;
  nodes: number;
  timeMs: number;
  error?: string;
}

export class NnueAdapter implements EngineAdapter {
  readonly name = 'wer-engine v0.2 (NNUE distill)';

  private local = new LocalEngineAdapter();

  constructor(private readonly serveUrl = 'http://127.0.0.1:8789') {}

  // ---- 规则能力全部委托本地引擎 ----
  getPosition(): PositionView { return this.local.getPosition(); }
  legalMoves(): Move[] { return this.local.legalMoves(); }
  makeMove(move: Move): void { this.local.makeMove(move); }
  undo(): boolean { return this.local.undo(); }
  reset(): void { this.local.reset(); }
  inCheck(): boolean { return this.local.inCheck(); }
  gameOver(): 'red-win' | 'black-win' | null { return this.local.gameOver(); }
  describeMove(move: Move): string | null { return this.local.describeMove(move); }
  getFen(): string { return this.local.getFen(); }
  loadFen(fen: string): void { this.local.loadFen(fen); }
  moveNumber(): number { return this.local.moveNumber(); }
  seekTo(n: number): number { return this.local.seekTo(n); }

  // ---- AI：转发本地 NNUE 服务 ----
  async think(depth: number, _timeLimitMs = 3000): Promise<{ move: Move; score: number; depth: number; nodes: number; timeMs: number }> {
    const t0 = performance.now();
    let resp: Response;
    try {
      resp = await fetch(`${this.serveUrl}/think`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fen: this.local.getFen(), depth }),
      });
    } catch {
      throw new EngineError('连不上蒸馏模型服务（tools/distill/nnue-serve.mjs 未启动？）');
    }
    const r = (await resp.json()) as NnueReply;
    if (!resp.ok) throw new EngineError(r.error ?? `nnue-serve HTTP ${resp.status}`);

    const hit = this.local.legalMoves().find((m) => {
      const u = `${sqToUci(m.from)}${sqToUci(m.to)}`;
      return u === r.move;
    });
    if (!hit) throw new EngineError(`NNUE 服务返回非法走法 ${r.move}`);

    return { move: hit, score: r.score, depth: r.depth, nodes: r.nodes, timeMs: Math.round(performance.now() - t0) };
  }
}

function sqToUci(sqIdx: number): string {
  const row = Math.floor(sqIdx / 9);
  const col = sqIdx % 9;
  return `${String.fromCharCode(97 + col)}${9 - row}`;
}
