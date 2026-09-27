// tools/distill/smoke-nnue.ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// engine/src/constants.ts
var BOARD_COLS = 9;
var BOARD_ROWS = 10;
var BOARD_SIZE = BOARD_COLS * BOARD_ROWS;
function sq(row, col) {
  return row * BOARD_COLS + col;
}
function rowOf(s2) {
  return s2 / BOARD_COLS | 0;
}
function colOf(s2) {
  return s2 % BOARD_COLS;
}
function onBoard(row, col) {
  return row >= 0 && row < BOARD_ROWS && col >= 0 && col < BOARD_COLS;
}
function inPalace(row, col, color) {
  if (col < 3 || col > 5) return false;
  if (row < 0 || row > 9) return false;
  return color === 0 /* Red */ ? row >= 7 : row <= 2;
}
function elephantZone(row, color) {
  return color === 0 /* Red */ ? row >= 5 : row <= 4;
}
function pawnCrossed(row, color) {
  return color === 0 /* Red */ ? row <= 4 : row >= 5;
}
var INITIAL_FEN = "rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w";
var PIECE_TO_FEN_CHAR = {
  [0 /* RedKing */]: "K",
  [1 /* RedAdvisor */]: "A",
  [2 /* RedElephant */]: "B",
  [3 /* RedHorse */]: "N",
  [4 /* RedRook */]: "R",
  [5 /* RedCannon */]: "C",
  [6 /* RedPawn */]: "P",
  [8 /* BlackKing */]: "k",
  [9 /* BlackAdvisor */]: "a",
  [10 /* BlackElephant */]: "b",
  [11 /* BlackHorse */]: "n",
  [12 /* BlackRook */]: "r",
  [13 /* BlackCannon */]: "c",
  [14 /* BlackPawn */]: "p"
};
var FEN_CHAR_TO_PIECE = {
  K: 0 /* RedKing */,
  A: 1 /* RedAdvisor */,
  B: 2 /* RedElephant */,
  N: 3 /* RedHorse */,
  R: 4 /* RedRook */,
  C: 5 /* RedCannon */,
  P: 6 /* RedPawn */,
  k: 8 /* BlackKing */,
  a: 9 /* BlackAdvisor */,
  b: 10 /* BlackElephant */,
  n: 11 /* BlackHorse */,
  r: 12 /* BlackRook */,
  c: 13 /* BlackCannon */,
  p: 14 /* BlackPawn */
};
function pieceFromFenChar(ch) {
  return FEN_CHAR_TO_PIECE[ch] ?? 255 /* None */;
}
function colorOf(p) {
  return p >> 3 & 1;
}
function typeOf(p) {
  return p & 7;
}
function makeRng(seed) {
  let s2 = seed;
  return () => {
    s2 ^= s2 << 13n;
    s2 &= 0xffffffffffffffffn;
    s2 ^= s2 >> 7n;
    s2 ^= s2 << 17n;
    s2 &= 0xffffffffffffffffn;
    return s2;
  };
}
var rng = makeRng(0x9e3779b97f4a7c15n);
var ZOBRIST_TURN = [rng(), rng()];
var ZOBRIST_PIECE = Array.from(
  { length: 15 },
  () => Array.from({ length: BOARD_SIZE }, () => rng())
);
var PIECE_NAMES = {
  [0 /* RedKing */]: "\u5E05",
  [1 /* RedAdvisor */]: "\u4ED5",
  [2 /* RedElephant */]: "\u76F8",
  [3 /* RedHorse */]: "\u9A6C",
  [4 /* RedRook */]: "\u8F66",
  [5 /* RedCannon */]: "\u70AE",
  [6 /* RedPawn */]: "\u5175",
  [8 /* BlackKing */]: "\u5C06",
  [9 /* BlackAdvisor */]: "\u58EB",
  [10 /* BlackElephant */]: "\u8C61",
  [11 /* BlackHorse */]: "\u9A6C",
  [12 /* BlackRook */]: "\u8F66",
  [13 /* BlackCannon */]: "\u70AE",
  [14 /* BlackPawn */]: "\u5352"
};
var KING_OF = [0 /* RedKing */, 8 /* BlackKing */];

