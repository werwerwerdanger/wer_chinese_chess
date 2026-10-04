/**
 * evolve-plot —— 把 data/evolve-log.txt 画成进化曲线（零依赖，纯手搓 SVG）
 *
 * 用法：
 *   node tools/distill/evolve-plot.mjs [--log data/evolve-log.txt] [--out report.html] [--md summary.md]
 *
 * 日志有两种行格式（历史原因）：
 *   1) 早期：`gen1  Elo=-127  PROMOTED  31.0min  data/model-gen1.onnx`
 *      —— Elo 是「vs 旧引擎（子力+PST）」的绝对分；kept 行第三段写的是当前最佳的 Elo
 *   2) 中期起：`gen33  Elo_vs_prev=+17  cumulative=+17  PROMOTED  141.2min  ...`
 *      —— 增量分 + 该阶段累计分（晋级赛 Gate，新代 vs 上一代最佳）
 *
 * 画法：把「累计实力」接成一条链 —— 阶段1末尾的最佳 = 基线 0（已追平子力+PST 引擎），
 * 之后每个阶段用它的 cumulative 往上叠，得到「相对子力+PST 基线」的总 Elo。
 */
import { readFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const get = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d;
};
const LOG = get('log', 'data/evolve-log.txt');
const OUT = get('out', '');
const MD = get('md', '');

const LINE_RE = /gen(\d+)\s+(Elo_vs_prev=(?<d1>[+-]?\d+)\s+cumulative=(?<c1>[+-]?\d+)|Elo=(?<d2>[+-]?\d+))\s+(?<st>PROMOTED|kept|KEPT)(?:\s+(?<keep>[+-]?\d+))?\s+(?<min>[\d.]+)min\s+(?<model>\S+)/;

const entries = [];
for (const raw of readFileSync(LOG, 'utf8').split('\n')) {
  const line = raw.trim();
  if (!line) continue;
  const m = LINE_RE.exec(line);
  if (!m) { console.warn('[evolve-plot] 跳过无法解析的行:', line.slice(0, 90)); continue; }
  const g = m.groups;
  const isDelta = g.d1 !== undefined;
  entries.push({
    ts: line.slice(0, 24),
    gen: Number(m[1]),
    kind: isDelta ? 'delta' : 'abs',
    elo: Number(isDelta ? g.d1 : g.d2),
    cum: isDelta ? Number(g.c1) : null,
    best: g.keep !== undefined ? Number(g.keep) : null,
    promoted: /PROMOTED/.test(g.st),
    min: Number(g.min),
    model: g.model,
  });
}

if (!entries.length) { console.error('[evolve-plot] 没有可用数据'); process.exit(1); }

// ---- 阶段切分 ----
// 1) 行格式变化（abs → delta）必然是新阶段；
// 2) 同为 delta，但 cumulative 对不上「上一代累计 + 上一代增量」→ 说明中途重启了
//    （重启后从当时的最佳模型重新累计，公式里的 base 要抬高一级）
const phases = [];
let prevCum = null, prevElo = 0, prevPromoted = false;
for (const e of entries) {
  let newPhase = false;
  const last = phases[phases.length - 1];
  if (!last) newPhase = true;
  else if (last.kind !== e.kind) newPhase = true;
  else if (e.kind === 'delta') {
    // cum_n = cum_{n-1} + (本代晋级 ? 本代增量 : 0)
    const expected = (prevCum ?? 0) + (e.promoted ? e.elo : 0);
    if (e.cum !== expected) newPhase = true;
  }
  if (newPhase) phases.push({ kind: e.kind, items: [e], restarted: phases.length > 0 });
  else last.items.push(e);
  prevCum = e.cum; prevElo = e.elo; prevPromoted = e.promoted;
}

// ---- 接链：算「相对子力+PST 基线」的累计实力 ----
let base = 0;
for (const ph of phases) {
  if (ph.kind === 'abs') {
    // 阶段1：直接就是相对基线的分数，取 running best 作为阶段末实力
    for (const e of ph.items) e.strength = e.best !== null && !e.promoted ? e.best : Math.max(e.elo, e.best ?? -Infinity);
    ph.endStrength = Math.max(...ph.items.map((e) => (e.best !== null && !e.promoted ? e.best : e.elo)));
  } else {
    for (const e of ph.items) e.strength = base + e.cum;
    ph.endStrength = base + ph.items[ph.items.length - 1].cum;
  }
  base = ph.endStrength;
}
const totalElo = base;

// ---- 统计 ----
const promoted = entries.filter((e) => e.promoted).length;
const stats = {
  gens: entries.length,
  promoted,
  kept: entries.length - promoted,
  minutes: entries.reduce((a, e) => a + e.min, 0),
  deltas: entries.filter((e) => e.kind === 'delta').map((e) => e.elo),
};
const avgDelta = stats.deltas.length ? stats.deltas.reduce((a, b) => a + b, 0) / stats.deltas.length : 0;

