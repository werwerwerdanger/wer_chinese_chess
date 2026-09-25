/**
 * Pikafish 适配器 — 本地 UCI 强引擎（腾讯开源 NNUE）经桥接服务接入
 *
 * 架构：浏览器无法 spawn 进程，规则/局面仍走本地引擎（LocalEngineAdapter），
 * AI 思考经 HTTP 桥接（tools/pikafish/bridge.mjs，端口 8788）转发给常驻
 * Pikafish 进程。装饰器模式：规则能力全部委托，只有 think 被重写。
 *
 * 坐标换算：UCI 走法如 "h2e2"，file a-i（0-8 列），rank 0-9（rank 0 = 红方
 * 底线 = 引擎 row 9）→ row = 9 - rank。
 */
import type { Move } from '@wer-chess/engine';
import { LocalEngineAdapter } from './local-adapter.js';
import { EngineError, type EngineAdapter, type PositionView } from './types.js';

interface BridgeReply {
  move: string;
  scoreCp: number | null;
  mate: number | null;
  depth: number;
  nodes: number;
  timeMs: number;
  error?: string;
}

export class PikafishAdapter implements EngineAdapter {
  readonly name = 'Pikafish (NNUE)';
  private local = new LocalEngineAdapter();

  constructor(private readonly bridgeUrl = 'http://127.0.0.1:8788') {}

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

  // ---- AI：转发桥接 ----
  async think(depth: number, _timeLimitMs = 3000): Promise<{ move: Move; score: number; depth: number; nodes: number; timeMs: number }> {
    // UI 难度下拉 (2/4/6) 映射到 Pikafish 深度：6/12/18
    const goDepth = Math.max(4, Math.min(depth * 3, 18));
    const t0 = performance.now();
    let resp: Response;
    try {
      resp = await fetch(`${this.bridgeUrl}/think`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fen: this.local.getFen(), depth: goDepth }),
      });
    } catch {
      throw new EngineError('连不上 Pikafish 桥接服务（tools/pikafish/bridge.mjs 未启动？）');
    }
    const r = (await resp.json()) as BridgeReply;
    if (!resp.ok) throw new EngineError(r.error ?? `bridge HTTP ${resp.status}`);

    const hit = this.local.legalMoves().find((m) => {
      const u = this.moveToUci(m);
      return u === r.move;
    });
    if (!hit) throw new EngineError(`Pikafish 返回非法走法 ${r.move}`);

    const score = r.mate !== null
      ? (r.mate > 0 ? 1000 - r.mate : -1000 - r.mate)
      : Math.round(r.scoreCp ?? 0) / 100;
    return { move: hit, score, depth: r.depth, nodes: r.nodes, timeMs: Math.round(performance.now() - t0) };
  }

  /** UCI 坐标 "h2e2" → 引擎 Move（row = 9 - rank, col = file - 'a'） */
  private moveToUci(m: Move): string {
    return `${sqToUci(m.from)}${sqToUci(m.to)}`;
  }
}

function sqToUci(sqIdx: number): string {
  const row = Math.floor(sqIdx / 9);
  const col = sqIdx % 9;
  return `${String.fromCharCode(97 + col)}${9 - row}`;
}