// engine/src/board.ts
var Board = class _Board {
  /** 90 格棋盘，值为 Piece 枚举 */
  squares = new Uint8Array(BOARD_SIZE);
  /** 当前行棋方 */
  turn = 0 /* Red */;
  /** 双方将帅位置 */
  kingSquare = new Int8Array(2).fill(-1);
  /** 当前局面 Zobrist 键 */
  hashKey = 0n;
  constructor(fen = INITIAL_FEN) {
    this.loadFen(fen);
  }
  /** 从 FEN 载入局面 */
  loadFen(fen) {
    this.squares.fill(255 /* None */);
    this.kingSquare.fill(-1);
    this.hashKey = 0n;
    const [placement, side] = fen.trim().split(/\s+/);
    if (!placement) throw new Error(`bad FEN: ${fen}`);
    const rows = placement.split("/");
    if (rows.length !== BOARD_ROWS) throw new Error(`FEN \u9700\u8981 10 \u884C\uFF0C\u5F97\u5230 ${rows.length}`);
    for (let r2 = 0; r2 < BOARD_ROWS; r2++) {
      let c = 0;
      for (const ch of rows[r2]) {
        if (c >= BOARD_COLS) throw new Error(`\u7B2C ${r2} \u884C\u8D85\u5BBD: ${rows[r2]}`);
        if (ch >= "1" && ch <= "9") {
          c += ch.charCodeAt(0) - 48;
        } else {
          const p = pieceFromFenChar(ch);
          if (p === 255 /* None */) throw new Error(`\u975E\u6CD5\u5B57\u7B26 '${ch}' in FEN`);
          this.setPiece(sq(r2, c), p);
          c++;
        }
      }
      if (c !== BOARD_COLS) throw new Error(`\u7B2C ${r2} \u884C\u5BBD\u5EA6 ${c} \u2260 9`);
    }
    this.turn = side === "b" ? 1 /* Black */ : 0 /* Red */;
    this.hashKey ^= ZOBRIST_TURN[this.turn];
    if (this.kingSquare[0] < 0 || this.kingSquare[1] < 0) {
      throw new Error("FEN \u7F3A\u5C11\u5C06/\u5E05");
    }
  }
  /** 生成 FEN（round-trip 测试用） */
  toFen() {
    const rows = [];
    for (let r2 = 0; r2 < BOARD_ROWS; r2++) {
      let row = "";
      let empty = 0;
      for (let c = 0; c < BOARD_COLS; c++) {
        const p = this.squares[sq(r2, c)];
        if (p === 255 /* None */) {
          empty++;
        } else {
          if (empty > 0) {
            row += String(empty);
            empty = 0;
          }
          row += PIECE_TO_FEN_CHAR[p];
        }
      }
      if (empty > 0) row += String(empty);
      rows.push(row);
    }
    return `${rows.join("/")} ${this.turn === 0 /* Red */ ? "w" : "b"}`;
  }
  /** 放子（内部用，更新哈希与将位） */
  setPiece(square, p) {
    this.squares[square] = p;
    this.hashKey ^= ZOBRIST_PIECE[p][square];
    if (p === 0 /* RedKing */) this.kingSquare[0 /* Red */] = square;
    else if (p === 8 /* BlackKing */) this.kingSquare[1 /* Black */] = square;
  }
  at(square) {
    return this.squares[square];
  }
  /** 执行走子，返回撤销信息。调用方需保证 move 合法（由 movegen 产出）。 */
  makeMove(move) {
    const undo = {
      captured: this.at(move.to),
      hashKey: this.hashKey
    };
    const moving = this.at(move.from);
    if (undo.captured !== 255 /* None */) {
      this.hashKey ^= ZOBRIST_PIECE[undo.captured][move.to];
      if (undo.captured === 0 /* RedKing */) this.kingSquare[0 /* Red */] = -1;
      if (undo.captured === 8 /* BlackKing */) this.kingSquare[1 /* Black */] = -1;
    }
    this.hashKey ^= ZOBRIST_PIECE[moving][move.from];
    this.squares[move.from] = 255 /* None */;
    this.squares[move.to] = moving;
    this.hashKey ^= ZOBRIST_PIECE[moving][move.to];
    if (moving === 0 /* RedKing */) this.kingSquare[0 /* Red */] = move.to;
    if (moving === 8 /* BlackKing */) this.kingSquare[1 /* Black */] = move.to;
    this.turn ^= 1;
    this.hashKey ^= ZOBRIST_TURN[0] ^ ZOBRIST_TURN[1];
    return undo;
  }
  /** 撤销走子 */
  unmakeMove(move, undo) {
    const moved = this.at(move.to);
    this.squares[move.from] = moved;
    this.squares[move.to] = undo.captured;
    if (moved === 0 /* RedKing */) this.kingSquare[0 /* Red */] = move.from;
    if (moved === 8 /* BlackKing */) this.kingSquare[1 /* Black */] = move.from;
    if (undo.captured === 0 /* RedKing */) this.kingSquare[0 /* Red */] = move.to;
    if (undo.captured === 8 /* BlackKing */) this.kingSquare[1 /* Black */] = move.to;
    this.turn ^= 1;
    this.hashKey = undo.hashKey;
  }
  /** 克隆局面 */
  clone() {
    const b2 = Object.create(_Board.prototype);
    b2.squares.set(this.squares);
    b2.turn = this.turn;
    b2.kingSquare.set(this.kingSquare);
    b2.hashKey = this.hashKey;
    return b2;
  }
  /** 将帅是否照面（同一列且中间无子）— 用于合法性判定 */
  kingsFacing() {
    const rk = this.kingSquare[0 /* Red */];
    const bk = this.kingSquare[1 /* Black */];
    if (rk < 0 || bk < 0) return false;
    const rc = colOf(rk), bc = colOf(bk);
    if (rc !== bc) return false;
    const rr = rowOf(rk), br = rowOf(bk);
    for (let r2 = br + 1; r2 < rr; r2++) {
      if (this.squares[sq(r2, rc)] !== 255 /* None */) return false;
    }
    return true;
  }
  /** 简易局面文本渲染（终端调试用） */
  ascii() {
    const files = "  0 1 2 3 4 5 6 7 8";
    const sep = "  +------------------------+";
    const lines = [files, sep];
    for (let r2 = 0; r2 < BOARD_ROWS; r2++) {
      let row = `${r2} |`;
      for (let c = 0; c < BOARD_COLS; c++) {
        const p = this.squares[sq(r2, c)];
        const ch = p === 255 /* None */ ? "." : PIECE_TO_FEN_CHAR[p] ?? "?";
        row += ch === "." ? " ." : ch === ch.toUpperCase() ? ` ${ch}` : ` ${ch}`;
      }
      row += " |";
      lines.push(row);
    }
    lines.push(sep);
    lines.push(`  turn: ${this.turn === 0 /* Red */ ? "Red" : "Black"}`);
    return lines.join("\n");
  }
  /** 校验局面内部一致性（测试用） */
  validateConsistency() {
    for (let s2 = 0; s2 < BOARD_SIZE; s2++) {
      const p = this.squares[s2];
      if (p !== 255 /* None */ && (p & 7) === 0 && p !== 0 /* RedKing */ && p !== 8 /* BlackKing */) {
        throw new Error(`\u683C ${s2} \u975E\u6CD5\u68CB\u5B50\u7F16\u7801 ${p}`);
      }
    }
    let h = 0n;
    for (let s2 = 0; s2 < BOARD_SIZE; s2++) {
      const p = this.squares[s2];
      if (p !== 255 /* None */) h ^= ZOBRIST_PIECE[p][s2];
    }
    h ^= ZOBRIST_TURN[this.turn];
    if (h !== this.hashKey) throw new Error("Zobrist \u952E\u4E0E\u68CB\u76D8\u4E0D\u4E00\u81F4");
    for (let s2 = 0; s2 < BOARD_SIZE; s2++) {
      if (this.squares[s2] === 0 /* RedKing */ && this.kingSquare[0 /* Red */] !== s2)
        throw new Error("\u7EA2\u5E05\u4F4D\u7F6E\u7F13\u5B58\u5931\u6548");
      if (this.squares[s2] === 8 /* BlackKing */ && this.kingSquare[1 /* Black */] !== s2)
        throw new Error("\u9ED1\u5C06\u4F4D\u7F6E\u7F13\u5B58\u5931\u6548");
    }
    for (const c of [0 /* Red */, 1 /* Black */]) {
      const ks = this.kingSquare[c];
      if (ks >= 0 && !inPalace(rowOf(ks), colOf(ks), c)) throw new Error("\u5C06\u4E0D\u5728\u4E5D\u5BAB");
    }
  }
};

