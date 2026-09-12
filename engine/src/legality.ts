/**
 * 合法性判定 — 将军检测 / 送将过滤 / 将帅照面
 *
 * inCheck 的实现思路：不做全盘攻击图（慢），而是从己方将位出发，
 * 沿各类攻击线反向探测（"将位是否被攻击"）：
 * - 同列直线：敌车 / 敌将（照面） / 隔一子的敌炮
 * - 同行直线：同上
 * - 马位：8 个可能跳点且反向蹩腿位为空
 * - 兵位：正面与侧面（取决于兵是否过河）
 * 士象无法攻击到将，无需探测。
 */
import { Color, Piece, PieceType, type Move } from './types.js';
import { colorOf, colOf, onBoard, rowOf, sq, typeOf, pawnCrossed } from './constants.js';
import type { Board } from './board.js';
import { generatePseudoLegalMoves } from './movegen.js';

/** side 方的将是否被将军（side = 被检测方） */
export function inCheck(board: Board, side: Color): boolean {
  const kingSq = board.kingSquare[side]!;
  if (kingSq < 0) return true; // 将没了视为被将死（防御式）
  const kr = rowOf(kingSq), kc = colOf(kingSq);
  const opp = (side ^ 1) as Color;

  // --- 1. 直线：车 / 炮 / 将帅照面（横竖四个方向）---
  for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
    let r = kr + dr, c = kc + dc;
    let firstPiece: Piece = Piece.None;
    let firstR = -1, firstC = -1;
    // 找第一个子
    while (onBoard(r, c)) {
      const p = board.squares[sq(r, c)]!;
      if (p !== Piece.None) { firstPiece = p; firstR = r; firstC = c; break; }
      r += dr; c += dc;
    }
    if (firstPiece === Piece.None) continue;
    const t = typeOf(firstPiece);
    if (colorOf(firstPiece) === opp) {
      if (t === PieceType.Rook) return true;                       // 敌车贴线
      if (t === PieceType.King) return true;                       // 将帅照面（等效被"攻击"）
      if (t === PieceType.Pawn) {
        // 敌兵正攻击将：兵的攻击方向是它自己的"前进"方向
        // 红兵向下攻击（row+1 是它的前），黑卒向上（row-1 是它的前）
        // 敌兵在 (r,c) 攻击到将 ⇔ 将在兵的前方一格或（兵已过河）侧面
        const pawnForward = colorOf(firstPiece) === Color.Red ? 1 : -1;
        if (firstR + pawnForward === kr && firstC === kc) return true;
        if (pawnCrossed(firstR, colorOf(firstPiece)) && firstR === kr && Math.abs(firstC - kc) === 1) return true;
      }
    }
    // 继续找第二个子：炮架后第一个子
    r = firstR + dr; c = firstC + dc;
    while (onBoard(r, c)) {
      const p = board.squares[sq(r, c)]!;
      if (p !== Piece.None) {
        if (colorOf(p) === opp && typeOf(p) === PieceType.Cannon) return true; // 隔山打将
        break;
      }
      r += dr; c += dc;
    }
  }

  // --- 2. 马：8 个跳点，注意反向蹩腿 ---
  // 马从 (mr,mc) 跳到将 (kr,kc)：蹩腿位是马旁边、与将相邻方向的格子
  const horseDeltas: ReadonlyArray<readonly [number, number, number, number]> = [
    // [mr-kr, mc-kc, legDr, legDc] leg 相对将位
    [-2, -1, -1, 0], [-2, 1, -1, 0],
    [2, -1, 1, 0], [2, 1, 1, 0],
    [-1, -2, 0, -1], [1, -2, 0, -1],
    [-1, 2, 0, 1], [1, 2, 0, 1],
  ];
  for (const [dr, dc, lr, lc] of horseDeltas) {
    const mr = kr + dr, mc = kc + dc;
    if (!onBoard(mr, mc)) continue;
    const p = board.squares[sq(mr, mc)]!;
    if (p === Piece.None || colorOf(p) !== opp) continue;
    if (typeOf(p) !== PieceType.Horse) continue;
    // 马跳向将时的腿位在马旁边（相对将位偏移 (lr, lc)）
    const legR = kr + lr, legC = kc + lc;
    if (board.squares[sq(legR, legC)] === Piece.None) return true; // 未蹩腿 = 被马将军
  }

  return false;
}

/**
 * 生成 side 方的全部合法走子 = 伪合法走子中过滤掉"走完后己方被将军或将帅照面"的。
 * 实现：make → inCheck → unmake。
 */
export function generateLegalMoves(board: Board, side: Color): Move[] {
  const pseudo = generatePseudoLegalMoves(board, side);
  const legal: Move[] = [];
  for (const m of pseudo) {
    const undo = board.makeMove(m);
    // 走完轮到对方；己方不被将军且将帅不照面才合法
    if (!inCheck(board, side) && !board.kingsFacing()) legal.push(m);
    board.unmakeMove(m, undo);
  }
  return legal;
}

/** 判断 side 方是否被将死（无合法走子且被将军） */
export function isCheckmate(board: Board, side: Color): boolean {
  if (!inCheck(board, side)) return false;
  return generateLegalMoves(board, side).length === 0;
}

/** 判断 side 方是否困毙（无合法走子但未被将军） */
export function isStalemate(board: Board, side: Color): boolean {
  if (inCheck(board, side)) return false;
  return generateLegalMoves(board, side).length === 0;
}
