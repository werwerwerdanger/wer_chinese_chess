/**
 * UCI 坐标换算金标准 — Pikafish 适配器的走法坐标必须与本引擎格编号互逆
 *
 * Pikafish UCI 坐标：file a-i（列 0-8），rank 0-9（rank 0 = 红方底线 = row 9）
 * 引擎格编号：sq = row * 9 + col（row 0 = 黑方底线顶部）
 * 换算：row = 9 - rank, col = file - 'a'
 */
import { describe, it, expect } from 'vitest';
import { Board, Color, generateLegalMoves, INITIAL_FEN } from '@wer-chess/engine';

/** 与 web/src/engine-adapters/pikafish-adapter.ts 保持一致 */
function sqToUci(sqIdx: number): string {
  const row = Math.floor(sqIdx / 9);
  const col = sqIdx % 9;
  return `${String.fromCharCode(97 + col)}${9 - row}`;
}

function uciToSq(s: string): number {
  const col = s.charCodeAt(0) - 97;
  const rank = Number(s[1]);
  return (9 - rank) * 9 + col;
}

describe('UCI 坐标换算', () => {
  it('开局所有合法走法 uci 往返无损', () => {
    const board = new Board(INITIAL_FEN);
    for (const m of generateLegalMoves(board, Color.Red)) {
      const u = sqToUci(m.from) + sqToUci(m.to);
      expect(uciToSq(u.slice(0, 2)), `from of ${u}`).toBe(m.from);
      expect(uciToSq(u.slice(2, 4)), `to of ${u}`).toBe(m.to);
    }
  });

  it('经典着法语义抽查：炮二平五 = h2e2（红方行棋）', () => {
    // 红炮 (7,7) 平移到 (7,4)：col7 = file h，row7 = rank 2
    expect(sqToUci(7 * 9 + 7)).toBe('h2');
    expect(sqToUci(7 * 9 + 4)).toBe('e2');
  });

  it('红兵挺一步 = a3a4 方向正确', () => {
    // (6,0) → (5,0)：c 列兵
    expect(sqToUci(6 * 9 + 0)).toBe('a3');
    expect(sqToUci(5 * 9 + 0)).toBe('a4');
  });

  it('黑方 rank 映射：黑车初始位 (0,8) = i9', () => {
    expect(sqToUci(0 * 9 + 8)).toBe('i9');
  });
});
