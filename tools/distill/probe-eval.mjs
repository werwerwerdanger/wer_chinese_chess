/**
 * probe-eval —— 裸评估探针（不搜索，直接喂 FEN 看模型输出）
 *
 * 用途：换模型后快速验证「分数尺度是否正常 / 方向是否正确 / 新旧模型差异」。
 * 编码与 train.py encode_fen、engine-ai/src/nnue.ts 逐位一致：
 *   90 格 × 14 通道 one-hot（通道序 RNBAKCPrnbakcp，行主序 r*9+c）+ 行棋方 1 维（红 w=1）
 *   输出 tanh 分，cp = atanh(tanh分) * 1000
 *
 * 用法：
 *   node tools/distill/probe-eval.mjs --model data/model-best.onnx
 *   node tools/distill/probe-eval.mjs --compare data/model-best.onnx data/model-prev.onnx
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ort = require('onnxruntime-node');

const PIECE_ORDER = 'RNBAKCPrnbakcp';
const VEC_LEN = 90 * 14 + 1;

function encodeFen(fen) {
  const parts = fen.split(' ');
  const rows = parts[0].split('/');
  if (rows.length !== 10) throw new Error(`bad fen rows: ${fen}`);
  const out = new Float32Array(VEC_LEN);
  for (let r = 0; r < 10; r++) {
    let c = 0;
    for (const ch of rows[r]) {
      const d = ch.charCodeAt(0) - 48;
      if (d >= 1 && d <= 9) { c += d; continue; }
      const pi = PIECE_ORDER.indexOf(ch);
      if (pi < 0) throw new Error(`bad char '${ch}' in ${fen}`);
      out[(r * 9 + c) * 14 + pi] = 1;
      c++;
    }
    if (c !== 9) throw new Error(`row width ${c} != 9 in ${fen}`);
  }
  out[VEC_LEN - 1] = parts[1] === 'w' ? 1 : 0;
  return out;
}

/** 红方视角 cp */
async function evalFen(session, fen) {
  const input = new ort.Tensor('float32', encodeFen(fen), [1, VEC_LEN]);
  const res = await session.run({ board: input });
  const t = Math.max(-0.99999, Math.min(0.99999, res.score.data[0]));
  return Math.atanh(t) * 1000;
}

