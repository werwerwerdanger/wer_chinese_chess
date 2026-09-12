/**
 * 走子生成器 — 七种棋子的伪合法走子生成
 *
 * 各棋子规则：
 * - 帅/将：九宫内上下左右一步；将帅照面由合法性层过滤
 * - 仕/士：九宫内斜走一步
 * - 相/象：田字斜走两步，不过河，塞象眼不可走
 * - 马：日字，蹩马腿不可走
 * - 车：直线任意距离，不能越子
 * - 炮：平移同车；吃子必须隔一个"炮架"
 * - 兵/卒：过河前只进一步；过河后可进可平（不可后退）
 */
import { Color, Piece, PieceType, type Move } from './types.js';
import {
  BOARD_COLS, colorOf, colOf, elephantZone,
  inPalace, onBoard, pawnCrossed, rowOf, sq, typeOf,
} from './constants.js';
import type { Board } from './board.js';

/**
 * 生成 side 方的所有伪合法走子。
 * 伪合法 = 符合棋子行棋规则、不落己方子；不检查走完是否被将军（那层在 legality.ts）。
 */
export function generatePseudoLegalMoves(board: Board, side: Color): Move[] {
  const moves: Move[] = [];
  const opp = (side ^ 1) as Color;

  for (let from = 0; from < 90; from++) {
    const p = board.squares[from]!;
    if (p === Piece.None || colorOf(p) !== side) continue;

    switch (typeOf(p)) {
      case PieceType.King: genKing(board, from, side, opp, moves); break;
      case PieceType.Advisor: genAdvisor(board, from, side, opp, moves); break;
      case PieceType.Elephant: genElephant(board, from, side, opp, moves); break;
      case PieceType.Horse: genHorse(board, from, side, opp, moves); break;
      case PieceType.Rook: genRook(board, from, side, opp, moves); break;
      case PieceType.Cannon: genCannon(board, from, side, opp, moves); break;
      case PieceType.Pawn: genPawn(board, from, side, opp, moves); break;
    }
  }
  return moves;
}

function pushMove(board: Board, from: number, to: number, opp: Color, moves: Move[]): void {
  const target = board.squares[to]!;
  if (target === Piece.None || colorOf(target) === opp) {
    moves.push({ from, to, captured: target });
  }
}

// --- 帅/将 ---
function genKing(board: Board, from: number, side: Color, opp: Color, moves: Move[]): void {
  const r = rowOf(from), c = colOf(from);
  const deltas: ReadonlyArray<readonly [number, number]> = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  for (const [dr, dc] of deltas) {
    const nr = r + dr, nc = c + dc;
    if (!inPalace(nr, nc, side)) continue;
    pushMove(board, from, sq(nr, nc), opp, moves);
  }
}

// --- 仕/士 ---
function genAdvisor(board: Board, from: number, side: Color, opp: Color, moves: Move[]): void {
  const r = rowOf(from), c = colOf(from);
  const deltas: ReadonlyArray<readonly [number, number]> = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
  for (const [dr, dc] of deltas) {
    const nr = r + dr, nc = c + dc;
    if (!inPalace(nr, nc, side)) continue;
    pushMove(board, from, sq(nr, nc), opp, moves);
  }
}

// --- 相/象 ---
function genElephant(board: Board, from: number, side: Color, opp: Color, moves: Move[]): void {
  const r = rowOf(from), c = colOf(from);
  const deltas: ReadonlyArray<readonly [number, number]> = [[-2, -2], [-2, 2], [2, -2], [2, 2]];
  for (const [dr, dc] of deltas) {
    const nr = r + dr, nc = c + dc;
    if (!onBoard(nr, nc)) continue;
    if (!elephantZone(nr, side)) continue;              // 不过河
    if (board.squares[sq(r + dr / 2, c + dc / 2)] !== Piece.None) continue; // 塞象眼
    pushMove(board, from, sq(nr, nc), opp, moves);
  }
}

// --- 马 ---
function genHorse(board: Board, from: number, _side: Color, opp: Color, moves: Move[]): void {
  const r = rowOf(from), c = colOf(from);
  // [dr, dc, legDr, legDc]：落点与对应蹩腿位
  const table: ReadonlyArray<readonly [number, number, number, number]> = [
    [-2, -1, -1, 0], [-2, 1, -1, 0],
    [2, -1, 1, 0], [2, 1, 1, 0],
    [-1, -2, 0, -1], [1, -2, 0, -1],
    [-1, 2, 0, 1], [1, 2, 0, 1],
  ];
  for (const [dr, dc, lr, lc] of table) {
    const nr = r + dr, nc = c + dc;
    if (!onBoard(nr, nc)) continue;
    if (board.squares[sq(r + lr, c + lc)] !== Piece.None) continue; // 蹩马腿
    pushMove(board, from, sq(nr, nc), opp, moves);
  }
}

// --- 车（直线滑行）---
function genRook(board: Board, from: number, _side: Color, opp: Color, moves: Move[]): void {
  const r = rowOf(from), c = colOf(from);
  for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
    let nr = r + dr, nc = c + dc;
    while (onBoard(nr, nc)) {
      const target = board.squares[sq(nr, nc)]!;
      if (target === Piece.None) {
        moves.push({ from, to: sq(nr, nc), captured: Piece.None });
      } else {
        if (colorOf(target) === opp) moves.push({ from, to: sq(nr, nc), captured: target });
        break; // 碰子停止（无论吃不吃）
      }
      nr += dr; nc += dc;
    }
  }
}

// --- 炮（平移同车，吃子隔一子）---
function genCannon(board: Board, from: number, _side: Color, opp: Color, moves: Move[]): void {
  const r = rowOf(from), c = colOf(from);
  for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
    let nr = r + dr, nc = c + dc;
    // 阶段一：空格平移
    while (onBoard(nr, nc) && board.squares[sq(nr, nc)] === Piece.None) {
      moves.push({ from, to: sq(nr, nc), captured: Piece.None });
      nr += dr; nc += dc;
    }
    // 越过炮架
    nr += dr; nc += dc;
    // 阶段二：炮架之后第一个敌子可吃
    while (onBoard(nr, nc)) {
      const target = board.squares[sq(nr, nc)]!;
      if (target !== Piece.None) {
        if (colorOf(target) === opp) moves.push({ from, to: sq(nr, nc), captured: target });
        break;
      }
      nr += dr; nc += dc;
    }
  }
}

// --- 兵/卒 ---
function genPawn(board: Board, from: number, side: Color, opp: Color, moves: Move[]): void {
  const r = rowOf(from), c = colOf(from);
  const forward = side === Color.Red ? -1 : 1; // 红向上（row 减），黑向下
  // 前 further 一步
  const nr = r + forward;
  if (onBoard(nr, c)) pushMove(board, from, sq(nr, c), opp, moves);
  // 过河后可左右平移
  if (pawnCrossed(r, side)) {
    if (c - 1 >= 0) pushMove(board, from, sq(r, c - 1), opp, moves);
    if (c + 1 < BOARD_COLS) pushMove(board, from, sq(r, c + 1), opp, moves);
  }
}
