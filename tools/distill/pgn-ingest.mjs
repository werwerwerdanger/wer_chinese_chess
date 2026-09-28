// tools/distill/pgn-ingest.ts
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

// engine/src/constants.ts
var BOARD_COLS = 9;
var BOARD_ROWS = 10;
var BOARD_SIZE = BOARD_COLS * BOARD_ROWS;
function sq(row, col) {
  return row * BOARD_COLS + col;
}
function rowOf(s) {
  return s / BOARD_COLS | 0;
}
function colOf(s) {
  return s % BOARD_COLS;
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
  let s = seed;
  return () => {
    s ^= s << 13n;
    s &= 0xffffffffffffffffn;
    s ^= s >> 7n;
    s ^= s << 17n;
    s &= 0xffffffffffffffffn;
    return s;
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
    for (let r = 0; r < BOARD_ROWS; r++) {
      let c = 0;
      for (const ch of rows[r]) {
        if (c >= BOARD_COLS) throw new Error(`\u7B2C ${r} \u884C\u8D85\u5BBD: ${rows[r]}`);
        if (ch >= "1" && ch <= "9") {
          c += ch.charCodeAt(0) - 48;
        } else {
          const p = pieceFromFenChar(ch);
          if (p === 255 /* None */) throw new Error(`\u975E\u6CD5\u5B57\u7B26 '${ch}' in FEN`);
          this.setPiece(sq(r, c), p);
          c++;
        }
      }
      if (c !== BOARD_COLS) throw new Error(`\u7B2C ${r} \u884C\u5BBD\u5EA6 ${c} \u2260 9`);
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
    for (let r = 0; r < BOARD_ROWS; r++) {
      let row = "";
      let empty = 0;
      for (let c = 0; c < BOARD_COLS; c++) {
        const p = this.squares[sq(r, c)];
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
    const b = Object.create(_Board.prototype);
    b.squares.set(this.squares);
    b.turn = this.turn;
    b.kingSquare.set(this.kingSquare);
    b.hashKey = this.hashKey;
    return b;
  }
  /** 将帅是否照面（同一列且中间无子）— 用于合法性判定 */
  kingsFacing() {
    const rk = this.kingSquare[0 /* Red */];
    const bk = this.kingSquare[1 /* Black */];
    if (rk < 0 || bk < 0) return false;
    const rc = colOf(rk), bc = colOf(bk);
    if (rc !== bc) return false;
    const rr = rowOf(rk), br = rowOf(bk);
    for (let r = br + 1; r < rr; r++) {
      if (this.squares[sq(r, rc)] !== 255 /* None */) return false;
    }
    return true;
  }
  /** 简易局面文本渲染（终端调试用） */
  ascii() {
    const files = "  0 1 2 3 4 5 6 7 8";
    const sep = "  +------------------------+";
    const lines = [files, sep];
    for (let r = 0; r < BOARD_ROWS; r++) {
      let row = `${r} |`;
      for (let c = 0; c < BOARD_COLS; c++) {
        const p = this.squares[sq(r, c)];
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
    for (let s = 0; s < BOARD_SIZE; s++) {
      const p = this.squares[s];
      if (p !== 255 /* None */ && (p & 7) === 0 && p !== 0 /* RedKing */ && p !== 8 /* BlackKing */) {
        throw new Error(`\u683C ${s} \u975E\u6CD5\u68CB\u5B50\u7F16\u7801 ${p}`);
      }
    }
    let h = 0n;
    for (let s = 0; s < BOARD_SIZE; s++) {
      const p = this.squares[s];
      if (p !== 255 /* None */) h ^= ZOBRIST_PIECE[p][s];
    }
    h ^= ZOBRIST_TURN[this.turn];
    if (h !== this.hashKey) throw new Error("Zobrist \u952E\u4E0E\u68CB\u76D8\u4E0D\u4E00\u81F4");
    for (let s = 0; s < BOARD_SIZE; s++) {
      if (this.squares[s] === 0 /* RedKing */ && this.kingSquare[0 /* Red */] !== s)
        throw new Error("\u7EA2\u5E05\u4F4D\u7F6E\u7F13\u5B58\u5931\u6548");
      if (this.squares[s] === 8 /* BlackKing */ && this.kingSquare[1 /* Black */] !== s)
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
  const r = rowOf(from), c = colOf(from);
  const deltas = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  for (const [dr, dc] of deltas) {
    const nr = r + dr, nc = c + dc;
    if (!inPalace(nr, nc, side)) continue;
    pushMove(board, from, sq(nr, nc), opp, moves);
  }
}
function genAdvisor(board, from, side, opp, moves) {
  const r = rowOf(from), c = colOf(from);
  const deltas = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
  for (const [dr, dc] of deltas) {
    const nr = r + dr, nc = c + dc;
    if (!inPalace(nr, nc, side)) continue;
    pushMove(board, from, sq(nr, nc), opp, moves);
  }
}
function genElephant(board, from, side, opp, moves) {
  const r = rowOf(from), c = colOf(from);
  const deltas = [[-2, -2], [-2, 2], [2, -2], [2, 2]];
  for (const [dr, dc] of deltas) {
    const nr = r + dr, nc = c + dc;
    if (!onBoard(nr, nc)) continue;
    if (!elephantZone(nr, side)) continue;
    if (board.squares[sq(r + dr / 2, c + dc / 2)] !== 255 /* None */) continue;
    pushMove(board, from, sq(nr, nc), opp, moves);
  }
}
function genHorse(board, from, _side, opp, moves) {
  const r = rowOf(from), c = colOf(from);
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
    const nr = r + dr, nc = c + dc;
    if (!onBoard(nr, nc)) continue;
    if (board.squares[sq(r + lr, c + lc)] !== 255 /* None */) continue;
    pushMove(board, from, sq(nr, nc), opp, moves);
  }
}
function genRook(board, from, _side, opp, moves) {
  const r = rowOf(from), c = colOf(from);
  for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
    let nr = r + dr, nc = c + dc;
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
  const r = rowOf(from), c = colOf(from);
  for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
    let nr = r + dr, nc = c + dc;
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
  const r = rowOf(from), c = colOf(from);
  const forward = side === 0 /* Red */ ? -1 : 1;
  const nr = r + forward;
  if (onBoard(nr, c)) pushMove(board, from, sq(nr, c), opp, moves);
  if (pawnCrossed(r, side)) {
    if (c - 1 >= 0) pushMove(board, from, sq(r, c - 1), opp, moves);
    if (c + 1 < BOARD_COLS) pushMove(board, from, sq(r, c + 1), opp, moves);
  }
}

// engine/src/legality.ts
function inCheck(board, side) {
  const kingSq = board.kingSquare[side];
  if (kingSq < 0) return true;
  const kr = rowOf(kingSq), kc = colOf(kingSq);
  const opp = side ^ 1;
  for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
    let r = kr + dr, c = kc + dc;
    let firstPiece = 255 /* None */;
    let firstR = -1, firstC = -1;
    while (onBoard(r, c)) {
      const p = board.squares[sq(r, c)];
      if (p !== 255 /* None */) {
        firstPiece = p;
        firstR = r;
        firstC = c;
        break;
      }
      r += dr;
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
    r = firstR + dr;
    c = firstC + dc;
    while (onBoard(r, c)) {
      const p = board.squares[sq(r, c)];
      if (p !== 255 /* None */) {
        if (colorOf(p) === opp && typeOf(p) === 5 /* Cannon */) return true;
        break;
      }
      r += dr;
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
function generateLegalMoves(board, side) {
  const pseudo = generatePseudoLegalMoves(board, side);
  const legal = [];
  for (const m of pseudo) {
    const undo = board.makeMove(m);
    if (!inCheck(board, side) && !board.kingsFacing()) legal.push(m);
    board.unmakeMove(m, undo);
  }
  return legal;
}

// tools/distill/pgn-ingest.ts
function decodeAuto(buf) {
  for (const enc of ["utf-8", "big5", "gb18030"]) {
    try {
      return new TextDecoder(enc, { fatal: true }).decode(buf);
    } catch {
    }
  }
  return buf.toString("utf8");
}
var PIECE_CHARS = {
  // 红（繁/简都收）
  "\u5E25": 0,
  "\u5E05": 0,
  "\u4ED5": 1,
  "\u76F8": 2,
  "\u99AC": 3,
  "\u9A6C": 3,
  "\u8ECA": 4,
  "\u8F66": 4,
  "\u70AE": 5,
  "\u5175": 6,
  // 黑
  "\u5C07": 0,
  "\u5C06": 0,
  "\u58EB": 1,
  "\u8C61": 2,
  "\u99AC": 3,
  "\u8F66": 4,
  "\u7832": 5,
  "\u5352": 6
};
var NUM_CN = { "\u4E00": 1, "\u4E8C": 2, "\u4E09": 3, "\u56DB": 4, "\u4E94": 5, "\u516D": 6, "\u4E03": 7, "\u516B": 8, "\u4E5D": 9 };
function parseNum(ch) {
  if (NUM_CN[ch] !== void 0) return NUM_CN[ch];
  const d = ch.charCodeAt(0);
  if (d >= 65296 && d <= 65305) return d - 65296;
  if (d >= 48 && d <= 57) return d - 48;
  return -1;
}
var MOVE_RE = /^(前|後|后|中)?([帥帅將将仕士相象馬马车車炮砲兵卒])([一二三四五六七八九１２３４５６７８９1-9])?([平進进退])([一二三四五六七八九１２３４５６７８９1-9])$/;
function colOf2(n, side, mode) {
  if (side === 0) return 8 - (n - 1);
  return mode === "A" ? n - 1 : 8 - (n - 1);
}
function parseChineseMove(board, token, mode) {
  const m = MOVE_RE.exec(token.trim());
  if (!m) return null;
  const [, prefix, pieceCh, fromNumCh, action, toNumCh] = m;
  const type = PIECE_CHARS[pieceCh];
  if (type === void 0) return null;
  const side = board.turn;
  const fromN = fromNumCh ? parseNum(fromNumCh) : 0;
  const toN = toNumCh ? parseNum(toNumCh) : -1;
  if (fromN < 0 || toN < 1) return null;
  const squares = board.squares;
  const cands = [];
  if (fromN >= 1) {
    const fc = colOf2(fromN, side, mode);
    if (fc < 0 || fc > 8) return null;
    for (let r = 0; r < 10; r++) {
      const p = squares[r * 9 + fc];
      if (p !== 255 && (p >> 3 & 1) === side && (p & 7) === type) cands.push(r * 9 + fc);
    }
  } else {
    for (let r = 0; r < 10; r++) {
      for (let c = 0; c < 9; c++) {
        const p = squares[r * 9 + c];
        if (p !== 255 && (p >> 3 & 1) === side && (p & 7) === type) cands.push(r * 9 + c);
      }
    }
  }
  if (cands.length === 0) return null;
  let froms;
  if (cands.length > 1 && prefix) {
    const sorted = [...cands].sort((a, b) => (a - b) * (side === 0 ? 1 : -1));
    if (prefix === "\u524D") froms = [sorted[0]];
    else if (prefix === "\u5F8C" || prefix === "\u540E") froms = [sorted[sorted.length - 1]];
    else froms = [sorted[Math.floor(sorted.length / 2)]];
  } else {
    froms = cands;
  }
  const legal = generateLegalMoves(board, board.turn);
  const forward = side === 0 ? -1 : 1;
  const tcWant = colOf2(toN, side, mode);
  const matches = [];
  for (const from of froms) {
    const fr = Math.floor(from / 9), fc2 = from % 9;
    for (const mv of legal) {
      if (mv.from !== from) continue;
      const tr = Math.floor(mv.to / 9), tc = mv.to % 9;
      if (action === "\u5E73") {
        if (tr === fr && tc === tcWant) matches.push(mv);
        continue;
      }
      const adv = action === "\u9032" || action === "\u8FDB";
      const dr = tr - fr;
      const dirOk = adv ? Math.sign(dr) === forward : Math.sign(dr) === -forward;
      if (!dirOk || dr === 0) continue;
      const straight = type === 4 || type === 5 || type === 0 || type === 6;
      if (straight) {
        if (tc === fc2 && Math.abs(dr) === toN) matches.push(mv);
      } else {
        if (tc === tcWant) matches.push(mv);
      }
    }
  }
  return matches.length === 1 ? matches[0] : null;
}
function parsePgn(text) {
  const fenMatch = /\[FEN "([^"]+)"\]/.exec(text);
  const fen = fenMatch ? fenMatch[1] : "rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w";
  const body = text.split(/\r?\n\r?\n/).slice(1).join("\n");
  const moves = [];
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.replace(/\d+\.\s*/g, " ").trim();
    if (!line) continue;
    if (/^(1-0|0-1|1\/2-1\/2|\*)$/.test(line)) continue;
    for (const tok of line.split(/\s+/)) {
      if (!tok) continue;
      if (/^(1-0|0-1|1\/2-1\/2|\*)$/.test(tok)) continue;
      moves.push(tok);
    }
  }
  if (moves.length === 0) return null;
  return { fen, moves };
}
function* walkPgn(root) {
  for (const name of readdirSync(root)) {
    const p = join(root, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* walkPgn(p);
    else if (name.endsWith(".pgn")) yield p;
  }
}
function main() {
  const argv = process.argv.slice(2);
  const get = (k, d) => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 && argv[i + 1] !== void 0 ? argv[i + 1] : d;
  };
  const root = get("root");
  const out = get("out", "data/positions-web.txt");
  const limit = Number(get("limit", "0"));
  const files = [...walkPgn(root)];
  const use = limit > 0 ? files.slice(0, limit) : files;
  console.log(`[ingest] ${use.length}/${files.length} \u4E2A PGN \u6587\u4EF6`);
  const seen = /* @__PURE__ */ new Set();
  const lines = [];
  let gamesOk = 0, gamesFail = 0, movesOk = 0, movesFail = 0;
  const failSamples = [];
  for (const file of use) {
    let text;
    try {
      text = decodeAuto(readFileSync(file));
    } catch {
      gamesFail++;
      continue;
    }
    if (!text.includes("[FEN")) {
      gamesFail++;
      continue;
    }
    const g = parsePgn(text);
    if (!g) {
      gamesFail++;
      continue;
    }
    let replayed = null;
    const failToks = [];
    for (const mode of ["A", "B"]) {
      let b;
      try {
        b = new Board(g.fen);
      } catch {
        break;
      }
      const fens = [b.toFen()];
      const localSeen = new Set(fens);
      let ok = true;
      for (const tok of g.moves) {
        const mv = parseChineseMove(b, tok, mode);
        if (!mv) {
          failToks.push(`${mode}:${tok}@${g.moves.indexOf(tok)}`);
          ok = false;
          break;
        }
        b.makeMove(mv);
        const f = b.toFen();
        if (!localSeen.has(f)) {
          localSeen.add(f);
          fens.push(f);
        }
      }
      if (ok) {
        replayed = fens;
        break;
      }
    }
    if (replayed) {
      gamesOk++;
      movesOk += g.moves.length;
      for (const f of replayed) {
        if (!seen.has(f)) {
          seen.add(f);
          lines.push(f);
        }
      }
    } else {
      gamesFail++;
      movesFail += g.moves.length;
      if (failSamples.length < 8) failSamples.push(`${file}: "${failToks.join(" | ")}"`);
    }
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, lines.join("\n") + "\n", "utf8");
  console.log(`[ingest] \u5BF9\u5C40\u6210\u529F ${gamesOk}  \u5931\u8D25 ${gamesFail}  \u7740\u6CD5\u6210\u529F ${movesOk}  \u89E3\u6790\u5931\u8D25 ${movesFail}`);
  console.log(`[ingest] \u53BB\u91CD\u540E\u5C40\u9762 ${lines.length} \u6761 \u2192 ${out}`);
  if (failSamples.length) {
    console.log("[ingest] \u5931\u8D25\u6837\u4F8B:");
    for (const s of failSamples) console.log("  " + s);
  }
}
main();
