/**
 * 新旧引擎对打 —— 报告 Elo 素材
 *
 * 旧引擎：Searcher 默认评估（子力+PST）
 * 新引擎：Searcher + NnueEvaluator（蒸馏 ONNX）
 * 双方同深度/同时间，轮流执红黑，三重复现判和，160 步封顶判和。
 *
 * 用法（esbuild 打包后 node 运行）：
 *   node tools/distill/match.mjs --games 20 --depth 3 --model data/model.onnx
 *
 * 输出：逐局结果 + 新引擎得分率 + Elo 差
 */
import { Board, generateLegalMoves } from '@wer-chess/engine';
import { Searcher } from '@wer-chess/engine-ai';
import { NnueEvaluator } from '../../engine-ai/src/nnue';

const argv = process.argv.slice(2);
const get = (k: string, d: string) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d;
};

const GAMES = Number(get('games', '20'));
const DEPTH = Number(get('depth', '3'));
const TIME_MS = Number(get('time', '60000'));
const MODEL = get('model', 'data/model.onnx');
const MAX_PLY = Number(get('max-ply', '160'));
const OPENING_PLIES = Number(get('opening', '4'));

type Outcome = 'new' | 'old' | 'draw';

/** 一局：newPlaysRed 指定新引擎执红还是黑；openingPlies 先随机走 N 步制造开局差异 */
function playGame(nn: NnueEvaluator, newPlaysRed: boolean, depth: number, timeMs: number, openingPlies: number, rng: () => number): Outcome {
  const board = new Board();
  const rep = new Map<string, number>();
  const evalFn = (b: typeof board) => nn.evalBoard(b);

  // 开局随机扰动：双方引擎接管前随机走几步（只走合法着，避开直接送将由合法性保证）
  for (let i = 0; i < openingPlies; i++) {
    const legal = generateLegalMoves(board, board.turn);
    if (legal.length === 0) break;
    board.makeMove(legal[Math.floor(rng() * legal.length)]!);
  }

  for (let ply = 0; ply < MAX_PLY; ply++) {
    const legal = generateLegalMoves(board, board.turn);
    if (legal.length === 0) {
      // 无合法走子 = 当前方负（将死或困毙，象棋规则困毙也判负）
      return board.turn === (newPlaysRed ? 0 : 1) ? 'old' : 'new';
    }
    const fen = board.toFen();
    const cnt = (rep.get(fen) ?? 0) + 1;
    rep.set(fen, cnt);
    if (cnt >= 3) return 'draw'; // 三重复现

    const newToMove = (board.turn === 0) === newPlaysRed;
    const s = new Searcher(board, 1 << 17, newToMove ? evalFn : undefined);
    const r = s.search(depth, timeMs);
    if (!r.bestMove) {
      return newToMove ? 'old' : 'new';
    }
    board.makeMove(r.bestMove);
  }
  return 'draw';
}

function eloDelta(scoreRate: number): number {
  const w = Math.min(0.99, Math.max(0.01, scoreRate));
  return Math.round(-400 * Math.log10(1 / w - 1));
}

async function main() {
  console.log(`[match] 新引擎=NNUE蒸馏模型(${MODEL})  旧引擎=子力+PST`);
  console.log(`[match] ${GAMES} 局  depth=${DEPTH}  time=${TIME_MS}ms  maxPly=${MAX_PLY}  opening=${OPENING_PLIES}随机步`);
  const nn = new NnueEvaluator(MODEL);
  // 可复现随机源（--seed 可改）
  let seed = Number(get('seed', '20260928'));
  const rng = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  let score = 0; // 新引擎得分（胜1平0.5负0）
  let newWins = 0, oldWins = 0, draws = 0;
  const t0 = Date.now();

  for (let g = 0; g < GAMES; g++) {
    const newPlaysRed = g % 2 === 0;
    const t1 = Date.now();
    const res = playGame(nn, newPlaysRed, DEPTH, TIME_MS, OPENING_PLIES, rng);
    const dt = ((Date.now() - t1) / 1000).toFixed(0);
    if (res === 'new') { score += 1; newWins++; }
    else if (res === 'draw') { score += 0.5; draws++; }
    else oldWins++;
    const plies = newPlaysRed ? '新执红' : '新执黑';
    console.log(`[match] 局 ${g + 1}/${GAMES}  ${res === 'draw' ? '和' : res + '胜'}  (${plies}, ${dt}s)  ` +
      `累计 新${newWins} 和${draws} 旧${oldWins}  nn评估次数=${nn.callCount}`);
  }

  const rate = score / GAMES;
  console.log('='.repeat(60));
  console.log(`[match] 结果: 新引擎 ${newWins} 胜 / ${draws} 和 / ${oldWins} 负  得分率 ${rate.toFixed(3)}`);
  console.log(`[match] Elo 差（新-旧）: ${eloDelta(rate)}  总耗时 ${((Date.now() - t0) / 60000).toFixed(1)} 分钟`);
  console.log(`[match] NN 评估总次数 ${nn.callCount}（含缓存命中前）`);
  nn.dispose();
}

main();
