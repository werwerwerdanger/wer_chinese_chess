// tools/distill/bench-eval.ts
import { readFileSync } from "node:fs";

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
function inPalace(row, col, color) {
  if (col < 3 || col > 5) return false;
  if (row < 0 || row > 9) return false;
  return color === 0 /* Red */ ? row >= 7 : row <= 2;
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
    const lines2 = [files, sep];
    for (let r = 0; r < BOARD_ROWS; r++) {
      let row = `${r} |`;
      for (let c = 0; c < BOARD_COLS; c++) {
        const p = this.squares[sq(r, c)];
        const ch = p === 255 /* None */ ? "." : PIECE_TO_FEN_CHAR[p] ?? "?";
        row += ch === "." ? " ." : ch === ch.toUpperCase() ? ` ${ch}` : ` ${ch}`;
      }
      row += " |";
      lines2.push(row);
    }
    lines2.push(sep);
    lines2.push(`  turn: ${this.turn === 0 /* Red */ ? "Red" : "Black"}`);
    return lines2.join("\n");
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

// engine-ai/src/nnue.ts
import { Worker } from "node:worker_threads";
var PIECE_ORDER = "RNBAKCPrnbakcp";
var VEC_LEN = 90 * 14 + 1;
var HEAD_I32 = 4;
var SAB_BYTES = HEAD_I32 * 4 + VEC_LEN * 4 + 4;
function encodeFenInto(fen, out) {
  out.fill(0);
  const parts = fen.split(" ");
  const rows = parts[0].split("/");
  if (rows.length !== 10) throw new Error(`bad fen rows: ${fen}`);
  for (let r = 0; r < 10; r++) {
    let c = 0;
    for (const ch of rows[r]) {
      const d = ch.charCodeAt(0) - 48;
      if (d >= 1 && d <= 9) {
        c += d;
        continue;
      }
      const pi = PIECE_ORDER.indexOf(ch);
      if (pi < 0) throw new Error(`bad char '${ch}' in ${fen}`);
      out[(r * 9 + c) * 14 + pi] = 1;
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
  const i32 = new Int32Array(workerData.sab, 0, 4);
  const input = new Float32Array(workerData.sab, 16, ${VEC_LEN});
  const output = new Float32Array(workerData.sab, 16 + ${VEC_LEN} * 4, 1);
  // \u26A0\uFE0F \u521D\u59CB\u5316\u5931\u8D25\u5FC5\u987B\u81EA\u5DF1\u5524\u9192\u4E3B\u7EBF\u7A0B\uFF1A\u4E3B\u7EBF\u7A0B\u6B63\u963B\u585E\u5728 Atomics.wait \u4E0A\uFF0C
  //    \u5B83\u7684 worker.on('error'/'exit') \u56DE\u8C03\u8981\u7B49 wait \u8FD4\u56DE\u624D\u4F1A\u8DD1\uFF0C\u5426\u5219\u53EA\u80FD\u5E72\u7B49 30s \u8D85\u65F6\u3002
  const fail = (e) => {
    console.error('[nnue-w] FATAL', e);
    i32[1] = 2;
    Atomics.notify(i32, 1);
    process.exit(1);
  };
  try {
    let ort;
    try {
      ort = require('onnxruntime-node');
    } catch {
      ort = await import('onnxruntime-node');
    }
    const session = await ort.InferenceSession.create(workerData.modelPath);
    i32[1] = 1; Atomics.notify(i32, 1); // ready\uFF08\u5FC5\u987B\u7528 Atomics \u5524\u9192\u4E3B\u7EBF\u7A0B\u7684 wait\uFF09
    for (;;) {
      Atomics.wait(i32, 0, 0);          // \u7B49\u4E3B\u7EBF\u7A0B\u53D1\u8BF7\u6C42\uFF080\u21921\uFF09
      const t = new ort.Tensor('float32', input.slice(), [1, ${VEC_LEN}]);
      const res = await session.run({ board: t });
      output[0] = res['score'].data[0];
      Atomics.store(i32, 0, 0);         // \u5904\u7406\u5B8C\u6210
      Atomics.notify(i32, 0);
    }
  } catch (e) {
    fail(e);
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
      const why = this.errMsg ?? `flag=${this.i32[1]}`;
      throw new Error(`nnue worker init failed (${wr}): ${why}\uFF08\u6A21\u578B\u8DEF\u5F84 ${modelPath}\uFF09`);
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

// tools/distill/bench-eval.ts
var argv = process.argv.slice(2);
var get = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] !== void 0 ? argv[i + 1] : d;
};
var MODEL = get("model", "data/model-best.onnx");
var N = Number(get("n", "2000"));
var SRC = get("src", "data/positions-web.txt");
var lines = readFileSync(SRC, "utf8").split("\n").filter((l) => l.trim());
var step = Math.max(1, Math.floor(lines.length / N));
var fens = [];
for (let i = 0; i < lines.length && fens.length < N; i += step) fens.push(lines[i]);
var nn = new NnueEvaluator(MODEL);
var boards = fens.map((f) => new Board(f));
for (let i = 0; i < 50; i++) nn.evalBoard(boards[i]);
var t0 = performance.now();
var sink = 0;
for (const b of boards) sink += nn.evalBoard(b);
var dt = performance.now() - t0;
console.log(`[bench] model=${MODEL}  \u5C40\u9762=${boards.length} \u4E2A\uFF08\u4E92\u4E0D\u76F8\u540C\uFF09`);
console.log(`[bench] \u603B\u8017\u65F6 ${dt.toFixed(0)}ms \u2192 ${(dt / boards.length).toFixed(3)} ms/\u6B21\uFF0C${(boards.length / (dt / 1e3)).toFixed(0)} \u6B21/\u79D2`);
console.log(`[bench] 3s \u5185\u7EA6\u53EF\u8BC4\u4F30 ${(boards.length / (dt / 1e3) * 3 / 1e3).toFixed(0)}k \u6B21\uFF08\u2248 \u641C\u7D22\u8282\u70B9\u4E0A\u9650\u91CF\u7EA7\uFF09\uFF1Bsink=${sink.toFixed(0)}`);
nn.dispose();
