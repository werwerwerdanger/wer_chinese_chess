/**
 * 马腿专项回归测试（2026-09-27 蒸馏标注时被 Pikafish 抓到的真 bug）
 *
 * 事故：legality.ts inCheck 的马腿表把"腿相对将位"的偏移抄错了参考系，
 * 8 个方向全错 → 马将军检测失效 → 自对弈生成"王可被吃"的非法局面，
 * Pikafish 收到后报 CRITICAL ERROR: Unsupported position. King can be captured.
 *
 * 金标准复现局面（Pikafish 报错的原 FEN）：
 *   3akabnr/9/4b4/p3p1p1p/9/P1c2nP2/4c3P/2p1K4/9/3r5 b
 *   黑马 f5 跳 e7 吃红帅，马腿 f6 为空 → 红方上一步送将，局面非法。
 *   （错误腿位 e6 恰有黑炮，旧代码误判"被蹩腿"而漏检）
 */
import { describe, expect, it } from 'vitest';
import { Board } from '../src/board.js';
import { Color } from '../src/types.js';
import { generateLegalMoves, inCheck } from '../src/legality.js';
import { sq } from '../src/constants.js';

describe('马将军检测（蹩腿回归）', () => {
  it('Pikafish 复现局面：黑马 f5 攻击红帅 e7（真腿 f6 空，e6 的炮挡的是错误腿位）', () => {
    const b = new Board('3akabnr/9/4b4/p3p1p1p/9/P1c2nP2/4c3P/2p1K4/9/3r5 b');
    expect(inCheck(b, Color.Red)).toBe(true);
  });

  it('竖直长跳被挡：黑马(7,3)跳帅(9,4)，真腿(8,3)有车 → 不构成将军（错误腿位(8,4)为空不能误报）', () => {
    const b = new Board('3k5/9/9/9/9/9/9/3n5/3R5/4K4 b');
    expect(inCheck(b, Color.Red)).toBe(false);
  });

  it('横向长跳将军：黑马(7,2)跳帅(9,3)，真腿(8,2)空 → 将军', () => {
    const b = new Board('4k4/9/9/9/9/9/9/2n6/9/3K5 b');
    expect(inCheck(b, Color.Red)).toBe(true);
  });

  it('横向长跳被挡：真腿(8,2)有车 → 不构成将军', () => {
    const b = new Board('4k4/9/9/9/9/9/9/2n6/2R6/3K5 b');
    expect(inCheck(b, Color.Red)).toBe(false);
  });

  it('红方走子过滤：帅走到黑马口上的走子必须被过滤', () => {
    // 帅(9,4)→(9,3)后，黑马(7,2)可跳(9,3)吃帅（腿(8,2)空）→ 该走子非法
    const b = new Board('4k4/9/9/9/9/9/9/2n6/9/4K4 w');
    const legal = generateLegalMoves(b, Color.Red);
    const kingLeft = legal.find((m) => m.to === sq(9, 3));
    expect(kingLeft).toBeUndefined();
  });
});
