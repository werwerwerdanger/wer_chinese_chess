/**
 * match-forever.mjs —— 纯 node 看门狗（与 match-forever.ps1 同逻辑）
 *
 * 为什么还要一个 node 版：沙箱/安全策略经常禁掉 PowerShell 派生进程和 schtasks，
 * 但 node 随便跑。这个进程自己监督 N 个 run-match-long.mjs 子进程：
 *   - 崩溃自动重启（指数退避），连续失败熔断
 *   - 卡死检测（StallMinutes 内没有新结果就杀掉重拉）
 *   - 每局结果早已由子进程落盘 JSONL，重启不丢不重
 *
 * 用法：
 *   node tools/distill/match-forever.mjs --games-per-shard 30000 --parallel 6
 * 查看/停止：另开窗口
 *   node tools/distill/match-forever.mjs --status
 *   node tools/distill/match-forever.mjs --stop
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..', '..');

const argv = process.argv.slice(2);
const get = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d;
};
const has = (k) => argv.includes(`--${k}`);

const GAMES_PER_SHARD = Number(get('games-per-shard', '30000'));
const PARALLEL = Number(get('parallel', '6'));
const OUTDIR = path.resolve(ROOT, get('out', 'data/match-forever'));
const MODEL = path.resolve(ROOT, get('model', 'data/model-big2.onnx'));
const MODEL2 = path.resolve(ROOT, get('model2', 'data/model-big.onnx'));
const DEPTH = Number(get('depth', '3'));
const TIME_MS = Number(get('time', '200'));
const MAX_PLY = Number(get('max-ply', '120'));
const OPENING = Number(get('opening', '4'));
const STALL_MIN = Number(get('stall-minutes', '30'));
const BASE_SEED = Number(get('seed', '10007'));
const MAX_FAILS = Number(get('max-fails', '20'));
const PID_FILE = path.join(OUTDIR, 'supervisor.pid');

const shardFile = (i, ext) => path.join(OUTDIR, `shard-${i}.${ext}`);

/** 统计一个分片：已完成局数（去重）/ 胜和负 / 文件最后修改时间 */
function measure(i) {
  const f = shardFile(i, 'jsonl');
  const st = { done: 0, w: 0, d: 0, l: 0, mtime: 0 };
  if (!existsSync(f)) return st;
  st.mtime = statSync(f).mtimeMs;
  const seen = new Set();
  let text;
  try { text = readFileSync(f, 'utf8'); } catch { return st; } // 写入方持有句柄时偶尔读失败，下轮再看
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const o = JSON.parse(line);
      if (typeof o.g === 'number' && !seen.has(o.g)) {
        seen.add(o.g);
        st.done++;
        if (o.r === 'new') st.w++;
        else if (o.r === 'draw') st.d++;
        else if (o.r === 'old') st.l++;
      }
    } catch { /* 半行，忽略 */ }
  }
  return st;
}

function eloText(rate) {
  if (rate <= 0.001) return '-999 (or worse)';
  if (rate >= 0.999) return '+999 (or better)';
  return (-400 * Math.log10(1 / rate - 1)).toFixed(0);
}

function total(stats) {
  let w = 0, d = 0, l = 0, done = 0;
  for (const s of stats) { w += s.w; d += s.d; l += s.l; done += s.done; }
  const n = w + d + l;
  const rate = n > 0 ? (w + 0.5 * d) / n : 0;
  return { w, d, l, done, rate };
}

// ---------------------------------------------------------------- --stop/--status

if (has('stop') || has('status')) {
  const stats = [];
  for (let i = 1; i <= PARALLEL; i++) stats.push(measure(i));
  const t = total(stats);
  for (let i = 1; i <= PARALLEL; i++) {
    const s = stats[i - 1];
    const ts = s.mtime ? new Date(s.mtime).toLocaleTimeString('en-GB') : 'never';
    console.log(`[forever] shard ${i}: ${s.done}/${GAMES_PER_SHARD}  ${s.w}W/${s.d}D/${s.l}L  last write ${ts}`);
  }
  console.log(`[forever] games ${t.done} / ${PARALLEL * GAMES_PER_SHARD}   ` +
    `new ${t.w}W/${t.d}D/${t.l}L   score ${t.rate.toFixed(4)}   Elo ${eloText(t.rate)}`);
  if (has('stop')) {
    if (existsSync(PID_FILE)) {
      const pid = Number(readFileSync(PID_FILE, 'utf8').trim());
      try { process.kill(pid, 'SIGINT'); console.log(`[forever] sent SIGINT to supervisor ${pid}`); }
      catch (e) { console.log(`[forever] supervisor ${pid} not running (${e.code})`); }
    } else {
      console.log('[forever] no supervisor.pid found');
    }
  }
  process.exit(0);
}

// ---------------------------------------------------------------- supervisor

mkdirSync(OUTDIR, { recursive: true });
const nodeExe = process.execPath;

