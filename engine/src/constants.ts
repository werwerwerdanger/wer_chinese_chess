/**
 * 常量与查表 — 中国象棋引擎
 */
import { Color, Piece, PieceType } from './types.js';

/** 棋盘尺寸 */
export const BOARD_COLS = 9;
export const BOARD_ROWS = 10;
export const BOARD_SIZE = BOARD_COLS * BOARD_ROWS; // 90

/** row * 9 + col，带边界检查 */
export function sq(row: number, col: number): number {
  return row * BOARD_COLS + col;
}

export function rowOf(s: number): number {
  return (s / BOARD_COLS) | 0;
}

export function colOf(s: number): number {
  return s % BOARD_COLS;
}

/** 是否在棋盘内 */
export function onBoard(row: number, col: number): boolean {
  return row >= 0 && row < BOARD_ROWS && col >= 0 && col < BOARD_COLS;
}

/** 九宫格范围：col 3-5；红 row 7-9，黑 row 0-2（含行边界检查，防止负数行越界） */
export function inPalace(row: number, col: number, color: Color): boolean {
  if (col < 3 || col > 5) return false;
  if (row < 0 || row > 9) return false;
  return color === Color.Red ? row >= 7 : row <= 2;
}

/** 象的活动范围：不过河。红 row 5-9，黑 row 0-4 */
export function elephantZone(row: number, color: Color): boolean {
  return color === Color.Red ? row >= 5 : row <= 4;
}

/** 兵是否已过河：红兵过河后 row <= 4，黑卒过河后 row >= 5 */
export function pawnCrossed(row: number, color: Color): boolean {
  return color === Color.Red ? row <= 4 : row >= 5;
}

// ---------------------------------------------------------------------------
// 初始局面（标准 FEN，红在下）
// FEN 行从黑方底线（row 0）写到红方底线（row 9）
// ---------------------------------------------------------------------------
export const INITIAL_FEN =
  'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w';

/** Piece -> 单字母 FEN（红大写，黑小写） */
export const PIECE_TO_FEN_CHAR: Record<number, string> = {
  [Piece.RedKing]: 'K', [Piece.RedAdvisor]: 'A', [Piece.RedElephant]: 'B',
  [Piece.RedHorse]: 'N', [Piece.RedRook]: 'R', [Piece.RedCannon]: 'C', [Piece.RedPawn]: 'P',
  [Piece.BlackKing]: 'k', [Piece.BlackAdvisor]: 'a', [Piece.BlackElephant]: 'b',
  [Piece.BlackHorse]: 'n', [Piece.BlackRook]: 'r', [Piece.BlackCannon]: 'c', [Piece.BlackPawn]: 'p',
};

const FEN_CHAR_TO_PIECE: Record<string, Piece> = {
  K: Piece.RedKing, A: Piece.RedAdvisor, B: Piece.RedElephant,
  N: Piece.RedHorse, R: Piece.RedRook, C: Piece.RedCannon, P: Piece.RedPawn,
  k: Piece.BlackKing, a: Piece.BlackAdvisor, b: Piece.BlackElephant,
  n: Piece.BlackHorse, r: Piece.BlackRook, c: Piece.BlackCannon, p: Piece.BlackPawn,
};

export function pieceFromFenChar(ch: string): Piece {
  return FEN_CHAR_TO_PIECE[ch] ?? Piece.None;
}

/** 取棋子颜色（bit 3 = 黑方标志；None=255 的 bit3=1 属未定义行为，调用方须先判 None） */
export function colorOf(p: Piece): Color {
  return (p >> 3) & 1;
}

/** 取棋子种类 */
export function typeOf(p: Piece): PieceType {
  return (p & 7) as PieceType;
}

// ---------------------------------------------------------------------------
// 方向偏移表（row*9+col 坐标系中，移动一格的 index 偏移）
// ---------------------------------------------------------------------------
export const OFFSET_UP = -9;    // row - 1
export const OFFSET_DOWN = 9;   // row + 1
export const OFFSET_LEFT = -1;  // col - 1
export const OFFSET_RIGHT = 1;  // col + 1

/** 马的 8 个落点及对应蹩腿位：(落点偏移, 蹩腿偏移) */
export const HORSE_MOVES: ReadonlyArray<readonly [number, number]> = [
  [-19, -9], [-17, -9],  // 上方两个落点，腿在正上
  [-11, -1], [7, -1],    // 左侧两个落点，腿在正左（注意跨行时的实际列差）
  [11, 1], [-7, 1],      // 右侧两个落点，腿在正右
  [17, 9], [19, 9],      // 下方两个落点，腿在正下
];

/** 象的 4 个落点及象眼：(落点偏移, 象眼偏移) */
export const ELEPHANT_MOVES: ReadonlyArray<readonly [number, number]> = [
  [-20, -10], [-16, -8], [-12, -6], [-8, -4],
  [8, 4], [12, 6], [16, 8], [20, 10],
];

// ---------------------------------------------------------------------------
// Zobrist 表 — 预生成 90 格 × 15 种棋子的随机 64 位数
// 用固定种子 xorshift，保证跨运行一致（可复现测试）
// ---------------------------------------------------------------------------
function makeRng(seed: bigint): () => bigint {
  let s = seed;
  return () => {
    s ^= s << 13n; s &= 0xffff_ffff_ffff_ffffn;
    s ^= s >> 7n;
    s ^= s << 17n; s &= 0xffff_ffff_ffff_ffffn;
    return s;
  };
}

const rng = makeRng(0x9e3779b97f4a7c15n);

/** zobrist[side][square]，side 0=红走，1=黑走 */
export const ZOBRIST_TURN: readonly bigint[] = [rng(), rng()];

/** zobristPiece[piece][square]（piece 取值 0-14，None 与全部不占格） */
export const ZOBRIST_PIECE: ReadonlyArray<ReadonlyArray<bigint>> = Array.from(
  { length: 15 },
  () => Array.from({ length: BOARD_SIZE }, () => rng()),
);

/** 棋子名称（中文，用于 UI 与日志） */
export const PIECE_NAMES: Record<number, string> = {
  [Piece.RedKing]: '帅', [Piece.RedAdvisor]: '仕', [Piece.RedElephant]: '相',
  [Piece.RedHorse]: '傌', [Piece.RedRook]: '俥', [Piece.RedCannon]: '炮', [Piece.RedPawn]: '兵',
  [Piece.BlackKing]: '将', [Piece.BlackAdvisor]: '士', [Piece.BlackElephant]: '象',
  [Piece.BlackHorse]: '马', [Piece.BlackRook]: '车', [Piece.BlackCannon]: '炮', [Piece.BlackPawn]: '卒',
};

/** 红黑两色的帅/将（快速定位用） */
export const KING_OF: ReadonlyArray<Piece> = [Piece.RedKing, Piece.BlackKing];
