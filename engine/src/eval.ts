/**
 * 局面评估函数 v1 — 子力价值 + 位置价值表（PST）
 *
 * 约定：返回值为红方视角（正 = 红优）。搜索层用 negamax，调用侧乘以 ±1。
 *
 * PST 说明：
 * - 表按"红方视角"书写，row 0 = 黑方底线（红方深入敌阵的方向）
 * - 黑方取值时行镜像（row → 9-row），列不镜像（表本身左右对称）
 * - 数值为启发式参数，来源为公开的经典设计（XQWLight 风格），可调
 */
import { Piece, PieceType } from './types.js';
import type { Board } from './board.js';

/** 将杀分（与子力和同量纲，帅 = 10000） */
export const MATE_SCORE = 10000;

/** 子力价值（经典量纲：车900 马400 炮450 士象120 兵50） */
export const PIECE_VALUES: ReadonlyArray<number> = [
  10000, // King
  120,   // Advisor
  120,   // Elephant
  400,   // Horse
  900,   // Rook
  450,   // Cannon
  50,    // Pawn
];

/** 兵：过河后价值陡增，逼近九宫最高 */
const PST_PAWN = [
   9,  9,  9, 11, 13, 11,  9,  9,  9,
  19, 24, 34, 40, 40, 40, 34, 24, 19,
   7, 12, 16, 18, 18, 18, 16, 12,  7,
   7, 10, 13, 15, 15, 15, 13, 10,  7,
   5,  5,  5,  5,  5,  5,  5,  5,  5,
   0,  0,  0,  0,  0,  0,  0,  0,  0,
   0,  0,  0,  0,  0,  0,  0,  0,  0,
   0,  0,  0,  0,  0,  0,  0,  0,  0,
   0,  0,  0,  0,  0,  0,  0,  0,  0,
   0,  0,  0,  0,  0,  0,  0,  0,  0,
];

/** 车：抢肋道（3/5列）、巡河、沉底；角落略亏 */
const PST_ROOK = [
  14, 14, 12, 18, 16, 18, 12, 14, 14,
  16, 20, 18, 24, 26, 24, 18, 20, 16,
  12, 12, 12, 18, 18, 18, 12, 12, 12,
  12, 18, 16, 22, 22, 22, 16, 18, 12,
  12, 14, 12, 18, 18, 18, 12, 14, 12,
  12, 16, 14, 20, 20, 20, 14, 16, 12,
   6, 10,  8, 14, 14, 14,  8, 10,  6,
   4,  8,  6, 14, 12, 14,  6,  8,  4,
   8,  4,  8, 16,  8, 16,  8,  4,  8,
  -2, 10,  6, 14, 12, 14,  6, 10, -2,
];

/** 马：卧槽/屏风位价值高；起始角位略亏（鼓励出子） */
const PST_HORSE = [
   4,  8, 16, 12,  4, 12, 16,  8,  4,
   4, 10, 28, 16,  8, 16, 28, 10,  4,
  12, 14, 16, 20, 18, 20, 16, 14, 12,
   8, 24, 18, 24, 20, 24, 18, 24,  8,
   6, 16, 14, 18, 16, 18, 14, 16,  6,
   4, 12, 16, 14, 12, 14, 16, 12,  4,
   2,  6,  8,  6, 10,  6,  8,  6,  2,
   4,  2,  6,  4,  4,  4,  6,  2,  4,
   0,  2,  4,  4,  4,  4,  4,  2,  0,
   0, -4,  0,  0,  0,  0,  0, -4,  0,
];

/** 炮：敌方正面中路为负（轻发亏损）；己方中路正面（中炮架）为正 */
const PST_CANNON = [
   6,  4,  0, -10, -12, -10,  0,  4,  6,
   2,  2,  0,  -4, -14,  -4,  0,  2,  2,
   2,  2,  0, -10,  -8, -10,  0,  2,  2,
   0,  0, -2,   4,  10,   4, -2,  0,  0,
   0,  0,  0,   2,   4,   2,  0,  0,  0,
   0,  0, -2,   0,   4,   0, -2,  0,  0,
   0,  0,  0,   0,   2,   0,  0,  0,  0,
   0,  0,  0,   2,   6,   2,  0,  0,  0,
   0,  0,  0,   2,   6,   2,  0,  0,  0,
   0,  0,  0,   2,   6,   2,  0,  0,  0,
];

/** 士/象/帅：v1 全零（防守价值暂由子力体现，进阶版可加） */
const PST_ZERO = new Array<number>(90).fill(0);

/** PST[type][square]，square 为红方视角（row 0 = 敌方底线） */
const PST: ReadonlyArray<ReadonlyArray<number>> = [
  PST_ZERO,       // King
  PST_ZERO,       // Advisor
  PST_ZERO,       // Elephant
  PST_HORSE,
  PST_ROOK,
  PST_CANNON,
  PST_PAWN,
];

/**
 * 静态评估：红方视角。
 * 每子贡献 = 子力价值 + PST 位置分（黑方行镜像取表）。
 */
export function evaluate(board: Board): number {
  let score = 0;
  const squares = board.squares;
  for (let i = 0; i < 90; i++) {
    const p = squares[i]!;
    if (p === 255) continue; // Piece.None
    const type = p & 7;
    const r = (i / 9) | 0;
    const c = i % 9;
    if ((p >> 3) & 1) {
      // 黑方：行镜像（9-r），列不变
      score -= PIECE_VALUES[type]! + PST[type]![(9 - r) * 9 + c]!;
    } else {
      score += PIECE_VALUES[type]! + PST[type]![i]!;
    }
  }
  return score;
}

/** MVV-LVA 排序用：走子的排序分（吃子优先，大子吃小子优先；非吃子为 0） */
export function mvvlva(victim: Piece, attacker: Piece): number {
  if (victim === 255) return 0; // 非吃子
  const v = PIECE_VALUES[victim & 7]!;
  const a = PIECE_VALUES[attacker & 7]!;
  return v * 10 - a;
}
