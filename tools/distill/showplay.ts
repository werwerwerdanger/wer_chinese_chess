/**
 * showplay —— 把引擎实际下的棋逐步打出来（含每步搜索分 / 静态评估分）
 *
 * 用途：用户说「AI 怎么那么笨」时，先看它到底在下什么、评分是否合理，
 *       而不是盯着"胜率/Elo"猜。也可以喂一个具体局面（--fen）看它选什么。
 *
 * 用法：
 *   node tools/distill/showplay.mjs                                  # 开局自对弈 40 步，NNUE 蒸馏模型
 *   node tools/distill/showplay.mjs --plies 20 --depth 3
 *   node tools/distill/showplay.mjs --no-nnue                        # 用内置子力+PST 评估对照
 *   node tools/distill/showplay.mjs --fen "rnbakabnr/9/1c5c1/... w"  # 从指定局面开始
 *
 * 输出每行：#步数 走子方 中文着法 | 搜索分（行棋方视角）| 静态评估（红方视角）| 深度 节点 耗时
 */
import { Board, generateLegalMoves, moveToChinese } from '@wer-chess/engine';
import { evaluate, Searcher } from '@wer-chess/engine-ai';
import { NnueEvaluator } from '../../engine-ai/src/nnue';

const argv = process.argv.slice(2);
const get = (k: string, d: string) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d;
};

const MODEL = get('model', 'data/model-best.onnx');
const USE_NNUE = !argv.includes('--no-nnue');
const DEPTH = Number(get('depth', '3'));
const TIME = Number(get('time', '3000'));
const PLIES = Number(get('plies', '40'));
const FEN = get('fen', '');

const nn = USE_NNUE ? new NnueEvaluator(MODEL) : null;
const evalFn = nn ? (b: Board) => nn.evalBoard(b) : evaluate;

const board = FEN ? new Board(FEN) : new Board();
console.log(`[showplay] 评估=${USE_NNUE ? `NNUE(${MODEL})` : '子力+PST'}  depth=${DEPTH} time=${TIME}ms  plies=${PLIES}`);
console.log(`[showplay] 起始 ${board.toFen()}\n`);

let ply = 0;
for (; ply < PLIES; ply++) {
  const legal = generateLegalMoves(board, board.turn);
  if (!legal.length) {
    console.log(`[showplay] ${board.turn === 0 ? '红' : '黑'}方无棋可走 → ${board.turn === 0 ? '黑胜' : '红胜'}`);
    break;
  }
  const searcher = new Searcher(board, 1 << 17, evalFn);
  const r = searcher.search(DEPTH, TIME);
  if (!r.bestMove) break;

  const mv = r.bestMove as { from: number; to: number };
  const staticRed = evalFn(board);                       // 红方视角
  const searchRed = r.score * (board.turn === 0 ? 1 : -1); // 行棋方视角 → 红方视角
  const side = board.turn === 0 ? '红' : '黑';
  console.log(
    `#${String(ply + 1).padStart(3)} ${side} ${moveToChinese(board, mv as never).padEnd(8)} ` +
    `| 搜索 ${searchRed >= 0 ? '+' : ''}${searchRed.toFixed(0)}(红方视角) ` +
    `| 静态 ${staticRed >= 0 ? '+' : ''}${staticRed.toFixed(0)} ` +
    `| 深度 ${r.depth} 节点 ${r.nodes} ${r.timeMs}ms`,
  );
  board.makeMove(mv as never);
}

console.log(`\n[showplay] 结束局面 ${board.toFen()}`);
console.log('[showplay] 提示：静态分（红方视角）大幅偏离 0 而着法看着没道理时，是评估函数的盲点；');
console.log('           搜索分与静态分在同一局面差很多，才是搜索层的问题。');
nn?.dispose();
