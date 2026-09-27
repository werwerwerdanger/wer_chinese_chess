/**
 * NNUE 编码一致性测试——蒸馏管线的命门
 *
 * encodeFen 必须与 tools/distill/train.py 的 encode_fen 逐位一致，
 * 错一位模型输出就是垃圾。金标准 fixture 由 Python 侧生成：
 *   engine-ai/tests/fixtures/nnue-encoding.json
 * （生成命令见 tools/distill/ 下各脚本注释）
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { encodeFen } from '../src/nnue.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(here, 'fixtures', 'nnue-encoding.json'), 'utf8'),
) as Record<string, number[]>;

describe('NNUE 编码与 Python 训练侧逐位一致', () => {
  for (const [fen, expected] of Object.entries(fixture)) {
    it(`编码一致：${fen.slice(0, 30)}...`, () => {
      const actual = encodeFen(fen);
      expect(actual.length).toBe(expected.length);
      // 值全是 0/1，精确相等
      for (let i = 0; i < expected.length; i++) {
        if (actual[i] !== expected[i]) {
          throw new Error(`第 ${i} 维不一致: js=${actual[i]} py=${expected[i]} (${fen})`);
        }
      }
    });
  }

  it('行棋方位：红先=1，黑先=0', () => {
    const w = encodeFen('4k4/9/9/9/9/9/9/9/9/4K4 w');
    const b = encodeFen('4k4/9/9/9/9/9/9/9/9/4K4 b');
    expect(w[w.length - 1]).toBe(1);
    expect(b[b.length - 1]).toBe(0);
  });

  it('通道序抽查：开局红车在通道 0（R）、红帅在通道 4（K）', () => {
    const x = encodeFen('rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w');
    // 红车 row9 col0 → (81+0)*14 + R(0) = 1134；红帅 row9 col4 → 85*14 + K(4) = 1194
    expect(x[1134]).toBe(1);
    expect(x[1194]).toBe(1);
    // 黑车 row0 col0 → 0*14 + r(7) = 7
    expect(x[7]).toBe(1);
  });
});
