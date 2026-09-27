/** NNUE 冒烟：编码 parity（抽查） + 真模型推理 + 注入 Searcher 完整搜索 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Board } from '@wer-chess/engine';
import { Searcher } from '@wer-chess/engine-ai';
import { NnueEvaluator, encodeFen } from '../../engine-ai/src/nnue';

const here = fileURLToPath(new URL('.', import.meta.url)); // .../wer_chinese_chess/tools/distill/
const repoRoot = here + '../..'.repeat(1) + '/'; // .../wer_chinese_chess/
const fixture = JSON.parse(
  readFileSync(`${repoRoot}engine-ai/tests/fixtures/nnue-encoding.json`, 'utf8'),
) as Record<string, number[]>;

console.log('[smoke] 编码 parity 检查...');
for (const [fen, expected] of Object.entries(fixture)) {
  const actual = encodeFen(fen);
  for (let i = 0; i < expected.length; i++) {
    if (actual[i] !== expected[i]) {
      console.error(`[smoke] 不一致 ${fen} 第 ${i} 维`);
      process.exit(1);
    }
  }
}
console.log('[smoke] parity OK（', Object.keys(fixture).length, '个局面）');

console.log('[smoke] 加载模型...');
const t0 = Date.now();
const nn = new NnueEvaluator(`${repoRoot}/data/model.onnx`.replace(/\\/g, '/'));
console.log('[smoke] 模型加载', Date.now() - t0, 'ms');

const b = new Board();
console.log('[smoke] 开局评估:', nn.evalBoard(b).toFixed(0), 'cp（红方视角）');

// 评估速度：冷（每次清缓存）与热（同局面命中缓存）
let cold = 0;
for (let i = 0; i < 100; i++) { nn.clearCache(); const t = Date.now(); nn.evalBoard(b); cold += Date.now() - t; }
console.log('[smoke] 冷评估:', (cold / 100).toFixed(2), 'ms/次');
const t1 = Date.now();
for (let i = 0; i < 200; i++) nn.evalBoard(b);
console.log('[smoke] 热评估（缓存命中）:', ((Date.now() - t1) / 200 * 1000).toFixed(1), 'µs/次');

console.log('[smoke] 注入 Searcher，depth 4 搜索...');
const s = new Searcher(b, 1 << 16, (board) => nn.evalBoard(board));
const r = s.search(4, 30000);
console.log('[smoke] bestMove:', r.bestMove ? `${r.bestMove.from}->${r.bestMove.to}` : 'null',
  'score:', r.score.toFixed(0), 'depth:', r.depth, 'nodes:', r.nodes, 'time:', r.timeMs, 'ms');
nn.dispose();
console.log('[smoke] 全部通过');
