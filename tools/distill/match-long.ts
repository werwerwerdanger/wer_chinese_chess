/**
 * match-long —— 长时间无人值守对打（engine 源码直跑，不依赖打包产物）
 *
 * 为什么单独写这个而不用 match.ts：
 *   1) match.ts 只有汇总输出，**没有逐局结果行**，进程一崩这一片就全丢了；
 *   2) 它的局号从 1 开始、种子固定，重启会重下已经下过的局；
 *   3) 它没有"每局累计数"落盘，也没有分片自动重启。
 * 本脚本把每一局的结果 **立即追加** 到输出文件（JSON Lines，含 seed/局号/开局步），
 * 因此：进程被 kill / 断电 / 重启都只损失正在下的那一局，直接重跑同一个命令即可续跑。
 *
 * 断点续跑的关键是"可复现的开局"：
 *   每一局的随机路径只由 (--seed, 局号) 决定，与进程何时启动无关。
 *   续跑时 --start 自动取「已记录局号 + 1」，所以不会重复也不会漏。
 *
 * 用法（本机 / 4080 通用；需要 node_modules）：
 *   node tools/distill/match-long.mjs --out data/match-big/shard-1.jsonl \
 *        --games 12500 --depth 3 --time 200 --model data/model-big2.onnx
 *
 * 独立复核（不依赖 .mjs，时间更长也用这个）：
 *   node tools/distill/run-match-long.mjs --out ... 同上
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Board, generateLegalMoves } from '@wer-chess/engine';
import type { Move } from '@wer-chess/engine';
import { Searcher } from '@wer-chess/engine-ai';
// nnue.ts 故意不从 index.ts 导出（onnxruntime-node 是原生模块，进 web 打包会炸）
import { NnueEvaluator } from '../../engine-ai/src/nnue.ts';

const argv = process.argv.slice(2);
const get = (k: string, d: string) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d;
};

const OUT = get('out', 'data/match-big/shard.jsonl');
const GAMES = Number(get('games', '1000'));
const START_ARG = get('start', '');
const DEPTH = Number(get('depth', '3'));
const TIME_MS = Number(get('time', '200'));
const MODEL = get('model', 'data/model-big2.onnx');
const MODEL2 = get('model2', 'data/model-big.onnx');
const MAX_PLY = Number(get('max-ply', '120'));
const OPENING = Number(get('opening', '4'));
const SEED = Number(get('seed', '20260928'));
const BRIDGE = get('bridge', 'http://127.0.0.1:8788');

interface Player {
  name: string;
  move(b: Board, depth: number, timeMs: number): Promise<Move | null>;
}

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

/**
 * 每局独立随机源：只用 (SEED, 局号) 派生，保证续跑时可复现。
 * mulberry32 —— 32 位、无 BigInt、足够开局随机。
 */
function rngFor(gameIndex: number): () => number {
  let a = (SEED ^ Math.imul(gameIndex + 1, 0x9e3779b1)) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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
    if (!mv) return board.turn === 0 ? 'black' : 'red';
    board.makeMove(mv);
  }
  return 'draw';
}

/** 已下过的局号集合（按 g 字段去重；坏行直接跳过，不阻止续跑） */function readDone(): Set<number> {
  const done = new Set<number>();
  if (!existsSync(OUT)) return done;
  const text = readFileSync(OUT, 'utf8');
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const o = JSON.parse(line) as { g?: number };
      if (typeof o.g === 'number') done.add(o.g);
    } catch {
      // 断电/被杀可能留下半行，忽略即可（那一局会重下）
    }
  }
  return done;
}

function fmt(n: number): string {
  return n.toFixed(1);
}

