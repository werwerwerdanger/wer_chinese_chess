/**
 * 引擎对打 —— 报告 Elo 素材
 *
 * 学生引擎：Searcher + NnueEvaluator（蒸馏 ONNX）
 * 对手（--opp）：
 *   old      —— Searcher 默认评估（子力+PST），默认，用于量化蒸馏模型相对旧引擎的提升
 *   pikafish —— Pikafish 经桥接（tools/pikafish/bridge.mjs :8788），教师基线
 * 双方同深度，轮流执红黑，三重复现判和，160 步封顶判和。
 *
 * 用法（esbuild 打包后 node 运行）：
 *   node tools/distill/match.mjs --games 20 --depth 3 --model data/model.onnx [--opp pikafish]
 *
 * 输出：逐局结果 + 学生得分率 + Elo 差
 */
import { Board, generateLegalMoves } from '@wer-chess/engine';
import type { Move } from '@wer-chess/engine';
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
/** opp=nnue 时的对手模型（通常传上一代最佳，做"新版 vs 老版"晋级赛） */
const MODEL2 = get('model2', 'data/model.onnx');
const MAX_PLY = Number(get('max-ply', '160'));
const OPENING_PLIES = Number(get('opening', '4'));
const OPP = get('opp', 'old'); // old | pikafish | nnue
const BRIDGE = get('bridge', 'http://127.0.0.1:8788');

interface Player {
  name: string;
  move(b: Board, depth: number, timeMs: number): Promise<Move | null>;
}

/** 本地搜索玩家；evalFn 传入则用 NNUE，否则用内置子力+PST */
function searchPlayer(name: string, evalFn?: (b: Board) => number): Player {
  return {
    name,
    async move(b, depth, timeMs) {
      const s = new Searcher(b, 1 << 17, evalFn);
      const r = s.search(depth, timeMs);
      return r.bestMove ?? null;
    },
  };
}

/** UCI "h2e2" → 引擎 Move（row = 9 - rank, col = file - 'a'），非法返回 null */
function uciToMove(b: Board, u: string): Move | null {
  if (!/^[a-i][0-9][a-i][0-9]$/.test(u)) return null;
  const from = (9 - Number(u[1])) * 9 + (u.charCodeAt(0) - 97);
  const to = (9 - Number(u[3])) * 9 + (u.charCodeAt(2) - 97);
  return generateLegalMoves(b, b.turn).find((m) => m.from === from && m.to === to) ?? null;
}

/** Pikafish 玩家：经桥接 /think */
function pikafishPlayer(): Player {
  return {
    name: `Pikafish(${BRIDGE})`,
    async move(b, depth) {
      const resp = await fetch(`${BRIDGE}/think`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fen: b.toFen(), depth }),
      });
      const r = (await resp.json()) as { move?: string; error?: string };
      if (!resp.ok || !r.move) throw new Error(r.error ?? `bridge HTTP ${resp.status}`);
      return uciToMove(b, r.move);
    },
  };
}

type Outcome = 'red' | 'black' | 'draw';

/** 一局：红黑玩家对决；openingPlies 先随机走 N 步制造开局差异 */
async function playGame(
  red: Player, black: Player,
  depth: number, timeMs: number, openingPlies: number, rng: () => number,
): Promise<Outcome> {
  const board = new Board();
  const rep = new Map<string, number>();

  for (let i = 0; i < openingPlies; i++) {
    const legal = generateLegalMoves(board, board.turn);
    if (legal.length === 0) break;
    board.makeMove(legal[Math.floor(rng() * legal.length)]!);
  }

  for (let ply = 0; ply < MAX_PLY; ply++) {
    const legal = generateLegalMoves(board, board.turn);
    if (legal.length === 0) {
      // 无合法走子 = 当前方负（将死或困毙，象棋规则困毙也判负）
      return board.turn === 0 ? 'black' : 'red';
    }
    const fen = board.toFen();
    const cnt = (rep.get(fen) ?? 0) + 1;
    rep.set(fen, cnt);
    if (cnt >= 3) return 'draw'; // 三重复现

    const cur = board.turn === 0 ? red : black;
    const mv = await cur.move(board, depth, timeMs);
    if (!mv) {
      return board.turn === 0 ? 'black' : 'red';
    }
    board.makeMove(mv);
  }
  return 'draw';
}

function eloDelta(scoreRate: number): number {
  const w = Math.min(0.99, Math.max(0.01, scoreRate));
  return Math.round(-400 * Math.log10(1 / w - 1));
}

async function main() {
  const nn = new NnueEvaluator(MODEL);
  const student = searchPlayer(`NNUE蒸馏(${MODEL})`, (b) => nn.evalBoard(b));

  let opp: Player;
  let nn2: NnueEvaluator | null = null;
  if (OPP === 'pikafish') {
    opp = pikafishPlayer();
  } else if (OPP === 'nnue') {
    // 新版 vs 老版：双方都走 NNUE 评估 + 同深度搜索
    nn2 = new NnueEvaluator(MODEL2);
    const e2 = nn2;
    opp = searchPlayer(`NNUE(${MODEL2})`, (b) => e2.evalBoard(b));
  } else {
    opp = searchPlayer('子力+PST');
  }

  console.log(`[match] 学生=${student.name}  对手=${opp.name}`);
  console.log(`[match] ${GAMES} 局  depth=${DEPTH}  time=${TIME_MS}ms  maxPly=${MAX_PLY}  opening=${OPENING_PLIES}随机步`);

  // 可复现随机源（--seed 可改）
  let seed = Number(get('seed', '20260928'));
  const rng = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  let score = 0; // 学生得分（胜1平0.5负0）
  let stuWins = 0, oppWins = 0, draws = 0;
  const t0 = Date.now();

  for (let g = 0; g < GAMES; g++) {
    const studentPlaysRed = g % 2 === 0;
    const t1 = Date.now();
    let res: Outcome;
    try {
      res = await playGame(
        studentPlaysRed ? student : opp,
        studentPlaysRed ? opp : student,
        DEPTH, TIME_MS, OPENING_PLIES, rng,
      );
    } catch (err) {
      console.error(`[match] 局 ${g + 1} 异常: ${(err as Error).message}`);
      oppWins++;
      continue;
    }
    const dt = ((Date.now() - t1) / 1000).toFixed(0);
    const stuRes = res === 'draw' ? 'draw' : (res === 'red') === studentPlaysRed ? 'new' : 'old';
    if (stuRes === 'new') { score += 1; stuWins++; }
    else if (stuRes === 'draw') { score += 0.5; draws++; }
    else oppWins++;
    const plies = studentPlaysRed ? '学生执红' : '学生执黑';
    console.log(`[match] 局 ${g + 1}/${GAMES}  ${res === 'draw' ? '和' : stuRes + '胜'}  (${plies}, ${dt}s)  ` +
      `累计 学生${stuWins} 和${draws} 对手${oppWins}  nn评估次数=${nn.callCount}`);
  }

  const rate = score / GAMES;
  console.log('='.repeat(60));
  console.log(`[match] 结果: 学生 ${stuWins} 胜 / ${draws} 和 / ${oppWins} 负  得分率 ${rate.toFixed(3)}`);
  console.log(`[match] Elo 差（学生-${OPP}）: ${eloDelta(rate)}  总耗时 ${((Date.now() - t0) / 60000).toFixed(1)} 分钟`);
  console.log(`[match] NN 评估总次数 ${nn.callCount}（含缓存命中前）`);
  nn.dispose();
  if (nn2) nn2.dispose();
}

main();
