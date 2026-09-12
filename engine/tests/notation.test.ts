/**
 * 中文纵线记谱测试
 */
import { describe, it, expect } from 'vitest';
import { Board } from '../src/board.js';
import { generateLegalMoves } from '../src/legality.js';
import { moveToChinese } from '../src/notation.js';
import { sq } from '../src/constants.js';
import type { Move } from '../src/types.js';

function findMove(board: Board, from: [number, number], to: [number, number]): Move {
  const f = sq(from[0], from[1]), t = sq(to[0], to[1]);
  const m = generateLegalMoves(board, board.turn).find((x) => x.from === f && x.to === t);
  if (!m) throw new Error(`no move (${from})→(${to})`);
  return m;
}

describe('中文纵线记谱', () => {
  it('开局：炮二平五（红右炮平中路）', () => {
    const b = new Board();
    // 红右炮在 (7,7)，平到 (7,4)。红方视角：col 7 = 二线，col 4 = 五线
    const m = findMove(b, [7, 7], [7, 4]);
    expect(moveToChinese(b, m)).toBe('炮二平五');
  });

  it('开局：马八进七', () => {
    const b = new Board();
    // 红左马 (9,1) 跳 (7,2)。col 1 = 八线，col 2 = 七线
    const m = findMove(b, [9, 1], [7, 2]);
    expect(moveToChinese(b, m)).toBe('马八进七');
  });

  it('纵向移动：兵三进一', () => {
    const b = new Board();
    // 红兵 (6,6) 前进到 (5,6)。col 6 = 三线，进一格
    const m = findMove(b, [6, 6], [5, 6]);
    expect(moveToChinese(b, m)).toBe('兵三进一');
  });

  it('黑方记谱：卒7进1（阿拉伯数字，从黑方右手数纵线）', () => {
    const b = new Board('rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR b');
    // 黑卒 (3,2) 前进到 (4,2)。黑方视角：col 8=1线 … col 2=7线
    const m = findMove(b, [3, 2], [4, 2]);
    expect(moveToChinese(b, m)).toBe('卒7进1');
  });

  it('黑炮平移：炮8平5', () => {
    const b = new Board('rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR b');
    // 黑右炮 (2,7) 平到 (2,4)。黑方视角：col 7 = 2线？col 8=1 → col 7=2。
    // 经典"炮8平5"是黑左炮：col 1 = 8线 → 平到 col 4 = 5线
    const m = findMove(b, [2, 1], [2, 4]);
    expect(moveToChinese(b, m)).toBe('炮8平5');
  });

  it('纵向多格：车一进二（红右车纵向进两格）', () => {
    // 黑将 (0,3) 红帅 (9,4) 不同列避免照面；红车 (9,8) 进两格
    const b = new Board('3k5/9/9/9/9/9/9/9/9/4K3R w');
    const m = findMove(b, [9, 8], [7, 8]);
    expect(moveToChinese(b, m)).toBe('车一进二');
  });
});
