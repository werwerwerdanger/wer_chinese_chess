/**
 * NNUE 风格评估器 —— 蒸馏自 Pikafish 的小型 MLP（ONNX），仅限 node 环境
 *
 * ⚠️ 不从 index.ts 导出（onnxruntime-node 是原生模块，进 web 打包会炸）。
 *    node 侧脚本直接 import 本文件。
 *
 * 技术点：onnxruntime-node 的 session.run() 是异步 API，而搜索引擎的评估
 * 是同步热路径（quiescence 叶子节点）。解法：Worker 线程持有 session，
 * 主线程经 SharedArrayBuffer + Atomics.wait 做同步调用桥（node 主线程允许阻塞）。
 *
 * 编码约定（必须与 tools/distill/train.py encode_fen 逐位一致）：
 *   90 格 × 14 通道 one-hot（通道序 RNBAKCPrnbakcp，行主序 r*9+c）+ 行棋方 1 维（红 w = 1）
 *   输出：红方视角 tanh 分；cp = atanh(score) * 1000
 */
import { Worker } from 'node:worker_threads';
import type { Board } from '@wer-chess/engine';

const PIECE_ORDER = 'RNBAKCPrnbakcp';
const VEC_LEN = 90 * 14 + 1;

// SAB 布局：Int32[4]（[0]=请求标志） | Float32 输入 1261 | Float32 输出 1
const HEAD_I32 = 4;
const SAB_BYTES = HEAD_I32 * 4 + VEC_LEN * 4 + 4;

/** FEN → 1261 维向量（与 train.py encode_fen 逐位一致；测试用） */
export function encodeFen(fen: string): Float32Array {
  const out = new Float32Array(VEC_LEN);
  encodeFenInto(fen, out);
  return out;
}

/** 同上，但写入调用方提供的数组（热路径零分配） */
export function encodeFenInto(fen: string, out: Float32Array): void {
  const parts = fen.split(' ');
  const rows = parts[0]!.split('/');
  if (rows.length !== 10) throw new Error(`bad fen rows: ${fen}`);
  for (let r = 0; r < 10; r++) {
    let c = 0;
    for (const ch of rows[r]!) {
      const d = ch.charCodeAt(0) - 48;
      if (d >= 1 && d <= 9) { c += d; continue; }
      const pi = PIECE_ORDER.indexOf(ch);
      if (pi < 0) throw new Error(`bad char '${ch}' in ${fen}`);
      out[(r * 9 + c) * 14 + pi] = 1;
      c++;
    }
    if (c !== 9) throw new Error(`row width ${c} != 9 in ${fen}`);
  }
  out[VEC_LEN - 1] = parts[1] === 'w' ? 1 : 0;
}

// Worker 源码（eval 模式内联，避免额外文件）。
// ⚠️ Node 22+ 的 eval worker 会继承父脚本的模块类型：CJS 父→有 require，ESM 父→没有。
// 所以用 try require + fallback 动态 import 的双兼容写法。
const WORKER_SRC = `
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
  i32[1] = 1; Atomics.notify(i32, 1); // ready（必须用 Atomics 唤醒主线程的 wait）
  for (;;) {
    Atomics.wait(i32, 0, 0);          // 等主线程发请求（0→1）
    const t = new ort.Tensor('float32', input.slice(), [1, ${VEC_LEN}]);
    const res = await session.run({ board: t });
    output[0] = res['score'].data[0];
    Atomics.store(i32, 0, 0);         // 处理完成
    Atomics.notify(i32, 0);
  }
})().catch((e) => { console.error('[nnue-w] FATAL', e); process.exit(1); });
`;

/** 同步 ONNX 评估器：evalBoard(board) 返回红方视角 cp */
export class NnueEvaluator {
  private readonly worker: Worker;
  private readonly i32: Int32Array;
  private readonly input: Float32Array;
  private readonly output: Float32Array;
  private evalCount = 0;
  /** 评估缓存：搜索里同一局面（同 Zobrist 键）会被 quiescence 反复评估 */
  private cache = new Map<bigint, number>();
  private static CACHE_MAX = 200000;

  constructor(modelPath: string) {
    const sab = new SharedArrayBuffer(SAB_BYTES);
    this.i32 = new Int32Array(sab, 0, HEAD_I32);
    this.input = new Float32Array(sab, HEAD_I32 * 4, VEC_LEN);
    this.output = new Float32Array(sab, HEAD_I32 * 4 + VEC_LEN * 4, 1);
    this.worker = new Worker(WORKER_SRC, { eval: true, workerData: { modelPath, sab } });
    // worker 崩溃时置 i32[1]=2 并带上原因，让主线程的等待能醒来报错
    this.worker.on('error', (e) => {
      this.i32[1] = 2;
      (this as { errMsg?: string }).errMsg = String(e?.message ?? e);
      Atomics.notify(this.i32, 1);
    });
    this.worker.on('exit', (c) => {
      if (this.i32[1] === 0) {
        this.i32[1] = 2;
        (this as { errMsg?: string }).errMsg = `nnue worker exited code ${c}`;
        Atomics.notify(this.i32, 1);
      }
    });
    // 阻塞等 worker 完成 session 初始化（node 主线程允许 Atomics.wait）
    const wr = Atomics.wait(this.i32, 1, 0, 30000);
    if (wr !== 'ok' || this.i32[1] !== 1) {
      throw new Error(`nnue worker init failed (${wr}): ${(this as { errMsg?: string }).errMsg ?? 'flag=' + this.i32[1]}`);
    }
  }

  /** 红方视角 cp。与 evaluate() 同约定，可直接注入 Searcher */
  evalBoard(board: Board): number {
    const key = board.hashKey;
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    encodeFenInto(board.toFen(), this.input);
    this.evalCount++;
    Atomics.store(this.i32, 0, 1);
    Atomics.notify(this.i32, 0, 1);
    Atomics.wait(this.i32, 0, 1); // 等 worker 清零
    const t = this.output[0]!;
    const clamped = Math.max(-0.99999, Math.min(0.99999, t));
    const cp = Math.atanh(clamped) * 1000;
    if (this.cache.size >= NnueEvaluator.CACHE_MAX) this.cache.clear();
    this.cache.set(key, cp);
    return cp;
  }

  get callCount(): number {
    return this.evalCount;
  }

  get cacheSize(): number {
    return this.cache.size;
  }

  clearCache(): void {
    this.cache.clear();
  }

  dispose(): void {
    this.worker.terminate();
  }
}
