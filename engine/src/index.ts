/**
 * 引擎统一入口 — 供 web 前端（及未来的服务器、WASM 端）引用
 */
export { Board } from './board.js';
export { generatePseudoLegalMoves } from './movegen.js';
export { generateLegalMoves, inCheck, isCheckmate, isStalemate } from './legality.js';
export {
  BOARD_COLS, BOARD_ROWS, BOARD_SIZE, INITIAL_FEN, PIECE_NAMES, PIECE_TO_FEN_CHAR,
  sq, rowOf, colOf, inPalace, colorOf, typeOf,
} from './constants.js';
export { Color, Piece, PieceType } from './types.js';
export type { Move, UndoInfo, HashKey, SearchResult } from './types.js';
export { moveToChinese } from './notation.js';
