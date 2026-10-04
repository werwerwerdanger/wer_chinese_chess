/**
 * accept.mjs —— 新模型上线验收闸门（只读：不修改任何模型文件）
 *
 * 为什么需要：单次训练无法保证更强（selfplay/蒸馏有噪声），而且更危险的是
 * *链路* bug —— m4b（搜索层多乘 sign）和 m4c（NNUE 输入向量没清零）都表现为
 * "模型看着没问题、下出来全是废棋"，靠对打根本发现不了（因为 A/B 用的是同一条
 * 坏链路，双方一起坏，反而打成平手）。所以顺序必须是：
 *
 *   ① 编码/视角一致性（确定性，与模型无关）—— 挡住链路 bug
 *   ② 单元测试（确定性）—— 挡住搜索视角 / NNUE buffer 回归
 *   ③ 体检探针（确定性）—— 挡住符号反了 / 编码漂移 / 输出饱和
 *   ④ 教师一致率（统计性，低噪声）—— 直接量蒸馏目标，几万个局面
 *   ⑤ 对打（统计性，高噪声，可选）—— 几十局棋，只能当参考
 *
 * 任一必要层 FAIL → 判为不可上线，退出码 1。model-best 永远保持不动。
 *
 * 用法：
 *   node tools/distill/accept.mjs --model data/model-big.onnx
 *   node tools/distill/accept.mjs --model data/model-big.onnx --base data/model-best.onnx \
 *        --labels data/labeled-web.txt --n 6000 --match --games 40 --depth 5
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const argv = process.argv.slice(2);
const get = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const flag = (k) => argv.includes(`--${k}`);

const MODEL = get('model', '');
const BASE = get('base', 'data/model-best.onnx');
const LABELS = get('labels', 'data/labeled-web.txt');
const N = get('n', '6000');
const GAMES = get('games', '40');
const DEPTH = get('depth', '5');
const TIME = get('time', '3000');
/** 教师一致率允许的相对退化；0 = 不允许比基线差 */
const MAE_TOL = Number(get('mae-tol', '0'));
/** 对打 Elo 下限 */
const MIN_ELO = Number(get('min-elo', '0'));
const REPORT = get('report', '');

if (!MODEL) {
  console.error('用法：node tools/distill/accept.mjs --model <候选模型.onnx> [--base ...] [--match]');
  process.exit(2);
}
if (!existsSync(MODEL)) {
  console.error(`✖ 找不到候选模型 ${MODEL}`);
  process.exit(2);
}

/** python 解析顺序：--python → 环境变量 CHESS_PY → 已知 chess venv → PATH 上的 python */
function findPython() {
  const explicit = get('python', '');
  if (explicit) return explicit;
  if (process.env.CHESS_PY) return process.env.CHESS_PY;
  const guess = path.join(os.homedir(), '.workbuddy', 'binaries', 'python', 'envs', 'chess', 'Scripts', 'python.exe');
  if (existsSync(guess)) return guess;
  return 'python';
}
const PYTHON = findPython();

const results = [];
function record(name, kind, ok, detail) {
  results.push({ name, kind, ok, detail });
  const tag = ok === null ? 'SKIP' : ok ? 'PASS' : 'FAIL';
  console.log(`[accept] ${tag}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8', shell: process.platform === 'win32', ...opts,
  });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}`, err: `${r.stderr ?? ''}` };
}

console.log(`[accept] 候选 ${MODEL}\n[accept] 基线 ${BASE}\n[accept] python ${PYTHON}\n`);

// ---------- ① 编码/视角一致性（确定性，与模型无关） ----------
console.log('---------- ① 编码/视角一致性 ----------');
{
  const r = run(PYTHON, ['tools/distill/check-encoding.py']);
  const ok = r.code === 0 && r.out.includes('全部一致');
  record('编码与 nnue.ts 金标准逐位一致', 'chain', ok,
    ok ? '30 个局面 + 镜像自反性' : (r.err || r.out || 'exit ' + r.code).split('\n').slice(-2).join(' ').trim());
}

