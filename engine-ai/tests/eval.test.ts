/**
 * 评估函数测试
 */
import { describe, it, expect } from 'vitest';
import { Board } from '@wer-chess/engine';
import { evaluate, mvvlva } from '../src/eval.js';
import { INITIAL_FEN } from '@wer-chess/engine';
import { Piece } from '@wer-chess/engine';

describe('evaluate', () => {
  it('初始局面和棋为零（双方对称）', () => {
    const b = new Board();
    expect(evaluate(b)).toBe(0);
  });

  it('红多一车 → 约 +900 分（子力主导，位置分微调）', () => {
    // 初始局面去掉黑右车（0,8）
    const fen = INITIAL_FEN.replace(/^rnbakabnr/, 'rnbakabn1');
    const b = new Board(fen);
    const score = evaluate(b);
    expect(score).toBeGreaterThan(850);
    expect(score).toBeLessThan(1000);
  });

  it('红兵越靠近敌方九宫分越高', () => {
    // (6,4) 未过河 PST=0 → (4,4) 过河 PST=5 → (1,4) 深入 PST=40
    const b1 = new Board('4k4/9/9/9/9/9/4P4/9/9/4K4 w');
    const b2 = new Board('4k4/9/9/9/4P4/9/9/9/9/4K4 w');
    const b3 = new Board('4k4/4P4/9/9/9/9/9/9/9/4K4 w');
    const s1 = evaluate(b1), s2 = evaluate(b2), s3 = evaluate(b3);
    expect(s2).toBeGreaterThan(s1);
    expect(s3).toBeGreaterThan(s2);
  });

  it('黑卒深入红方腹地 → 红方负分', () => {
    // 黑卒 (8,4) 已深入（黑方视角的"过河深处"= PST 高位）→ 贡献 -(50+高分)
    const b = new Board('4k4/9/9/9/9/9/9/9/4p4/4K4 w');
    expect(evaluate(b)).toBeLessThan(-50);
  });
});

describe('mvvlva', () => {
  it('吃大子优先：车吃车 > 车吃兵（victim 优先）', () => {
    expect(mvvlva(Piece.BlackRook, Piece.RedRook))
      .toBeGreaterThan(mvvlva(Piece.BlackPawn, Piece.RedRook));
  });
  it('小子吃大子优先：兵吃车 > 车吃兵（LVA 减分小）', () => {
    expect(mvvlva(Piece.BlackRook, Piece.RedPawn))
      .toBeGreaterThan(mvvlva(Piece.BlackPawn, Piece.RedRook));
  });
  it('非吃子为 0 分', () => {
    expect(mvvlva(255 as never, Piece.RedRook)).toBe(0);
  });
});