// engine/src/movegen.ts
function generatePseudoLegalMoves(board, side) {
  const moves = [];
  const opp = side ^ 1;
  for (let from = 0; from < 90; from++) {
    const p = board.squares[from];
    if (p === 255 /* None */ || colorOf(p) !== side) continue;
    switch (typeOf(p)) {
      case 0 /* King */:
        genKing(board, from, side, opp, moves);
        break;
      case 1 /* Advisor */:
        genAdvisor(board, from, side, opp, moves);
        break;
      case 2 /* Elephant */:
        genElephant(board, from, side, opp, moves);
        break;
      case 3 /* Horse */:
        genHorse(board, from, side, opp, moves);
        break;
      case 4 /* Rook */:
        genRook(board, from, side, opp, moves);
        break;
      case 5 /* Cannon */:
        genCannon(board, from, side, opp, moves);
        break;
      case 6 /* Pawn */:
        genPawn(board, from, side, opp, moves);
        break;
    }
  }
  return moves;
}
function pushMove(board, from, to, opp, moves) {
  const target = board.squares[to];
  if (target === 255 /* None */ || colorOf(target) === opp) {
    moves.push({ from, to, captured: target });
  }
}
function genKing(board, from, side, opp, moves) {
  const r2 = rowOf(from), c = colOf(from);
  const deltas = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  for (const [dr, dc] of deltas) {
    const nr = r2 + dr, nc = c + dc;
    if (!inPalace(nr, nc, side)) continue;
    pushMove(board, from, sq(nr, nc), opp, moves);
  }
}
function genAdvisor(board, from, side, opp, moves) {
  const r2 = rowOf(from), c = colOf(from);
  const deltas = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
  for (const [dr, dc] of deltas) {
    const nr = r2 + dr, nc = c + dc;
    if (!inPalace(nr, nc, side)) continue;
    pushMove(board, from, sq(nr, nc), opp, moves);
  }
}
function genElephant(board, from, side, opp, moves) {
  const r2 = rowOf(from), c = colOf(from);
  const deltas = [[-2, -2], [-2, 2], [2, -2], [2, 2]];
  for (const [dr, dc] of deltas) {
    const nr = r2 + dr, nc = c + dc;
    if (!onBoard(nr, nc)) continue;
    if (!elephantZone(nr, side)) continue;
    if (board.squares[sq(r2 + dr / 2, c + dc / 2)] !== 255 /* None */) continue;
    pushMove(board, from, sq(nr, nc), opp, moves);
  }
}
function genHorse(board, from, _side, opp, moves) {
  const r2 = rowOf(from), c = colOf(from);
  const table = [
    [-2, -1, -1, 0],
    [-2, 1, -1, 0],
    [2, -1, 1, 0],
    [2, 1, 1, 0],
    [-1, -2, 0, -1],
    [1, -2, 0, -1],
    [-1, 2, 0, 1],
    [1, 2, 0, 1]
  ];
  for (const [dr, dc, lr, lc] of table) {
    const nr = r2 + dr, nc = c + dc;
    if (!onBoard(nr, nc)) continue;
    if (board.squares[sq(r2 + lr, c + lc)] !== 255 /* None */) continue;
    pushMove(board, from, sq(nr, nc), opp, moves);
  }
}
function genRook(board, from, _side, opp, moves) {
  const r2 = rowOf(from), c = colOf(from);
  for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
    let nr = r2 + dr, nc = c + dc;
    while (onBoard(nr, nc)) {
      const target = board.squares[sq(nr, nc)];
      if (target === 255 /* None */) {
        moves.push({ from, to: sq(nr, nc), captured: 255 /* None */ });
      } else {
        if (colorOf(target) === opp) moves.push({ from, to: sq(nr, nc), captured: target });
        break;
      }
      nr += dr;
      nc += dc;
    }
  }
}
function genCannon(board, from, _side, opp, moves) {
  const r2 = rowOf(from), c = colOf(from);
  for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
    let nr = r2 + dr, nc = c + dc;
    while (onBoard(nr, nc) && board.squares[sq(nr, nc)] === 255 /* None */) {
      moves.push({ from, to: sq(nr, nc), captured: 255 /* None */ });
      nr += dr;
      nc += dc;
    }
    nr += dr;
    nc += dc;
    while (onBoard(nr, nc)) {
      const target = board.squares[sq(nr, nc)];
      if (target !== 255 /* None */) {
        if (colorOf(target) === opp) moves.push({ from, to: sq(nr, nc), captured: target });
        break;
      }
      nr += dr;
      nc += dc;
    }
  }
}
function genPawn(board, from, side, opp, moves) {
  const r2 = rowOf(from), c = colOf(from);
  const forward = side === 0 /* Red */ ? -1 : 1;
  const nr = r2 + forward;
  if (onBoard(nr, c)) pushMove(board, from, sq(nr, c), opp, moves);
  if (pawnCrossed(r2, side)) {
    if (c - 1 >= 0) pushMove(board, from, sq(r2, c - 1), opp, moves);
    if (c + 1 < BOARD_COLS) pushMove(board, from, sq(r2, c + 1), opp, moves);
  }
}

