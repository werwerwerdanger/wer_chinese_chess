/**
 * 类型定义 — 中国象棋引擎
 *
 * 棋盘采用 9x10 一维数组（90 格）表示：
 *   index = row * 9 + col，row 0-9、col 0-8
 *   row 0-4 为黑方半场（上方），row 5-9 为红方半场（下方）
 *   红方在下，黑方在上，红先。
 */

/** 棋子颜色 */
export enum Color {
  Red = 0,
  Black = 1,
}

/** 棋子种类（编码与棋谱字符对应） */
export enum PieceType {
  King = 0,    // 帅/将
  Advisor = 1, // 仕/士
  Elephant = 2,// 相/象
  Horse = 3,   // 傌/马
  Rook = 4,    // 俥/车
  Cannon = 5,  // 炮
  Pawn = 6,    // 兵/卒
}

/**
 * 完整棋子 = 颜色位 | 种类（bit 3 存颜色）
 * 注意：None=255 专门避开 RedKing=0 的编码冲突（空格与红帅不能同值）
 */
export enum Piece {
  None = 255,
  RedKing = 0,
  RedAdvisor = 1,
  RedElephant = 2,
  RedHorse = 3,
  RedRook = 4,
  RedCannon = 5,
  RedPawn = 6,
  BlackKing = 8,
  BlackAdvisor = 9,
  BlackElephant = 10,
  BlackHorse = 11,
  BlackRook = 12,
  BlackCannon = 13,
  BlackPawn = 14,
}

/** 走子：from/to 各 7 bit（0-89），captured 4 bit（被吃子，用于 unmake 快速恢复） */
export interface Move {
  from: number;
  to: number;
  captured: Piece; // Piece.None 表示没吃子
}

/** 撤销走子所需的信息 */
export interface UndoInfo {
  captured: Piece;
  hashKey: bigint; // 走子前的 Zobrist 键
}

/** 走子生成标志：是否过滤掉送将走子 */
export enum MoveGenFlags {
  PseudoLegal = 0, // 伪合法（不管走完是否被将军）
  Legal = 1,       // 合法（走完自己不被将军、将帅不照面）
}

/** 64 位 Zobrist 哈希键 */
export type HashKey = bigint;

/** 引擎搜索结果 */
export interface SearchResult {
  bestMove: Move | null;
  score: number;
  depth: number;
  nodes: number;
  timeMs: number;
}
