/**
 * 蒸馏数据源③ —— 对弈式自生成（下棋与标注一步完成，支持并发）
 *
 * 思路：让引擎对弈（Pikafish vs Pikafish，或 学生NNUE vs Pikafish），
 * Pikafish 每次思考时它的搜索分数就是当前局面的现成标签——
 * 对弈过程中顺产 (fen, score) 对，省掉二次标注流程。
 *
 * --label-all（sp 模式默认开）：学生行棋前也让 Pikafish 评一次分作标签，
 * 全局面覆盖；学生乱走的招 + Pikafish 的惩罚分正是最有训练价值的数据。
 *
 * 用法（esbuild 打包后 node 运行）：
 *   node tools/distill/selfplay.mjs --games 300 --depth 12 [--mode sp] [--parallel 8]
 *
 * 输出格式与 label.mjs 一致：fen ; score_cp（红方视角），train.py 可直接合并 --data。
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import { Board, generateLegalMoves } from '@wer-chess/engine';
import { Searcher } from '@wer-chess/engine-ai';
import { NnueEvaluator } from '../../engine-ai/src/nnue';

const argv = process.argv.slice(2);
const get = (k: string, d: string) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d;
};

const GAMES = Number(get('games', '300'));
const DEPTH = Number(get('depth', '12'));
const OPENING_PLIES = Number(get('opening', '6'));
const MAX_PLY = Number(get('max-ply', '160'));
const OUT = get('out', 'data/labeled-selfplay.txt');
const MODE = get('mode', 'pp'); // pp = Pikafish vs Pikafish；sp = 学生 vs Pikafish
const BRIDGE = get('bridge', 'http://127.0.0.1:8788');
const MODEL = get('model', 'data/model.onnx');
const PARALLEL = Math.max(1, Number(get('parallel', '8')));
const LABEL_ALL = get('label-all', MODE === 'sp' ? 'true' : 'false') === 'true';
const SEED = Number(get('seed', '20260928'));

/** Pikafish score 是行棋方视角 → 转红方视角（与 label.mjs 完全一致） */
function toRedView(fen: string, scoreCp: number | null, mate: number | null): number {
  const black = fen.split(' ')[1] === 'b';
  if (mate !== null && mate !== undefined) return black ? -mate * 10000 : mate * 10000;
  const cp = scoreCp ?? 0;
  return black ? -cp : cp;
}

/** UCI "h2e2" → 引擎 Move */
function uciToMove(b: Board, u: string) {
  if (!/^[a-i][0-9][a-i][0-9]$/.test(u)) return null;
  const from = (9 - Number(u[1])) * 9 + (u.charCodeAt(0) - 97);
  const to = (9 - Number(u[3])) * 9 + (u.charCodeAt(2) - 97);
  return generateLegalMoves(b, b.turn).find((m) => m.from === from && m.to === to) ?? null;
}

/** 调桥接：Pikafish 对 fen 搜索一次，返回走法与红方视角标签 */
async function pikafish(fen: string, depth: number): Promise<{ move: string | null; label: number | null }> {
  const resp = await fetch(`${BRIDGE}/think`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fen, depth }),
  });
  const r = (await resp.json()) as { move?: string; scoreCp?: number | null; mate?: number | null; error?: string };
  if (!resp.ok) throw new Error(r.error ?? `bridge HTTP ${resp.status}`);
  return { move: r.move ?? null, label: r.move ? toRedView(fen, r.scoreCp ?? null, r.mate ?? null) : null };
}

/** 共享状态：单进程事件循环内，无锁安全 */
const nn = MODE === 'sp' ? new NnueEvaluator(MODEL) : null;
const seen = new Set<string>();
const buf: string[] = [];
let labels = 0;
let doneGames = 0;
let draws = 0;
let aborted = 0;
const t0 = Date.now();

function addLabel(fen: string, label: number | null) {
  if (label === null || seen.has(fen)) return;
  seen.add(fen);
  buf.push(`${fen} ; ${label}\n`);
  labels++;
}

function flush() {
  if (buf.length === 0) return;
  appendFileSync(OUT, buf.join(''));
  buf.length = 0;
}