// engine/src/legality.ts
function inCheck(board, side) {
  const kingSq = board.kingSquare[side];
  if (kingSq < 0) return true;
  const kr = rowOf(kingSq), kc = colOf(kingSq);
  const opp = side ^ 1;
  for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
    let r2 = kr + dr, c = kc + dc;
    let firstPiece = 255 /* None */;
    let firstR = -1, firstC = -1;
    while (onBoard(r2, c)) {
      const p = board.squares[sq(r2, c)];
      if (p !== 255 /* None */) {
        firstPiece = p;
        firstR = r2;
        firstC = c;
        break;
      }
      r2 += dr;
      c += dc;
    }
    if (firstPiece === 255 /* None */) continue;
    const t = typeOf(firstPiece);
    if (colorOf(firstPiece) === opp) {
      if (t === 4 /* Rook */) return true;
      if (t === 0 /* King */) return true;
      if (t === 6 /* Pawn */) {
        const pawnForward = colorOf(firstPiece) === 0 /* Red */ ? 1 : -1;
        if (firstR + pawnForward === kr && firstC === kc) return true;
        if (pawnCrossed(firstR, colorOf(firstPiece)) && firstR === kr && Math.abs(firstC - kc) === 1) return true;
      }
    }
    r2 = firstR + dr;
    c = firstC + dc;
    while (onBoard(r2, c)) {
      const p = board.squares[sq(r2, c)];
      if (p !== 255 /* None */) {
        if (colorOf(p) === opp && typeOf(p) === 5 /* Cannon */) return true;
        break;
      }
      r2 += dr;
      c += dc;
    }
  }
  const horseDeltas = [
    // [mr-kr, mc-kc, legDr, legDc] leg 相对将位
    // 腿在马旁边、沿长轴方向一格：竖直长跳(|dr|=2)时 leg=(dr/2, dc)，横向长跳(|dc|=2)时 leg=(dr, dc/2)
    [-2, -1, -1, -1],
    [-2, 1, -1, 1],
    [2, -1, 1, -1],
    [2, 1, 1, 1],
    [-1, -2, -1, -1],
    [1, -2, 1, -1],
    [-1, 2, -1, 1],
    [1, 2, 1, 1]
  ];
  for (const [dr, dc, lr, lc] of horseDeltas) {
    const mr = kr + dr, mc = kc + dc;
    if (!onBoard(mr, mc)) continue;
    const p = board.squares[sq(mr, mc)];
    if (p === 255 /* None */ || colorOf(p) !== opp) continue;
    if (typeOf(p) !== 3 /* Horse */) continue;
    const legR = kr + lr, legC = kc + lc;
    if (board.squares[sq(legR, legC)] === 255 /* None */) return true;
  }
  return false;
}

