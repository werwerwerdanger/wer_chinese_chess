/**
 * 中文纵线记谱 — 生成"炮二平五"式着法描述
 *
 * 规则（红方用中文数字一~九，从右往左；黑方用阿拉伯数字1~9，从左往右）：
 * - 格式：[棋子名][起始纵线][动作][目标纵线或步数]
 * - 动作：进/退/平
 * - 车马炮兵直线走子：平X（横移到X线）/进N（纵向N格）
 * - 斜走子（马象仕）：进/退 + 目标纵线
 * - 同列有两个同名子时用"前/后"消歧
 */
import { Color, Piece, type Move } from './types.js';
import { PIECE_NAMES, colOf, rowOf, sq, typeOf, pawnCrossed } from './constants.js';
import type { Board } from './board.js';

const RED_NUMS = ['九', '八', '七', '六', '五', '四', '三', '二', '一']; // col 0..8 → 红方纵线
const BLACK_NUMS = ['9', '8', '7', '6', '5', '4', '3', '2', '1'];        // col 0..8 → 黑方纵线（从黑方右手数）

/** 纵线号：红方从右往左数（col 8 = 一线），黑方从其右手往左数（col 8 = 1线） */
function fileChar(col: number, color: Color): string {
  return color === Color.Red ? RED_NUMS[col]! : BLACK_NUMS[col]!;
}

/** 生成走子的中文纵线记谱。必须在 makeMove 之前调用（需要走子前的局面）。 */
export function moveToChinese(board: Board, move: Move): string {
  const piece = board.at(move.from);
  if (piece === Piece.None) return '??';

  const color = (piece >> 3) & 1;
  const name = PIECE_NAMES[piece]!;
  const fromR = rowOf(move.from), fromC = colOf(move.from);
  const toR = rowOf(move.to), toC = colOf(move.to);

  // 同列同名子消歧：找同列同种类同色棋子
  const disambig = needsDisambiguation(board, move.from, piece);

  // 动作判定
  let action: string;
  let dest: string;

  if (fromC === toC) {
    // 纵向移动：进/退 + 步数（红向上是进，黑向下是进）
    const forward = color === Color.Red ? -1 : 1;
    const steps = Math.abs(toR - fromR);
    action = (toR - fromR) * forward > 0 ? '进' : '退';
    // 步数表述：红方中文数字，黑方阿拉伯数字
    const redSteps = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];
    const s = color === Color.Red ? redSteps[steps - 1] ?? String(steps) : String(steps);
    return `${prefix(disambig, name)}${fileChar(fromC, color)}${action}${s}`;
  }

  if (fromR === toR) {
    // 横向移动：平 + 目标纵线
    action = '平';
    dest = fileChar(toC, color);
  } else {
    // 斜走（马/象/仕）：进/退 + 目标纵线
    const forward = color === Color.Red ? -1 : 1;
    action = (toR - fromR) * forward > 0 ? '进' : '退';
    dest = fileChar(toC, color);
  }

  return `${prefix(disambig, name)}${fileChar(fromC, color)}${action}${dest}`;

  function prefix(d: 'front' | 'back' | null, n: string): string {
    if (d === 'front') return `前${n}`;
    if (d === 'back') return `后${n}`;
    return n;
  }
}

/** 同列有同名同色子 → 返回 front/back（from 在前/后）；否则 null */
function needsDisambiguation(board: Board, from: number, piece: Piece): 'front' | 'back' | null {
  const color = (piece >> 3) & 1;
  void typeOf(piece);
  const fromR = rowOf(from), fromC = colOf(from);
  let other = -1;

  for (let r = 0; r < 10; r++) {
    const s = sq(r, fromC);
    if (s === from) continue;
    if (board.at(s) === piece) { other = s; break; }
  }
  if (other < 0) return null;
  if (typeOf(piece) === 6 && !pawnCrossed(fromR, color)) return null; // 未过河兵不消歧

  // "前"：红方是 row 小的（靠前），黑方是 row 大的
  const forward = color === Color.Red ? -1 : 1;
  const otherR = rowOf(other);
  return (fromR - otherR) * forward > 0 ? 'front' as never : 'back' as never;
}
