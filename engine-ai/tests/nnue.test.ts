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

  it('评估结果与评估历史无关（输入 buffer 必须先清零）', () => {
    // 历史 bug：evalBoard 复用内部 Float32Array，只写 1 不写 0，
    // 于是新局面的向量里残留上一个局面的棋子 → 模型看到"叠加局面"，
    // 搜索里除第一次之外的评估全是垃圾（开局被评成 -1754、还一路饱和到 -6103）。
    const A = 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w';
    // B 只比 A 少一个左炮（A 的棋子 ⊂ 污染源）：若不清零，B 会被评成 A（黑走）的分
    const B = 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/25C1/9/RNBAKABNR b';

    const shared = new NnueEvaluator(MODEL);
    const fresh = new NnueEvaluator(MODEL);
    try {
      const a1 = shared.evalBoard(new Board(A));
      const bAfterA = shared.evalBoard(new Board(B)); // 同一个 evaluator，夹在 A 后面
      const bAlone = fresh.evalBoard(new Board(B));   // 干净 buffer
      const aAlone = fresh.evalBoard(new Board(A));

      expect(a1).toBeCloseTo(aAlone, 5);
      expect(bAfterA).toBeCloseTo(bAlone, 5);
      // 这两个局面本来就不该同分（差着棋子）
      expect(Math.abs(bAfterA - a1)).toBeGreaterThan(1);
    } finally {
      shared.dispose();
      fresh.dispose();
    }
  });
});