// engine-ai/src/eval.ts
var MATE_SCORE = 1e4;
var PIECE_VALUES = [
  1e4,
  // King
  120,
  // Advisor
  120,
  // Elephant
  400,
  // Horse
  900,
  // Rook
  450,
  // Cannon
  50
  // Pawn
];
var PST_PAWN = [
  9,
  9,
  9,
  11,
  13,
  11,
  9,
  9,
  9,
  19,
  24,
  34,
  40,
  40,
  40,
  34,
  24,
  19,
  7,
  12,
  16,
  18,
  18,
  18,
  16,
  12,
  7,
  7,
  10,
  13,
  15,
  15,
  15,
  13,
  10,
  7,
  5,
  5,
  5,
  5,
  5,
  5,
  5,
  5,
  5,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0
];
var PST_ROOK = [
  14,
  14,
  12,
  18,
  16,
  18,
  12,
  14,
  14,
  16,
  20,
  18,
  24,
  26,
  24,
  18,
  20,
  16,
  12,
  12,
  12,
  18,
  18,
  18,
  12,
  12,
  12,
  12,
  18,
  16,
  22,
  22,
  22,
  16,
  18,
  12,
  12,
  14,
  12,
  18,
  18,
  18,
  12,
  14,
  12,
  12,
  16,
  14,
  20,
  20,
  20,
  14,
  16,
  12,
  6,
  10,
  8,
  14,
  14,
  14,
  8,
  10,
  6,
  4,
  8,
  6,
  14,
  12,
  14,
  6,
  8,
  4,
  8,
  4,
  8,
  16,
  8,
  16,
  8,
  4,
  8,
  -2,
  10,
  6,
  14,
  12,
  14,
  6,
  10,
  -2
];
var PST_HORSE = [
  4,
  8,
  16,
  12,
  4,
  12,
  16,
  8,
  4,
  4,
  10,
  28,
  16,
  8,
  16,
  28,
  10,
  4,
  12,
  14,
  16,
  20,
  18,
  20,
  16,
  14,
  12,
  8,
  24,
  18,
  24,
  20,
  24,
  18,
  24,
  8,
  6,
  16,
  14,
  18,
  16,
  18,
  14,
  16,
  6,
  4,
  12,
  16,
  14,
  12,
  14,
  16,
  12,
  4,
  2,
  6,
  8,
  6,
  10,
  6,
  8,
  6,
  2,
  4,
  2,
  6,
  4,
  4,
  4,
  6,
  2,
  4,
  0,
  2,
  4,
  4,
  4,
  4,
  4,
  2,
  0,
  0,
  -4,
  0,
  0,
  0,
  0,
  0,
  -4,
  0
];
var PST_CANNON = [
  6,
  4,
  0,
  -10,
  -12,
  -10,
  0,
  4,
  6,
  2,
  2,
  0,
  -4,
  -14,
  -4,
  0,
  2,
  2,
  2,
  2,
  0,
  -10,
  -8,
  -10,
  0,
  2,
  2,
  0,
  0,
  -2,
  4,
  10,
  4,
  -2,
  0,
  0,
  0,
  0,
  0,
  2,
  4,
  2,
  0,
  0,
  0,
  0,
  0,
  -2,
  0,
  4,
  0,
  -2,
  0,
  0,
  0,
  0,
  0,
  0,
  2,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  2,
  6,
  2,
  0,
  0,
  0,
  0,
  0,
  0,
  2,
  6,
  2,
  0,
  0,
  0,
  0,
  0,
  0,
  2,
  6,
  2,
  0,
  0,
  0
];
var PST_ZERO = new Array(90).fill(0);
var PST = [
  PST_ZERO,
  // King
  PST_ZERO,
  // Advisor
  PST_ZERO,
  // Elephant
  PST_HORSE,
  PST_ROOK,
  PST_CANNON,
  PST_PAWN
];
function evaluate(board) {
  let score = 0;
  const squares = board.squares;
  for (let i = 0; i < 90; i++) {
    const p = squares[i];
    if (p === 255) continue;
    const type = p & 7;
    const r2 = i / 9 | 0;
    const c = i % 9;
    if (p >> 3 & 1) {
      score -= PIECE_VALUES[type] + PST[type][(9 - r2) * 9 + c];
    } else {
      score += PIECE_VALUES[type] + PST[type][i];
    }
  }
  return score;
}
function mvvlva(victim, attacker) {
  if (victim === 255) return 0;
  const v = PIECE_VALUES[victim & 7];
  const a = PIECE_VALUES[attacker & 7];
  return v * 10 - a;
}