// ---------- ② 单元测试（确定性） ----------
console.log('\n---------- ② 搜索视角 / NNUE buffer 回归测试 ----------');
if (flag('skip-tests')) {
  record('engine-ai 单测', 'chain', null, '--skip-tests');
} else {
  const r = run('npm', ['run', 'test:ai']);
  const m = r.out.match(/Tests\s+(\d+) passed/);
  const ok = r.code === 0 && !!m;
  record('engine-ai 单测', 'chain', ok, ok ? `${m[1]} 个用例通过` : '见输出结尾');
  if (!ok) console.log(r.out.split('\n').slice(-14).join('\n'));
}

// ---------- ③ 体检探针（确定性） ----------
console.log('\n---------- ③ 体检探针（裸评估符号 / 镜像对称） ----------');
let probe = null;
{
  const r = run(process.execPath, ['tools/distill/probe-eval.mjs', '--model', MODEL, '--json']);
  try {
    probe = JSON.parse(r.out.trim().split('\n').pop());
  } catch {
    record('probe-eval 可解析', 'model', false, '输出不是 JSON');
  }
  const t = probe?.table?.[MODEL];
  if (!t) {
    record('probe-eval 拿到候选模型分数', 'model', false, '缺失');
  } else {
    // 单侧断言：红方占优必须为正，黑方占优必须为负
    const checks = [
      ['红多一车', (v) => v > 200],
      ['黑多一车(镜像)', (v) => v < -200],
      ['红少一车', (v) => v < -200],
      ['黑少一车(镜像)', (v) => v > 200],
      ['红少一马', (v) => v < -100],
      ['红多一炮', (v) => v > 150],
      ['黑多一炮(镜像)', (v) => v < -150],
      ['红兵过河(小优)', (v) => v > 0],
      ['开局(红走)', (v) => Math.abs(v) < 400],
      ['开局(黑走)', (v) => Math.abs(v) < 400],
    ];
    const bad = checks.filter(([k, f]) => !(k in t) || !f(t[k]));
    record('子力方向与开局尺度', 'model', bad.length === 0,
      bad.length === 0 ? '10 项断言通过' : bad.map(([k]) => `${k}=${t[k]}`).join(', '));

    // 镜像对：完全对称的网络应给出相反数
    const pairs = [['红多一车', '黑多一车(镜像)'], ['红少一车', '黑少一车(镜像)'], ['红多一炮', '黑多一炮(镜像)']];
    const asym = [];
    for (const [a, b] of pairs) {
      if (!(a in t) || !(b in t)) continue;
      const resid = Math.abs(t[a] + t[b]);
      const scale = Math.max(Math.abs(t[a]), Math.abs(t[b]), 1);
      if (resid > 0.6 * scale) asym.push(`${a}/${b} 残差 ${resid.toFixed(0)}cp（尺度 ${scale.toFixed(0)}）`);
    }
    record('镜像对称（f(镜像) ≈ -f(原)）', 'model', asym.length === 0,
      asym.length === 0 ? '3 对镜像残差 < 60%' : asym.join('; '));

    // 输出饱和：大量 |cp| 顶在 tanh 上限说明退化
    const sat = Object.entries(t).filter(([, v]) => Math.abs(v) > 3000).map(([k]) => k);
    record('无输出饱和', 'model', sat.length === 0, sat.length === 0 ? '无 |cp|>3000' : sat.join(', '));
  }
}