function launchShard(i) {
  const args = [
    path.join(here, 'run-match-long.mjs'),
    '--out', shardFile(i, 'jsonl'),
    '--games', String(GAMES_PER_SHARD),
    '--depth', String(DEPTH),
    '--time', String(TIME_MS),
    '--model', MODEL,
    '--model2', MODEL2,
    '--opening', String(OPENING),
    '--max-ply', String(MAX_PLY),
    '--seed', String(BASE_SEED + i * 7919),
  ];
  const log = (buf, to) => {
    const lines = buf.toString().split(/\r?\n/);
    for (const l of lines) if (l) process.stdout.write(`[shard-${i}] ${l}\n`);
    void to;
  };
  const child = spawn(nodeExe, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (b) => log(b, 0));
  child.stderr.on('data', (b) => log(b, 1));
  return child;
}

console.log(`[forever] model  = ${MODEL}`);
console.log(`[forever] model2 = ${MODEL2}`);
console.log(`[forever] depth=${DEPTH} time=${TIME_MS}ms opening=${OPENING} maxPly=120`);
console.log(`[forever] ${PARALLEL} shards x ${GAMES_PER_SHARD} games  out=${OUTDIR}`);
console.log(`[forever] stall kill: ${STALL_MIN} min without a new result`);

process.on('SIGINT', () => {
  console.log('[forever] SIGINT -> stopping all shards');
  for (const st of state.values()) {
    if (st.proc && st.proc.exitCode === null) { try { st.proc.kill(); } catch { } }
  }
  setTimeout(() => process.exit(0), 500);
});

const state = new Map();
for (let i = 1; i <= PARALLEL; i++) {
  state.set(i, { proc: null, fails: 0, nextTry: 0, lastDone: -1, lastChange: Date.now() });
}

try { require('node:fs').writeFileSync(PID_FILE, String(process.pid)); } catch { }

const t0 = Date.now();
let lastReport = 0;
let gamesAtStart = 0;
{
  const t = total(Array.from({ length: PARALLEL }, (_, k) => measure(k + 1)));
  gamesAtStart = t.done;
  console.log(`[forever] already ${t.done} games on disk, resuming`);
}

const POLL = 15000;

function tick() {
  const now = Date.now();
  const stats = [];
  for (let i = 1; i <= PARALLEL; i++) stats.push(measure(i));

  let allDone = true;
  for (let i = 1; i <= PARALLEL; i++) {
    if (stats[i - 1].done < GAMES_PER_SHARD) { allDone = false; break; }
  }
  if (allDone) {
    const t = total(stats);
    console.log('='.repeat(60));
    console.log(`[forever] ALL DONE: new ${t.w}W / ${t.d}D / ${t.l}L   score ${t.rate.toFixed(4)}   Elo ${eloText(t.rate)}`);
    try { require('node:fs').unlinkSync(PID_FILE); } catch { }
    process.exit(0);
  }

  for (let i = 1; i <= PARALLEL; i++) {
    const st = state.get(i);
    const s = stats[i - 1];
    const alive = st.proc && st.proc.exitCode === null;

    if (s.done >= GAMES_PER_SHARD) {
      if (alive) { try { st.proc.kill(); } catch { } }
      continue;
    }

    if (alive) {
      if (s.done !== st.lastDone) { st.lastDone = s.done; st.lastChange = now; }
      if (now - st.lastChange > STALL_MIN * 60000) {
        console.log(`[forever] shard ${i} stalled at ${s.done} for ${STALL_MIN} min -> kill pid ${st.proc.pid}`);
        try { st.proc.kill(); } catch { }
      }
      continue;
    }

    if (st.proc && st.proc.exitCode !== null) {
      const code = st.proc.exitCode;
      if (code === 0) { st.fails = 0; st.nextTry = 0; }
      else {
        st.fails++;
        const wait = Math.min(600, 2 ** st.fails * 10) * 1000;
        st.nextTry = now + wait;
        console.log(`[forever] shard ${i} exited code ${code} (fail ${st.fails}/${MAX_FAILS}); retry in ${Math.round(wait / 1000)}s`);
      }
      st.proc = null;
    }

    if (now < st.nextTry) continue;
    if (st.fails >= MAX_FAILS) {
      console.log(`[forever] shard ${i} gave up after ${st.fails} consecutive failures; others continue`);
      continue;
    }
    st.proc = launchShard(i);
    st.lastDone = s.done;
    st.lastChange = now;
    console.log(`[forever] shard ${i} started (pid ${st.proc.pid}) at ${s.done}/${GAMES_PER_SHARD}`);
  }

  if (now - lastReport > 120000) {
    const t = total(stats);
    const perMin = t.done > gamesAtStart ? (t.done - gamesAtStart) / ((now - t0) / 60000) : 0;
    const aim = PARALLEL * GAMES_PER_SHARD;
    const etaH = perMin > 0 ? (aim - t.done) / perMin / 60 : -1;
    console.log(`[forever] ${t.done}/${aim} games  ${perMin.toFixed(1)}/min  new ${t.w}W/${t.d}D/${t.l}L  ` +
      `score ${t.rate.toFixed(3)}  Elo ${eloText(t.rate)}  elapsed ${((now - t0) / 3600000).toFixed(1)}h  ETA ${etaH.toFixed(1)}h`);
    lastReport = now;
  }
}

tick();
setInterval(tick, POLL);