// engine-ai/src/search.ts
var NO_MOVE = { from: -1, to: -1, captured: 255 };
var MAX_PLY = 64;
var Searcher = class {
  board;
  tt = /* @__PURE__ */ new Map();
  ttMax;
  nodes = 0;
  history = /* @__PURE__ */ new Map();
  // "from-to" → 排序分
  /** 搜索中检出（当前走子方被将死/困毙）时由 makeMove 感知 */
  searchAborted = false;
  /** 评估函数（默认子力+PST；可注入 NNUE 等），红方视角 cp */
  evalFn;
  constructor(board, ttMax = 1 << 18, evalFn) {
    this.board = board;
    this.ttMax = ttMax;
    this.evalFn = evalFn ?? evaluate;
  }
  /** 清空置换表（新对局/悔棋后调用，防止跨局面污染） */
  clear() {
    this.tt.clear();
    this.history.clear();
  }
  /**
   * 迭代加深搜索入口。
   * @param maxDepth 最大深度
   * @param timeLimitMs 时间上限（默认 3s，软限制，在节点间检查）
   */
  search(maxDepth, timeLimitMs = 3e3) {
    const start = Date.now();
    this.nodes = 0;
    this.searchAborted = false;
    let best = NO_MOVE;
    let bestScore = 0;
    let completedDepth = 0;
    for (let depth = 1; depth <= maxDepth; depth++) {
      const deadlineHit = () => Date.now() - start > timeLimitMs;
      const result = this.searchRoot(depth, deadlineHit);
      if (this.searchAborted) break;
      best = result.move;
      bestScore = result.score;
      completedDepth = depth;
      if (Math.abs(bestScore) >= MATE_SCORE - 100) break;
    }
    return {
      bestMove: best.from >= 0 ? best : null,
      score: bestScore,
      depth: completedDepth,
      nodes: this.nodes,
      timeMs: Date.now() - start
    };
  }
  searchRoot(depth, deadlineHit) {
    const side = this.board.turn;
    const sign = side === 0 ? 1 : -1;
    const moves = this.orderedRootMoves();
    let bestMove = moves[0] ?? NO_MOVE;
    let bestScore = -Infinity;
    for (const m of moves) {
      if (deadlineHit()) {
        this.searchAborted = true;
        return { move: bestMove, score: bestScore };
      }
      const undo = this.board.makeMove(m);
      let score;
      if (this.noMovesFor(this.board.turn)) {
        score = (MATE_SCORE - depth) * (side === 0 ? 1 : -1) * sign;
      } else {
        score = -this.alphabeta(depth - 1, -Infinity, Infinity, sign === 1 ? -1 : 1, deadlineHit, 1);
      }
      this.board.unmakeMove(m, undo);
      if (this.searchAborted) return { move: bestMove, score: bestScore };
      if (score > bestScore) {
        bestScore = score;
        bestMove = m;
      }
    }
    return { move: bestMove, score: bestScore };
  }
  /**
   * negamax alpha-beta 主体。sign = 当前方视角系数（红+1/黑-1）。
   */
  alphabeta(depth, alpha, beta, sign, deadlineHit, ply) {
    this.nodes++;
    if (ply >= MAX_PLY) {
      return sign * this.quiescence(alpha, beta, sign, 0, deadlineHit);
    }
    if (depth <= 0) {
      return sign * this.quiescence(alpha, beta, sign, 4, deadlineHit);
    }
    const key = this.board.hashKey;
    const ttEntry = this.tt.get(key);
    if (ttEntry && ttEntry.depth >= depth) {
      if (ttEntry.flag === 0 /* Exact */) return ttEntry.score;
      if (ttEntry.flag === 1 /* Lower */ && ttEntry.score >= beta) return ttEntry.score;
      if (ttEntry.flag === 2 /* Upper */ && ttEntry.score <= alpha) return ttEntry.score;
    }
    const checked = inCheck(this.board, this.board.turn);
    if (checked && depth < 3 && ply < MAX_PLY - 8) depth++;
    const moves = this.orderedMoves(ttEntry?.bestMove);
    let bestScore = -Infinity;
    let bestMove = NO_MOVE;
    let searched = 0;
    const alphaOrig = alpha;
    for (const m of moves) {
      if ((this.nodes & 1023) === 0 && deadlineHit()) {
        this.searchAborted = true;
        return alpha;
      }
      const undo = this.board.makeMove(m);
      let score;
      if (this.noMovesFor(this.board.turn)) {
        score = MATE_SCORE - depth;
      } else {
        score = -this.alphabeta(depth - 1, -beta, -alpha, -sign, deadlineHit, ply + 1);
      }
      this.board.unmakeMove(m, undo);
      searched++;
      if (this.searchAborted) return alpha;
      if (score > bestScore) {
        bestScore = score;
        bestMove = m;
        if (score > alpha) alpha = score;
        if (alpha >= beta) {
          const hk = `${m.from}-${m.to}`;
          this.history.set(hk, (this.history.get(hk) ?? 0) + depth * depth);
          break;
        }
      }
    }
    if (searched === 0) {
      return -MATE_SCORE + depth;
    }
    if (!this.searchAborted) {
      const flag = bestScore <= alphaOrig ? 2 /* Upper */ : bestScore >= beta ? 1 /* Lower */ : 0 /* Exact */;
      if (this.tt.size >= this.ttMax) this.evictTT();
      this.tt.set(key, { depth, score: bestScore, flag, bestMove });
    }
    return bestScore;
  }
  /** 静态搜索：只延伸吃子着法，直到局面安静 */
  quiescence(alpha, beta, sign, qdepth, deadlineHit) {
    this.nodes++;
    const standPat = sign * this.evalFn(this.board);
    if (qdepth <= 0 || (this.nodes & 1023) === 0 && deadlineHit()) {
      this.searchAborted = this.searchAborted || (this.nodes & 1023) === 0 && deadlineHit();
      return standPat;
    }
    if (standPat >= beta) return standPat;
    if (standPat > alpha) alpha = standPat;
    const captures = generatePseudoLegalMoves(this.board, this.board.turn).filter((m) => m.captured !== 255).sort((a, b2) => this.captureScore(b2) - this.captureScore(a));
    for (const m of captures) {
      const undo = this.board.makeMove(m);
      if (inCheck(this.board, this.board.turn === 0 ? 1 : 0)) {
        this.board.unmakeMove(m, undo);
        continue;
      }
      const score = -this.quiescence(-beta, -alpha, -sign, qdepth - 1, deadlineHit);
      this.board.unmakeMove(m, undo);
      if (score >= beta) return score;
      if (score > alpha) alpha = score;
    }
    return alpha;
  }
  /** side 方是否无合法走子（将死/困毙判定） */
  noMovesFor(side) {
    const pseudo = generatePseudoLegalMoves(this.board, side);
    for (const m of pseudo) {
      const undo = this.board.makeMove(m);
      const ok = !inCheck(this.board, side) && !this.board.kingsFacing();
      this.board.unmakeMove(m, undo);
      if (ok) return false;
    }
    return true;
  }
  captureScore(m) {
    return mvvlva(m.captured, this.board.at(m.from));
  }
  /** 根节点排序：置换表最佳 + 历史 + 吃子 */
  orderedRootMoves() {
    const ttBest = this.tt.get(this.board.hashKey)?.bestMove;
    return this.legalMovesSorted(ttBest);
  }
  orderedMoves(ttBest) {
    return this.legalMovesSorted(ttBest);
  }
  /** 生成合法走子并排序：TT最佳 > 吃子(MVV-LVA) > 历史启发 */
  legalMovesSorted(ttBest) {
    const side = this.board.turn;
    const pseudo = generatePseudoLegalMoves(this.board, side);
    const legal = [];
    for (const m of pseudo) {
      const undo = this.board.makeMove(m);
      if (!inCheck(this.board, side) && !this.board.kingsFacing()) legal.push(m);
      this.board.unmakeMove(m, undo);
    }
    return legal.sort((a, b2) => {
      if (ttBest && a.from === ttBest.from && a.to === ttBest.to) return -1;
      if (ttBest && b2.from === ttBest.from && b2.to === ttBest.to) return 1;
      const ca = a.captured !== 255 ? this.captureScore(a) : 0;
      const cb = b2.captured !== 255 ? this.captureScore(b2) : 0;
      if (ca !== cb) return cb - ca;
      const ha = this.history.get(`${a.from}-${a.to}`) ?? 0;
      const hb = this.history.get(`${b2.from}-${b2.to}`) ?? 0;
      return hb - ha;
    });
  }
  evictTT() {
    let i = 0;
    for (const k of this.tt.keys()) {
      this.tt.delete(k);
      if (++i >= this.ttMax / 2) break;
    }
  }
};