// ---------- ④ 教师一致率（统计性，低噪声） ----------
console.log('\n---------- ④ 教师一致率（vs Pikafish 标签） ----------');
let maeModel = null;
let maeBase = null;
{
  const args = ['tools/distill/probe-eval.mjs'];
  if (existsSync(BASE) && BASE !== MODEL) args.push('--compare', MODEL, BASE);
  else args.push('--model', MODEL);
  args.push('--mae', LABELS, '--n', N, '--json');
  const r = run(process.execPath, args);
  try {
    const rep = JSON.parse(r.out.trim().split('\n').pop());
    maeModel = rep.mae?.[MODEL] ?? null;
    maeBase = existsSync(BASE) ? rep.mae?.[BASE] ?? null : null;
  } catch {
    record('教师一致率可解析', 'model', false, '输出不是 JSON');
  }
  if (maeModel) {
    console.log(`[accept]   候选 n=${maeModel.n} MAE ${maeModel.mae}cp RMSE ${maeModel.rmse} r ${maeModel.r} |Δ|>500 占 ${maeModel.bigPct}%`);
    if (maeBase) {
      console.log(`[accept]   基线 n=${maeBase.n} MAE ${maeBase.mae}cp RMSE ${maeBase.rmse} r ${maeBase.r} |Δ|>500 占 ${maeBase.bigPct}%`);
      const limit = maeBase.mae * (1 + MAE_TOL);
      const ok = maeModel.mae <= limit;
      record('教师一致率不低于基线', 'model', ok,
        `MAE ${maeModel.mae} vs 基线 ${maeBase.mae}（容差 ${(MAE_TOL * 100).toFixed(0)}%）`);
      // 相关系数也看一眼：MAE 会被大分局面主导，r 反映排序质量
      record('排序质量 r 不低于基线', 'model', maeModel.r >= maeBase.r - 0.02,
        `r ${maeModel.r} vs 基线 ${maeBase.r}`);
    } else {
      console.log('[accept]   （没有基线可对比，只报告数值）');
    }
  }
}

// ---------- ⑤ 对打（统计性，高噪声，可选） ----------
console.log('\n---------- ⑤ 对打（可选，噪声大） ----------');
let elo = null;
if (!flag('match')) {
  record('对打 Elo', 'model', null, '未开启（加 --match 启用）');
} else if (!existsSync(BASE)) {
  record('对打 Elo', 'model', null, `基线 ${BASE} 不存在`);
} else {
  const r = run(process.execPath, [
    'tools/distill/match.mjs', '--games', GAMES, '--depth', DEPTH, '--time', TIME,
    '--model', MODEL, '--opp', 'nnue', '--model2', BASE,
  ]);
  const m = r.out.match(/Elo 差（学生-[^）]+）:\s*(-?\d+)/);
  if (m) {
    elo = Number(m[1]);
    record('对打 Elo ≥ 下限', 'model', elo >= MIN_ELO,
      `Elo ${elo >= 0 ? '+' : ''}${elo}（下限 ${MIN_ELO}，${GAMES} 局 depth ${DEPTH}）`);
    console.log(`[accept]   注意：${GAMES} 局对打对 50% 得分率的 95% 置信区间约 ±${Math.round(1600 / Math.sqrt(GAMES))} Elo，`);
    console.log('[accept]   两个 NNUE 互相下常见大面积和棋 → 分辨力低。以 ④ 的 MAE 为主判据。');
  } else {
    record('对打 Elo 可解析', 'model', false, 'match.mjs 没输出 Elo 行');
  }
}

// ---------- 结论 ----------
const chainFail = results.filter((r) => r.kind === 'chain' && r.ok === false);
const modelFail = results.filter((r) => r.kind === 'model' && r.ok === false);
console.log('\n==================== 验收结论 ====================');
for (const r of results) {
  console.log(`  ${r.ok === null ? '-' : r.ok ? '✓' : '✗'} [${r.kind === 'chain' ? '链路' : '模型'}] ${r.name}`);
}
const verdict = chainFail.length ? 'REJECT_CHAIN' : modelFail.length ? 'REJECT_MODEL' : 'PASS';
console.log(`\n  结论：${verdict}`);
if (verdict === 'PASS') {
  console.log('\n  可以上线。model-best 现在还**没有**被改动，确认后用：');
  console.log(`    node -e "const f=require('fs');f.copyFileSync('${BASE}','data/model-prev.onnx');f.copyFileSync('${MODEL}','${BASE}');console.log('已换模型，旧模型备份在 data/model-prev.onnx')"`);
} else if (verdict === 'REJECT_CHAIN') {
  console.log('\n  链路有问题：模型好坏无从判断，先修代码（不要把模型换上）。');
} else {
  console.log('\n  模型不达标：保留现有 model-best（回滚见 data/model-prev.onnx）。');
}

if (REPORT) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(REPORT, `${JSON.stringify({ model: MODEL, base: BASE, labels: LABELS, verdict, results, probe, maeModel, maeBase, elo }, null, 2)}\n`);
  console.log(`\n[accept] 报告写到 ${REPORT}`);
}

process.exit(verdict === 'PASS' ? 0 : 1);