// ================= 画图 =================
const W = 1080, H = 560, PAD = { l: 64, r: 150, t: 54, b: 62 };
const plotW = W - PAD.l - PAD.r, plotH = H - PAD.t - PAD.b;
const gens = entries.map((e) => e.gen);
const gMin = Math.min(...gens), gMax = Math.max(...gens);
const sMin = Math.min(0, ...entries.map((e) => e.strength));
const sMax = Math.max(0, ...entries.map((e) => e.strength));
const yLo = Math.floor((sMin - 40) / 50) * 50, yHi = Math.ceil((sMax + 40) / 50) * 50;
const X = (g) => PAD.l + ((g - gMin) / (gMax - gMin)) * plotW;
const Y = (s) => PAD.t + plotH - ((s - yLo) / (yHi - yLo)) * plotH;

const xTicks = [];
for (let g = Math.ceil(gMin / 5) * 5; g <= gMax; g += 5) xTicks.push(g);
const yTicks = [];
for (let v = yLo; v <= yHi; v += 50) yTicks.push(v);

const FONT = "-apple-system,'Segoe UI','Microsoft YaHei',sans-serif";
const parts = [];
parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="${FONT}">`);
parts.push(`<rect width="${W}" height="${H}" fill="#ffffff"/>`);
parts.push(`<text x="${PAD.l}" y="26" font-size="18" font-weight="700" fill="#111">迭代蒸馏进化曲线（学生 NNUE vs Pikafish 教师，{gens} 代）</text>`);
parts.push(`<text x="${PAD.l}" y="44" font-size="12" fill="#666">纵轴 = 相对「子力+PST 基线引擎」的 Elo（链式累加）；每代 = 自对弈生成数据 → 重新训练 → 与上一代最佳晋级赛</text>`);

// 阶段底色 + 标注
const phaseColors = ['#f4f6fa', '#eef7f1', '#fdf5ec'];
phases.forEach((ph, i) => {
  const gs = ph.items.map((e) => e.gen);
  const x0 = X(Math.min(...gs)) - 12, x1 = X(Math.max(...gs)) + 12;
  parts.push(`<rect x="${x0.toFixed(1)}" y="${PAD.t}" width="${Math.max(2, x1 - x0).toFixed(1)}" height="${plotH}" fill="${phaseColors[i % 3]}"/>`);
  parts.push(`<text x="${((x0 + x1) / 2).toFixed(1)}" y="${PAD.t - 10}" font-size="12" fill="#8a8f98" text-anchor="middle">${ph.kind === 'abs' ? `阶段${i + 1}：vs 基线绝对分（gen${gs[0]}–${gs[gs.length - 1]}）` : `阶段${i + 1}：晋级赛累计（gen${gs[0]}–${gs[gs.length - 1]}）`}</text>`);
});

// 网格
for (const v of yTicks) {
  const y = Y(v);
  parts.push(`<line x1="${PAD.l}" y1="${y.toFixed(1)}" x2="${PAD.l + plotW}" y2="${y.toFixed(1)}" stroke="${v === 0 ? '#b9bfc9' : '#e8ebf0'}" stroke-width="1"/>`);
  parts.push(`<text x="${PAD.l - 8}" y="${(y + 4).toFixed(1)}" font-size="11" fill="#6b7280" text-anchor="end">${v > 0 ? '+' : ''}${v}</text>`);
}
for (const g of xTicks) {
  const x = X(g);
  parts.push(`<line x1="${x.toFixed(1)}" y1="${PAD.t}" x2="${x.toFixed(1)}" y2="${PAD.t + plotH}" stroke="#eef0f4" stroke-width="1"/>`);
  parts.push(`<text x="${x.toFixed(1)}" y="${PAD.t + plotH + 18}" font-size="11" fill="#6b7280" text-anchor="middle">${g}</text>`);
}
parts.push(`<text x="${PAD.l + plotW / 2}" y="${H - 14}" font-size="12" fill="#6b7280" text-anchor="middle">代数（gen）</text>`);
parts.push(`<text x="16" y="${PAD.t + plotH / 2}" font-size="12" fill="#6b7280" text-anchor="middle" transform="rotate(-90 16 ${PAD.t + plotH / 2})">累计 Elo（vs 子力+PST 基线）</text>`);

// 折线
const pts = entries.map((e) => `${X(e.gen).toFixed(1)},${Y(e.strength).toFixed(1)}`);
parts.push(`<polyline points="${pts.join(' ')}" fill="none" stroke="#2563eb" stroke-width="2.5" stroke-linejoin="round"/>`);

// 数据点：晋级=实心蓝、保留=空心灰
entries.forEach((e) => {
  const x = X(e.gen), y = Y(e.strength);
  if (e.promoted) parts.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.1" fill="#2563eb"/>`);
  else parts.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.6" fill="#fff" stroke="#9aa3af" stroke-width="1.6"/>`);
});