// engine-ai/src/nnue.ts
import { Worker } from "node:worker_threads";
var PIECE_ORDER = "RNBAKCPrnbakcp";
var VEC_LEN = 90 * 14 + 1;
var HEAD_I32 = 4;
var SAB_BYTES = HEAD_I32 * 4 + VEC_LEN * 4 + 4;
function encodeFen(fen) {
  const out = new Float32Array(VEC_LEN);
  encodeFenInto(fen, out);
  return out;
}
function encodeFenInto(fen, out) {
  const parts = fen.split(" ");
  const rows = parts[0].split("/");
  if (rows.length !== 10) throw new Error(`bad fen rows: ${fen}`);
  for (let r2 = 0; r2 < 10; r2++) {
    let c = 0;
    for (const ch of rows[r2]) {
      const d = ch.charCodeAt(0) - 48;
      if (d >= 1 && d <= 9) {
        c += d;
        continue;
      }
      const pi = PIECE_ORDER.indexOf(ch);
      if (pi < 0) throw new Error(`bad char '${ch}' in ${fen}`);
      out[(r2 * 9 + c) * 14 + pi] = 1;
      c++;
    }
    if (c !== 9) throw new Error(`row width ${c} != 9 in ${fen}`);
  }
  out[VEC_LEN - 1] = parts[1] === "w" ? 1 : 0;
}
var WORKER_SRC = `
(async () => {
  let workerData;
  try {
    workerData = require('node:worker_threads').workerData;
  } catch {
    workerData = (await import('node:worker_threads')).workerData;
  }
  let ort;
  try {
    ort = require('onnxruntime-node');
  } catch {
    ort = await import('onnxruntime-node');
  }
  const session = await ort.InferenceSession.create(workerData.modelPath);
  const i32 = new Int32Array(workerData.sab, 0, 4);
  const input = new Float32Array(workerData.sab, 16, ${VEC_LEN});
  const output = new Float32Array(workerData.sab, 16 + ${VEC_LEN} * 4, 1);
  i32[1] = 1; Atomics.notify(i32, 1); // ready\uFF08\u5FC5\u987B\u7528 Atomics \u5524\u9192\u4E3B\u7EBF\u7A0B\u7684 wait\uFF09
  for (;;) {
    Atomics.wait(i32, 0, 0);          // \u7B49\u4E3B\u7EBF\u7A0B\u53D1\u8BF7\u6C42\uFF080\u21921\uFF09
    const t = new ort.Tensor('float32', input.slice(), [1, ${VEC_LEN}]);
    const res = await session.run({ board: t });
    output[0] = res['score'].data[0];
    Atomics.store(i32, 0, 0);         // \u5904\u7406\u5B8C\u6210
    Atomics.notify(i32, 0);
  }
})().catch((e) => { console.error('[nnue-w] FATAL', e); process.exit(1); });
`;
var NnueEvaluator = class _NnueEvaluator {
  worker;
  i32;
  input;
  output;
  evalCount = 0;
  /** 评估缓存：搜索里同一局面（同 Zobrist 键）会被 quiescence 反复评估 */
  cache = /* @__PURE__ */ new Map();
  static CACHE_MAX = 2e5;
  constructor(modelPath) {
    const sab = new SharedArrayBuffer(SAB_BYTES);
    this.i32 = new Int32Array(sab, 0, HEAD_I32);
    this.input = new Float32Array(sab, HEAD_I32 * 4, VEC_LEN);
    this.output = new Float32Array(sab, HEAD_I32 * 4 + VEC_LEN * 4, 1);
    this.worker = new Worker(WORKER_SRC, { eval: true, workerData: { modelPath, sab } });
    this.worker.on("error", (e) => {
      this.i32[1] = 2;
      this.errMsg = String(e?.message ?? e);
      Atomics.notify(this.i32, 1);
    });
    this.worker.on("exit", (c) => {
      if (this.i32[1] === 0) {
        this.i32[1] = 2;
        this.errMsg = `nnue worker exited code ${c}`;
        Atomics.notify(this.i32, 1);
      }
    });
    const wr = Atomics.wait(this.i32, 1, 0, 3e4);
    if (wr !== "ok" || this.i32[1] !== 1) {
      throw new Error(`nnue worker init failed (${wr}): ${this.errMsg ?? "flag=" + this.i32[1]}`);
    }
  }
  /** 红方视角 cp。与 evaluate() 同约定，可直接注入 Searcher */
  evalBoard(board) {
    const key = board.hashKey;
    const hit = this.cache.get(key);
    if (hit !== void 0) return hit;
    encodeFenInto(board.toFen(), this.input);
    this.evalCount++;
    Atomics.store(this.i32, 0, 1);
    Atomics.notify(this.i32, 0, 1);
    Atomics.wait(this.i32, 0, 1);
    const t = this.output[0];
    const clamped = Math.max(-0.99999, Math.min(0.99999, t));
    const cp = Math.atanh(clamped) * 1e3;
    if (this.cache.size >= _NnueEvaluator.CACHE_MAX) this.cache.clear();
    this.cache.set(key, cp);
    return cp;
  }
  get callCount() {
    return this.evalCount;
  }
  get cacheSize() {
    return this.cache.size;
  }
  clearCache() {
    this.cache.clear();
  }
  dispose() {
    this.worker.terminate();
  }
};