// name = [FEN, 期望（红方视角的大致倾向）]
// ⚠️ 2026-10-05 修正：原「红多一车 / 黑多一车」两条用例的 FEN 其实分别是
//   「红少一车 / 黑少一车」（底线 RNBAKABN1 比初始 RNBAKABNR 少一个车），
//   标签与局面相反 → 一个完全正常的模型会被读成"符号反了"。
//   现已按局面实情重命名，并补上真正的「多一车」。
// 带「(镜像)」的用例与上一行互为「上下翻转 + 红黑互换 + 行棋方互换」。
//   训练时开了颜色镜像增广，所以完全对称的网络应给出**严格相反数**，
//   绝对值对不上就说明符号/对称性还有问题（m4b/m4c 那两次就是这类 bug）。
const CASES = [
  ['开局(红走)', 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1'],
  ['开局(黑走)', 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR b - - 0 1'],
  ['红多一车', 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/R8/RNBAKABNR w - - 0 1'],
  ['黑多一车(镜像)', 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/r8/RNBAKABNR b - - 0 1'],
  ['红少一车', 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABN1 w - - 0 1'],
  ['黑少一车(镜像)', 'rnbakabn1/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR b - - 0 1'],
  ['红少一马', 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/R1BAKABNR w - - 0 1'],
  ['红多一炮', 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C2C2C1/9/RNBAKABNR w - - 0 1'],
  ['黑多一炮(镜像)', 'rnbakabnr/9/1c2c2c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR b - - 0 1'],
  ['红兵过河(小优)', 'rnbakabnr/9/1c5c1/p1p1p1p1p/4P4/P1P1P1P1P/9/1C5C1/9/RNBAKABNR w - - 0 1'],
];

const argv = process.argv.slice(2);
const getArg = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d;
};

// 额外自由局面：--fen "<FEN>" 可重复（给了自定义局面就只跑自定义的）
const extraFens = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--fen' && argv[i + 1]) extraFens.push([`自定义${extraFens.length + 1}`, argv[i + 1]]);
}

const compare = argv.includes('--compare');
const models = compare
  ? [argv[argv.indexOf('--compare') + 1], argv[argv.indexOf('--compare') + 2]]
  : [getArg('model', 'data/model-best.onnx')];

const sessions = [];
for (const m of models) {
  sessions.push({ name: m, sess: await ort.InferenceSession.create(m) });
}

const cases = extraFens.length ? extraFens : CASES;
// --json：给 accept.mjs 用的结构化输出（解析文本表格太脆）
const asJson = argv.includes('--json');
const table = {}; // { 模型路径: { 用例名: cp } }
if (!asJson) console.log('位置'.padEnd(16) + sessions.map((s) => s.name.padEnd(26)).join(''));
for (const [label, fen] of cases) {
  const cps = [];
  for (const s of sessions) {
    const cp = await evalFen(s.sess, fen);
    cps.push(cp);
    (table[s.name] ??= {})[label] = Number(cp.toFixed(1));
  }
  if (!asJson) {
    const line = [label.padEnd(16)];
    for (const cp of cps) line.push(`${cp.toFixed(1)} cp`.padEnd(26));
    console.log(line.join(''));
    if (extraFens.length) console.log('    ' + fen);
  }
}
if (!asJson) console.log('\n说明：单位是「厘兵 cp」，红方视角。开局应接近 0；红多一车应 +900 左右；黑多子应为负。');

// ---- 抽样体检：从标注文件里随机抽 N 个真实局面，看分数分布 ----
const sampleFile = getArg('sample', '');
if (sampleFile) {
  const n = Number(getArg('n', '300'));
  const { readFileSync } = await import('node:fs');
  const lines = readFileSync(sampleFile, 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('#'));
  const step = Math.max(1, Math.floor(lines.length / n));
  const picked = [];
  for (let i = 0; i < lines.length && picked.length < n; i += step) picked.push(lines[i].split('\t')[0]);

  console.log(`\n===== 抽样体检：${picked.length} 个局面（源 ${sampleFile}，共 ${lines.length} 行）=====`);
  for (const s of sessions) {
    const vals = [];
    for (const fen of picked) vals.push(await evalFen(s.sess, fen));
    const abs = vals.map(Math.abs);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const meanAbs = abs.reduce((a, b) => a + b, 0) / abs.length;
    const sorted = [...abs].sort((a, b) => a - b);
    const p99 = sorted[Math.floor(sorted.length * 0.99)];
    const sat = abs.filter((v) => v > 1500).length;
    console.log(
      `${s.name}\n  均值(红方视角) ${mean.toFixed(1)} | 平均|cp| ${meanAbs.toFixed(1)} | |cp|中位 ${sorted[Math.floor(sorted.length / 2)].toFixed(1)} | p99 ${p99.toFixed(1)} | |cp|>1500 的占比 ${((sat / abs.length) * 100).toFixed(1)}%`,
    );
  }
  console.log('解读：平均|cp| 越小越「稳」；|cp|>1500 占比高 → 模型在真实局面上输出饱和（退化）。');
}

// ---- 教师一致率：在带标签的真实局面上量「模型评估 vs 教师分数」的误差 ----
// 这是比"对打 N 局"分辨力高得多的验收指标：几万个局面 vs 几十局棋
// （两个 NNUE 互掐 20 局 19 和 的教训），而且直接量蒸馏目标本身。
const maeFile = getArg('mae', '');
let maeReport = null;
if (maeFile) {
  const n = Number(getArg('n', '5000'));
  const { readFileSync } = await import('node:fs');
  const lines = readFileSync(maeFile, 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('#'));
  const step = Math.max(1, Math.floor(lines.length / n));
  const picked = [];
  for (let i = 0; i < lines.length && picked.length < n; i += step) {
    const t = lines[i];
    const j = t.lastIndexOf(';');
    if (j <= 0) continue;
    const fen = t.slice(0, j).trim();
    const teacher = Number(t.slice(j + 1).trim());
    if (Number.isFinite(teacher)) picked.push([fen, teacher]);
  }

  maeReport = {};
  // ⚠️ 必须排除将杀分（|cp| >= 9000）：模型末层是 tanh，cp = atanh(tanh)*1000 的上限
  //    只有 ±6103，永远追不上 ±10000。混进去会让 RMSE 被这 2~6% 的局面主导，
  //    真实棋局上的误差完全被淹没（实测不排除时 RMSE 5389，99% 的局面上其实只差几百 cp）。
  const mates = [];
  const plain = [];
  for (const [fen, t] of picked) (Math.abs(t) >= 9000 ? mates : plain).push([fen, t]);

  if (!asJson) {
    console.log(`\n===== 教师一致率：${plain.length} 个带标签局面（源 ${maeFile}，共 ${lines.length} 行）=====`);
    if (mates.length) {
      console.log(`  （已排除 ${mates.length} 条将杀分 |cp|>=9000：模型 tanh 输出上限 ≈6103cp，表达不了）`);
    }
  }
  for (const s of sessions) {
    let sae = 0, sse = 0, sy = 0, sp = 0, syy = 0, spp = 0, syp = 0, big = 0;
    for (const [fen, teacher] of plain) {
      const p = await evalFen(s.sess, fen);
      const d = p - teacher;
      sae += Math.abs(d); sse += d * d;
      sy += teacher; sp += p; syy += teacher * teacher; spp += p * p; syp += teacher * p;
      if (Math.abs(d) > 500) big++;
    }
    const N = Math.max(1, plain.length);
    const cov = syp / N - (sy / N) * (sp / N);
    const sdY = Math.sqrt(Math.max(1e-9, syy / N - (sy / N) ** 2));
    const sdP = Math.sqrt(Math.max(1e-9, spp / N - (sp / N) ** 2));
    const rec = {
      n: plain.length,
      excludedMate: mates.length,
      mae: Number((sae / N).toFixed(1)),
      rmse: Number(Math.sqrt(sse / N).toFixed(1)),
      r: Number((cov / (sdY * sdP)).toFixed(3)),
      bigPct: Number(((big / N) * 100).toFixed(1)),
    };
    maeReport[s.name] = rec;
    if (!asJson) {
      console.log(`${s.name}`);
      console.log(`  n=${rec.n} | MAE ${rec.mae} cp | RMSE ${rec.rmse} | 相关系数 r ${rec.r} | |Δ|>500cp 占 ${rec.bigPct}%`);
    }
  }
  if (!asJson) console.log('解读：MAE 越小越贴近教师；r 越接近 1 说明排序越对。对比基线用同样本同 n 跑一遍。');
}

if (asJson) console.log(JSON.stringify({ table, mae: maeReport }));