async function main() {
  // onnxruntime resolves the model path against the *process* cwd, which is not
  // necessarily the repo root (the launcher sets it, but a manual run from a
  // subdirectory would silently fail 30s later with "worker init failed").
  const resolveModel = (p: string) => (path.isAbsolute(p) ? p : path.resolve(process.cwd(), p));
  const nn = new NnueEvaluator(resolveModel(MODEL));
  const nn2 = new NnueEvaluator(resolveModel(MODEL2));
  const e2 = nn2;
  const student = searchPlayer(`NNUE(${MODEL})`, (b) => nn.evalBoard(b));
  const opp = searchPlayer(`NNUE(${MODEL2})`, (b) => e2.evalBoard(b));

  const done = readDone();
  // --start 显式给的优先级最高；否则接在已有记录后面
  let g0 = START_ARG !== '' ? Number(START_ARG) : 0;
  if (START_ARG === '' && done.size > 0) {
    let maxG = -1;
    for (const g of done) if (g > maxG) maxG = g;
    g0 = maxG + 1;
  }

  let w = 0, d = 0, l = 0;
  for (const line of existsSync(OUT) ? readFileSync(OUT, 'utf8').split('\n') : []) {
    if (!line) continue;
    try {
      const o = JSON.parse(line) as { r?: string };
      if (o.r === 'new') w++; else if (o.r === 'draw') d++; else if (o.r === 'old') l++;
    } catch { /* ignore */ }
  }

  console.log(`[long] model=${MODEL} vs ${MODEL2}`);
  console.log(`[long] depth=${DEPTH} time=${TIME_MS}ms maxPly=${MAX_PLY} opening=${OPENING} seed=${SEED}`);
  console.log(`[long] out=${OUT}  already=${done.size}  next g=${g0}  total=${GAMES}`);
  console.log(`[long] so far  new=${w} draw=${d} old=${l}`);

  const t0 = Date.now();
  let sinceLog = Date.now();
  let session = 0;
  for (let g = g0; g < GAMES; g++) {
    if (done.has(g)) continue;
    session++;
    const studentPlaysRed = g % 2 === 0;
    const rng = rngFor(g);
    const t1 = Date.now();
    let res: Outcome | null = null;
    try {
      res = await playGame(
        studentPlaysRed ? student : opp,
        studentPlaysRed ? opp : student,
        DEPTH, TIME_MS, OPENING, rng,
      );
    } catch (err) {
      console.error(`[long] 局 ${g + 1} 异常: ${(err as Error).message}`);
      res = null;
    }
    const dt = (Date.now() - t1) / 1000;
    const stuRes = res === null ? 'old'
      : res === 'draw' ? 'draw'
      : (res === 'red') === studentPlaysRed ? 'new' : 'old';
    if (stuRes === 'new') w++; else if (stuRes === 'draw') d++; else l++;

    // 每局立即落盘：进程随时被杀也不丢历史。
    // Windows 上监控进程（match-forever.ps1 的进度统计）可能恰好持有读句柄，
    // appendFileSync 会 EBUSY —— 重试几次即可，那一局的结果不能丢。
    const record = JSON.stringify({
      g, r: stuRes, red: studentPlaysRed ? 'new' : 'old',
      dt: Math.round(dt * 1000) / 1000,
      e: nn.callCount + nn2.callCount,
      seed: SEED, depth: DEPTH, time: TIME_MS, opening: OPENING,
      err: res === null ? 'exception' : undefined,
    }) + '\n';
    let saved = false;
    for (let attempt = 0; attempt < 5 && !saved; attempt++) {
      try {
        appendFileSync(OUT, record);
        saved = true;
      } catch (e) {
        if (attempt === 4) throw e;
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== 'EBUSY' && code !== 'EPERM') throw e;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
      }
    }

    // 每 10 局或 30 秒打一行，逻辑与 match.ts 对齐（脚本要用 "N/总共" 抓进度）
    if (g % 10 === 9 || Date.now() - sinceLog > 30000) {
      const n = w + d + l;
      const elapsedMin = (Date.now() - t0) / 60000;
      const perGame = session > 0 ? (Date.now() - t0) / 1000 / session : 0;
      const remain = perGame * Math.max(0, GAMES - 1 - g);
      console.log(`[long] 局 ${g + 1}/${GAMES}  new=${w} draw=${d} old=${l}  `
        + `${fmt(perGame)}s/局  本进程剩余约 ${fmt(remain / 60)} 分钟  累计NN评估=${nn.callCount + nn2.callCount}`);
      sinceLog = Date.now();
      void elapsedMin; void n;
    }
  }

  const rate = (w + 0.5 * d) / Math.max(1, w + d + l);
  const elo = Math.round(-400 * Math.log10(1 / Math.min(0.999, Math.max(0.001, rate)) - 1));
  console.log('='.repeat(60));
  console.log(`[long] 结果: 学生 ${w} 胜 / ${d} 和 / ${l} 负  得分率 ${rate.toFixed(3)}`);
  console.log(`[long] Elo 差: ${elo}  总耗时 ${((Date.now() - t0) / 60000).toFixed(1)} 分钟`);
  nn.dispose();
  nn2.dispose();
}

main();
