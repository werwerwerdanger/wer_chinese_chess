/**
 * NnueEvaluator 集成测试（真实 ONNX 推理，node 独占）
 * 模型路径相对仓库根：data/model.onnx
 */
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Board } from '@wer-chess/engine';
import { NnueEvaluator } from '../src/nnue.js';
import { Searcher } from '../src/search.js';

// 测试文件在 <repo>/engine-ai/tests/ → 仓库根要退两级（曾经写成三级，指向仓库外，导致 30s 超时）
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MODEL = join(repoRoot, 'data', 'model.onnx');

describe('NnueEvaluator（真实模型推理）', () => {
  it('可同步评估，输出有限数值', () => {
    const nn = new NnueEvaluator(MODEL);
    try {
      const b = new Board();
      const cp = nn.evalBoard(b);
      expect(Number.isFinite(cp)).toBe(true);
      expect(Math.abs(cp)).toBeLessThan(3000); // 开局不应报接近将杀的分
      expect(nn.callCount).toBe(1);
    } finally {
      nn.dispose();
    }
  });

  it('注入 Searcher 后能完成完整搜索', () => {
    const nn = new NnueEvaluator(MODEL);
    try {
      const b = new Board();
      const s = new Searcher(b, 1 << 16, (board) => nn.evalBoard(board));
      const r = s.search(3, 15000);
      expect(r.bestMove).not.toBeNull();
      expect(r.bestMove!.from).toBeGreaterThanOrEqual(0);
      expect(r.nodes).toBeGreaterThan(0);
      expect(nn.callCount).toBeGreaterThan(0);
    } finally {
      nn.dispose();
    }
  });
});
