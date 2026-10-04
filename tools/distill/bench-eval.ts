/**
 * bench-eval —— NNUE 评估吞吐基准（决定搜索能搜多深）
 *
 * 用法：
 *   node tools/distill/bench-eval.mjs [--model data/model-best.onnx] [--n 2000]
 *
 * 取 n 个**互不相同**的真实局面（默认从 data/positions-web.txt 抽样），
 * 全部走 NnueEvaluator.evalBoard（缓存不命中），输出 ms/次 与 次/秒。
 * 改 nnue.ts 的 session 选项后跑它对比，别凭 node 数猜。
 */
import { readFileSync } from 'node:fs';
import { Board } from '@wer-chess/engine';
import { NnueEvaluator } from '../../engine-ai/src/nnue';

const argv = process.argv.slice(2);
const get = (k: string, d: string) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d;
};
const MODEL = get('model', 'data/model-best.onnx');
const N = Number(get('n', '2000'));
const SRC = get('src', 'data/positions-web.txt');

const lines = readFileSync(SRC, 'utf8').split('\n').filter((l) => l.trim());
const step = Math.max(1, Math.floor(lines.length / N));
const fens: string[] = [];
for (let i = 0; i < lines.length && fens.length < N; i += step) fens.push(lines[i]!);

const nn = new NnueEvaluator(MODEL);
const boards = fens.map((f) => new Board(f));

// 预热（首次含懒加载）
for (let i = 0; i < 50; i++) nn.evalBoard(boards[i]!);

const t0 = performance.now();
let sink = 0;
for (const b of boards) sink += nn.evalBoard(b);
const dt = performance.now() - t0;

console.log(`[bench] model=${MODEL}  局面=${boards.length} 个（互不相同）`);
console.log(`[bench] 总耗时 ${dt.toFixed(0)}ms → ${(dt / boards.length).toFixed(3)} ms/次，${(boards.length / (dt / 1000)).toFixed(0)} 次/秒`);
console.log(`[bench] 3s 内约可评估 ${((boards.length / (dt / 1000)) * 3 / 1000).toFixed(0)}k 次（≈ 搜索节点上限量级）；sink=${sink.toFixed(0)}`);
nn.dispose();
