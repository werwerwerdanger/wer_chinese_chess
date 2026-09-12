/**
 * 本组自有引擎的适配器 — 包装 @wer-chess/engine 的 Board
 */
import {
  Board, Color, Piece, generateLegalMoves, inCheck, moveToChinese, Searcher,
} from '@wer-chess/engine';
import type { Move } from '@wer-chess/engine';
import type { EngineAdapter, PositionView } from './types.js';
import { EngineError } from './types.js';

interface HistoryEntry {
  move: Move;
  undo: { captured: Piece; hashKey: bigint };
}

export class LocalEngineAdapter implements EngineAdapter {
  readonly name = 'wer-engine v0.1 (rules only)';

  private board = new Board();
  private history: HistoryEntry[] = [];
  private startFen: string;

  constructor(fen?: string) {
    this.startFen = fen ?? new Board().toFen();
    this.board = new Board(this.startFen);
  }

  getPosition(): PositionView {
    return {
      squares: Array.from(this.board.squares),
      turn: this.board.turn as 0 | 1,
    };
  }

  legalMoves(): Move[] {
    return generateLegalMoves(this.board, this.board.turn);
  }

  makeMove(move: Move): void {
    const legal = this.legalMoves().find(
      (m) => m.from === move.from && m.to === move.to,
    );
    if (!legal) throw new EngineError('非法走子');
    this.history.push({ move: legal, undo: this.board.makeMove(legal) });
  }

  undo(): boolean {
    const last = this.history.pop();
    if (!last) return false;
    this.board.unmakeMove(last.move, last.undo);
    return true;
  }

  reset(): void {
    this.board = new Board(this.startFen);
    this.history = [];
  }

  inCheck(): boolean {
    return inCheck(this.board, this.board.turn);
  }

  /**
   * 中国象棋终局：将死或困毙都是输（困毙方负）。
   */
  gameOver(): 'red-win' | 'black-win' | null {
    const side = this.board.turn;
    if (generateLegalMoves(this.board, side).length > 0) return null;
    return side === Color.Red ? 'black-win' : 'red-win';
  }

  // ---- 打谱 ----

  /** 中文纵线记谱（"炮二平五"式）。须在走子前调用。 */
  describeMove(move: Move): string | null {
    return moveToChinese(this.board, move);
  }

  getFen(): string {
    return this.board.toFen();
  }

  loadFen(fen: string): void {
    try {
      this.board = new Board(fen);
      this.startFen = fen;
      this.history = [];
    } catch (err) {
      throw new EngineError(`FEN 无效： ${(err as Error).message}`);
    }
  }

  moveNumber(): number {
    return this.history.length;
  }

  seekTo(n: number): number {
    const target = Math.max(0, Math.min(n, this.history.length));
    while (this.history.length > target) this.undo();
    return this.history.length;
  }

  // ---- AI ----

  think(depth: number, timeLimitMs = 3000): { move: Move; score: number; depth: number; nodes: number; timeMs: number } {
    const searcher = new Searcher(this.board);
    const r = searcher.search(depth, timeLimitMs);
    if (!r.bestMove) throw new EngineError('无棋可走');
    // SearchResult.score 是红方视角，转成"当前思考方"视角供 UI 展示
    const sign = this.board.turn === 0 ? 1 : -1;
    return {
      move: r.bestMove,
      score: r.score * sign,
      depth: r.depth,
      nodes: r.nodes,
      timeMs: r.timeMs,
    };
  }
}