/** 一局对弈。学生为 on-policy 陪练；桥接持续不可用时整局放弃 */
async function playOneGame(g: number): Promise<void> {
  const studentRed = g % 2 === 0; // sp 模式：学生轮换执红黑
  let seed = (SEED + g * 7919) >>> 0;
  const rng = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  const board = new Board();
  const rep = new Map<string, number>();

  for (let i = 0; i < OPENING_PLIES; i++) {
    const legal = generateLegalMoves(board, board.turn);
    if (legal.length === 0) break;
    board.makeMove(legal[Math.floor(rng() * legal.length)]!);
  }

  for (let ply = 0; ply < MAX_PLY; ply++) {
    const legal = generateLegalMoves(board, board.turn);
    if (legal.length === 0) return; // 将死/困毙
    const fen = board.toFen();
    const cnt = (rep.get(fen) ?? 0) + 1;
    rep.set(fen, cnt);
    if (cnt >= 3) { draws++; return; }

    const studentToMove = MODE === 'sp' && (board.turn === 0) === studentRed;
    if (studentToMove) {
      // 学生行棋前请 Pikafish 评一次分当标签（--label-all）
      if (LABEL_ALL) {
        try {
          const r = await pikafish(fen, DEPTH);
          addLabel(fen, r.label);
        } catch { /* 标签失败不影响对局 */ }
      }
      const mv = studentMove(board);
      if (!mv) return;
      board.makeMove(mv);
      continue;
    }

    // Pikafish 走子：分数即标签
    let r: { move: string | null; label: number | null };
    try {
      r = await pikafish(fen, DEPTH);
    } catch (err) {
      throw err; // 交给上层重试整局
    }
    addLabel(fen, r.label);
    const mv = r.move ? uciToMove(board, r.move) : null;
    if (!mv) return;
    board.makeMove(mv);
  }
}

/** 学生（NNUE+本地搜索）走一步；注意同步搜索会阻塞本进程其他协程 */
function studentMove(b: Board) {
  const s = new Searcher(b, 1 << 17, (bb) => nn!.evalBoard(bb));
  const r = s.search(2, 2000); // 学生陪练用浅搜：快，且它的深算意义不大
  return r.bestMove ?? null;
}

async function worker(w: number): Promise<void> {
  for (let g = w; g < GAMES; g += PARALLEL) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await playOneGame(g);
        break;
      } catch (err) {
        if (attempt === 2) {
          aborted++;
          console.error(`[selfplay] 局 ${g + 1} 三次失败放弃: ${(err as Error).message}`);
        } else {
          await new Promise((res) => setTimeout(res, 3000));
        }
      }
    }
    doneGames++;
    flush();
    if (doneGames % 25 === 0 || doneGames === GAMES) {
      const dt = (Date.now() - t0) / 1000;
      const eta = (dt / doneGames) * (GAMES - doneGames);
      console.log(`[selfplay] 局 ${doneGames}/${GAMES}  标签 ${labels} 条  和局 ${draws}  ` +
        `${(dt / 60).toFixed(1)} 分钟  ${(dt / doneGames).toFixed(1)}s/局  剩余约 ${(eta / 60).toFixed(0)} 分钟`);
    }
  }
}

async function main() {
  writeFileSync(OUT, ''); // 清空旧文件（自生成整批重跑比续传简单）
  console.log(`[selfplay] 模式=${MODE === 'pp' ? 'Pikafish vs Pikafish' : '学生NNUE vs Pikafish'}  ` +
    `${GAMES} 局 × ${PARALLEL} 并发  depth=${DEPTH}  opening=${OPENING_PLIES}随机步  labelAll=${LABEL_ALL}  → ${OUT}`);

  await Promise.all(Array.from({ length: PARALLEL }, (_, w) => worker(w)));
  flush();

  const dt = (Date.now() - t0) / 60000;
  console.log('='.repeat(60));
  console.log(`[selfplay] 完成：标签 ${labels} 条（去重后）  和局 ${draws}  放弃 ${aborted}  耗时 ${dt.toFixed(1)} 分钟 → ${OUT}`);
  if (nn) nn.dispose();
}

main();
