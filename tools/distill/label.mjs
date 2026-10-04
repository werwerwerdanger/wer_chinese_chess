/**
 * 蒸馏管线②—— Pikafish 教师批量标注
 *
 * 前置：bridge.mjs 已启动（含 /eval-batch 接口）
 * 用法：
 *   node tools/distill/label.mjs --in data/positions.txt --out data/labeled.txt --depth 14
 *
 * 输出格式（每行）：fen ; score_cp   （score 已转为红方视角）
 * 支持断点续传：重启后自动跳过已标注的局面。
 *
 * 失败的局面（引擎崩溃/非法 FEN/内存压力下 spawn 失败）会写到 <out>.failed.txt，
 * 带原因。重跑本脚本时会自动重试它们（因为不在 <out> 的 done 集合里）。
 * ⚠️ 失败原因以前只累加计数、不落盘，导致 2000 条静默丢失且无从诊断 —— 别再去掉这行。
 */
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';

const argv = process.argv.slice(2);
const get = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d;
};
const IN = get('in', 'data/positions.txt');
const OUT = get('out', 'data/labeled.txt');
const FAILED = `${OUT}.failed.txt`;
const BATCH = Number(get('batch', '32'));
const DEPTH = Number(get('depth', '14'));
const BRIDGE = get('bridge', 'http://127.0.0.1:8788');

if (!existsSync(IN)) {
  console.error(`[label] 找不到输入文件 ${IN}`);
  process.exit(1);
}

const fens = readFileSync(IN, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
console.log(`[label] 输入 ${fens.length} 个局面，教师深度 ${DEPTH}`);

// 断点续传：跳过已标注
const done = new Set();
if (existsSync(OUT)) {
  for (const line of readFileSync(OUT, 'utf8').split('\n')) {
    const i = line.indexOf(';');
    if (i > 0) done.add(line.slice(0, i).trim());
  }
  console.log(`[label] 续传：已有 ${done.size} 条标注，跳过`);
}
const todo = fens.filter((f) => !done.has(f));
console.log(`[label] 待标注 ${todo.length} 个`);

/** Pikafish score 是行棋方视角 → 转红方视角（FEN 第 2 段 w/b） */
function toRedView(fen, scoreCp, mate) {
  const black = fen.split(' ')[1] === 'b';
  if (mate !== null && mate !== undefined) {
    return black ? -mate * 10000 : mate * 10000;
  }
  const cp = scoreCp ?? 0;
  return black ? -cp : cp;
}

let ok = 0;
let fail = 0;
const t0 = Date.now();

for (let i = 0; i < todo.length; i += BATCH) {
  const batch = todo.slice(i, i + BATCH);
  let results;
  try {
    const resp = await fetch(`${BRIDGE}/eval-batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fens: batch, depth: DEPTH }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error ?? `HTTP ${resp.status}`);
    results = data.results;
  } catch (err) {
    console.error(`[label] 桥接出错（${err.message}），5 秒后重试本批…`);
    await new Promise((r) => setTimeout(r, 5000));
    i -= BATCH; // 重试同一批
    continue;
  }

  for (const r of results) {
    if (r.error) {
      fail++;
      appendFileSync(FAILED, `${r.fen}\t${r.error}\n`);
      continue;
    }
    const red = toRedView(r.fen, r.scoreCp, r.mate);
    appendFileSync(OUT, `${r.fen} ; ${red}\n`);
    ok++;
  }

  const dt = (Date.now() - t0) / 1000;
  const doneN = i + batch.length;
  if ((i / BATCH) % 20 === 0 || doneN >= todo.length) {
    const rate = dt / Math.max(1, doneN) * 1000;
    console.log(
      `[label] ${doneN}/${todo.length}  成功 ${ok} 失败 ${fail}  ` +
      `${(dt / 60).toFixed(1)} 分钟  ${rate.toFixed(0)}ms/条  剩余 ${(rate * (todo.length - doneN) / 60000).toFixed(0)} 分钟`,
    );
  }
}

console.log(`[label] 完成：成功 ${ok}，失败 ${fail} → ${OUT}`);
if (fail > 0) {
  console.log(`[label] ⚠ ${fail} 条失败已记入 ${FAILED}（重跑本脚本会自动重试这些局面）`);
}
console.log(`[label] 下一步：python tools/distill/train.py --data ${OUT}`);