// 关键注释
const first = entries[0], last = entries[entries.length - 1];
const annos = [
  { x: X(first.gen), y: Y(first.strength), text: `起点 ${first.strength > 0 ? '+' : ''}${first.strength}`, dy: 18, anchor: 'start' },
  { x: X(last.gen), y: Y(last.strength), text: `gen${last.gen}：+${totalElo}`, dy: -12, anchor: 'end' },
];
for (const a of annos) {
  parts.push(`<text x="${a.x.toFixed(1)}" y="${(a.y + a.dy).toFixed(1)}" font-size="12" font-weight="600" fill="#1f2937" text-anchor="${a.anchor}">${a.text}</text>`);
}

// 图例
const lx = PAD.l + plotW + 16;
parts.push(`<g font-size="12" fill="#374151">`);
parts.push(`<circle cx="${lx + 6}" cy="${PAD.t + 8}" r="4" fill="#2563eb"/><text x="${lx + 18}" y="${PAD.t + 12}">晋级 PROMOTED</text>`);
parts.push(`<circle cx="${lx + 6}" cy="${PAD.t + 30}" r="3.4" fill="#fff" stroke="#9aa3af" stroke-width="1.6"/><text x="${lx + 18}" y="${PAD.t + 34}">保留 KEPT</text>`);
parts.push(`<text x="${lx}" y="${PAD.t + 66}" font-size="12" fill="#6b7280">代/平均耗时</text>`);
parts.push(`<text x="${lx}" y="${PAD.t + 84}" font-size="13" font-weight="700" fill="#111">${(stats.minutes / stats.gens).toFixed(1)} min</text>`);
parts.push(`<text x="${lx}" y="${PAD.t + 112}" font-size="12" fill="#6b7280">晋级 / 保留</text>`);
parts.push(`<text x="${lx}" y="${PAD.t + 130}" font-size="13" font-weight="700" fill="#111">${stats.promoted} / ${stats.kept}</text>`);
parts.push(`<text x="${lx}" y="${PAD.t + 158}" font-size="12" fill="#6b7280">平均单代增量</text>`);
parts.push(`<text x="${lx}" y="${PAD.t + 176}" font-size="13" font-weight="700" fill="#111">${avgDelta >= 0 ? '+' : ''}${avgDelta.toFixed(1)} Elo</text>`);
parts.push(`<text x="${lx}" y="${PAD.t + 204}" font-size="12" fill="#6b7280">总耗时</text>`);
parts.push(`<text x="${lx}" y="${PAD.t + 222}" font-size="13" font-weight="700" fill="#111">${(stats.minutes / 60).toFixed(1)} h</text>`);
parts.push(`</g>`);
parts.push(`</svg>`);
const svg = parts.join('\n');

// ---- 输出 ----
if (MD) {
  const rows = entries
    .map((e) => `| ${e.gen} | ${e.kind === 'abs' ? e.elo : (e.elo >= 0 ? '+' : '') + e.elo} | ${e.cum !== null ? (e.cum >= 0 ? '+' : '') + e.cum : '—'} | ${e.promoted ? 'PROMOTED' : 'KEPT'} | ${e.strength} | ${e.min.toFixed(1)} |`)
    .join('\n');
  const md = `# 迭代蒸馏实验记录（${stats.gens} 代）

- 总耗时：${(stats.minutes / 60).toFixed(1)} 小时（平均 ${(stats.minutes / stats.gens).toFixed(1)} min/代）
- 晋级 ${stats.promoted} 代 / 保留 ${stats.kept} 代
- 相对「子力+PST 基线引擎」的累计实力：**${totalElo > 0 ? '+' : ''}${totalElo} Elo**
- 平均单代增量：${avgDelta >= 0 ? '+' : ''}${avgDelta.toFixed(1)} Elo

| 代数 | 本代 vs 上一代最佳 | 阶段累计 | Gate | 累计实力(vs 基线) | 耗时(min) |
|---:|---:|---:|:--|---:|---:|
${rows}
`;
  writeFileSync(MD, md);
  console.log(`[evolve-plot] 已写 ${MD}`);
}

if (OUT) {
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>迭代蒸馏进化曲线</title>
<style>body{margin:0;padding:24px;background:#f7f8fa;font-family:${FONT}}
.card{background:#fff;border-radius:12px;padding:16px;box-shadow:0 2px 12px rgba(17,24,39,.06);display:inline-block}</style>
</head><body><div class="card">${svg}</div></body></html>`;
  writeFileSync(OUT, html);
  console.log(`[evolve-plot] 已写 ${OUT}`);
}

console.log(`\n[evolve-plot] ${stats.gens} 代 | 晋级 ${stats.promoted} / 保留 ${stats.kept} | 累计 Elo(vs 基线) +${totalElo} | 总耗时 ${(stats.minutes / 60).toFixed(1)}h`);
for (const ph of phases) console.log(`  阶段 kind=${ph.kind} gen${ph.items[0].gen}..${ph.items[ph.items.length - 1].gen} 末实力 ${ph.endStrength}`);
