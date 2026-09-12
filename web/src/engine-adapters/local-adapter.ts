/**
 * 本组自有引擎的适配器 — 包装 @wer-chess/engine 的 Board
 */
import {
  Board, Color, Piece, generateLegalMoves, inCheck,
  PIECE_NAMES, colOf, rowOf,
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

  getPosition(): PositionView {
    // squares 拷贝避免 UI 直接改内部状态
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
    this.board = new Board();
    this.history = [];
  }

  inCheck(): boolean {
    return inCheck(this.board, this.board.turn);
  }

  /**
   * 中国象棋终局：将死或困毙都是输（困毙方负）。
   * 红方无合法走子 → 黑胜；黑方无合法走子 → 红胜。
   */
  gameOver(): 'red-win' | 'black-win' | null {
    const side = this.board.turn;
    if (generateLegalMoves(this.board, side).length > 0) return null;
    // 当前行棋方无棋可走：将死或困毙都判负
    return side === Color.Red ? 'black-win' : 'red-win';
  }

  describeMove(move: Move): string | null {
    const piece = this.board.at(move.from);
    if (piece === Piece.None) return null;
    const name = PIECE_NAMES[piece] ?? '?';
    const from = `${rowOf(move.from)}行${colOf(move.from)}列`;
    const to = `${rowOf(move.to)}行${colOf(move.to)}列`;
    return `${name} ${from} → ${to}`;
  }
}