// tools/distill/smoke-nnue.ts
var here = fileURLToPath(new URL(".", import.meta.url));
var repoRoot = here + "../..".repeat(1) + "/";
var fixture = JSON.parse(
  readFileSync(`${repoRoot}engine-ai/tests/fixtures/nnue-encoding.json`, "utf8")
);
console.log("[smoke] \u7F16\u7801 parity \u68C0\u67E5...");
for (const [fen, expected] of Object.entries(fixture)) {
  const actual = encodeFen(fen);
  for (let i = 0; i < expected.length; i++) {
    if (actual[i] !== expected[i]) {
      console.error(`[smoke] \u4E0D\u4E00\u81F4 ${fen} \u7B2C ${i} \u7EF4`);
      process.exit(1);
    }
  }
}
console.log("[smoke] parity OK\uFF08", Object.keys(fixture).length, "\u4E2A\u5C40\u9762\uFF09");
console.log("[smoke] \u52A0\u8F7D\u6A21\u578B...");
var t0 = Date.now();
var nn = new NnueEvaluator(`${repoRoot}/data/model.onnx`.replace(/\\/g, "/"));
console.log("[smoke] \u6A21\u578B\u52A0\u8F7D", Date.now() - t0, "ms");
var b = new Board();
console.log("[smoke] \u5F00\u5C40\u8BC4\u4F30:", nn.evalBoard(b).toFixed(0), "cp\uFF08\u7EA2\u65B9\u89C6\u89D2\uFF09");
var cold = 0;
for (let i = 0; i < 100; i++) {
  nn.clearCache();
  const t = Date.now();
  nn.evalBoard(b);
  cold += Date.now() - t;
}
console.log("[smoke] \u51B7\u8BC4\u4F30:", (cold / 100).toFixed(2), "ms/\u6B21");
var t1 = Date.now();
for (let i = 0; i < 200; i++) nn.evalBoard(b);
console.log("[smoke] \u70ED\u8BC4\u4F30\uFF08\u7F13\u5B58\u547D\u4E2D\uFF09:", ((Date.now() - t1) / 200 * 1e3).toFixed(1), "\xB5s/\u6B21");
console.log("[smoke] \u6CE8\u5165 Searcher\uFF0Cdepth 4 \u641C\u7D22...");
var s = new Searcher(b, 1 << 16, (board) => nn.evalBoard(board));
var r = s.search(4, 3e4);
console.log(
  "[smoke] bestMove:",
  r.bestMove ? `${r.bestMove.from}->${r.bestMove.to}` : "null",
  "score:",
  r.score.toFixed(0),
  "depth:",
  r.depth,
  "nodes:",
  r.nodes,
  "time:",
  r.timeMs,
  "ms"
);
nn.dispose();
console.log("[smoke] \u5168\u90E8\u901A\u8FC7");
