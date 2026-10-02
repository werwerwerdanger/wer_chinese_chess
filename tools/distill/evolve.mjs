/**
 * 迭代式蒸馏编排 —— 生成 → 训练 → 对打验Gate → 择优晋级
 *
 * 每一代：
 *   1. selfplay(sp)：当前最佳模型当陪练 vs Pikafish，顺产带标签数据
 *      （学生行棋局面由 Pikafish 评分标注，--label-all 全覆盖）
 *   2. 合并数据：base(labeled.txt/labeled-web.txt) + 历代 gen 数据 → labeled-evolve.txt
 *   3. train.py 重训 → model-gen{i}.onnx
 *   4. match --opp old 对打 Gate：Elo 不低于历史最佳才晋级为下一代陪练
 *
 * 用法（在装了 torch 的训练机上，bridge 先起）：
 *   node tools/distill/evolve.mjs --gens 5 --games 3000 --python <venv python 路径>
 *
 * 注意 RAM：1 万局 ≈ 100 万标签，增广后 x2 行 × 1261 维 float32 ≈ 10GB+
 * 内存，32G 以下机器建议 --games 3000 起步。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, copyFileSync, readFileSync, writeSync, openSync, closeSync, readdirSync, appendFileSync } from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const get = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d;
};

const GENS = Number(get('gens', '5'));
const GAMES = Number(get('games', '3000'));
const DEPTH = Number(get('depth', '12'));
const GATE_GAMES = Number(get('gate-games', '20'));
const GATE_DEPTH = Number(get('gate-depth', '3'));
const PARALLEL = Number(get('parallel', '8'));
const PYTHON = get('python', 'python'); // torch venv 的 python
/** 默认从历史最佳起跑（存在 model-best 就用它），避免续跑时退化回初始模型 */
const START_MODEL = get('start-model', existsSync('data/model-best.onnx') ? 'data/model-best.onnx' : 'data/model.onnx');
const BASE_LABELS = ['data/labeled.txt', 'data/labeled-web.txt', 'data/labeled-selfplay.txt'].filter(existsSync);
const MERGED = 'data/labeled-evolve.txt';
const BEST = 'data/model-best.onnx';
const EVOLVE_LOG = 'data/evolve-log.txt';

function run(cmd, args) {
  console.log(`\n[evolve] >>> ${cmd} ${args.join(' ')}\n`);
  const r = spawnSync(cmd, args, { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`${cmd} 退出码 ${r.status}`);
}

function mergeLabels(files, out) {
  const seen = new Set();
  let n = 0;
  let buf = '';
  const fd = openSync(out, 'w'); // 截断旧文件
  for (const f of files) {
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      const i = line.indexOf(';');
      if (i <= 0) continue;
      const fen = line.slice(0, i).trim();
      if (seen.has(fen)) continue;
      seen.add(fen);
      buf += line + '\n';
      n++;
      if (buf.length > 8 * 1024 * 1024) { // 8MB 一批刷盘，避免逐行 syscall
        writeSync(fd, buf);
        buf = '';
      }
    }
  }
  if (buf) writeSync(fd, buf);
  closeSync(fd);
  return n;
}

function runGate(model, prevModel) {
  // 晋级赛：新版 vs 上一代最佳，同深度同评估架构，赢面过半才算进步
  const r = spawnSync(process.execPath, [
    'tools/distill/match.mjs', '--games', String(GATE_GAMES), '--depth', String(GATE_DEPTH),
    '--model', model, '--opp', 'nnue', '--model2', prevModel,
  ], { encoding: 'utf8' });
  process.stdout.write(r.stdout ?? '');
  process.stderr.write(r.stderr ?? '');
  const m = (r.stdout ?? '').match(/Elo 差（学生-[^）]+）:\s*(-?\d+)/);
  return m ? Number(m[1]) : null;
}

/** 扫描已有 gen 产物，自动续号（支持中断后重启 / --gens -1 无限迭代多次调用） */
function nextGenIndex() {
  let max = 0;
  const scan = (dir) => {
    try {
      for (const f of readdirSync(dir)) {
        const m = /(?:labeled-gen|model-gen)(\d+)\.(?:txt|onnx)$/.exec(f);
        if (m) max = Math.max(max, Number(m[1]));
      }
    } catch { /* 目录不存在 */ }
  };
  scan('data');
  return max + 1;
}

async function main() {
  if (!existsSync(START_MODEL)) throw new Error(`找不到起始模型 ${START_MODEL}`);
  let cur = START_MODEL;
  let cumulativeElo = 0; // 相对起跑模型的累计 Elo（每代晋级赛的增量之和）
  const history = [];
  const INFINITE = GENS < 0;
  let gen = nextGenIndex();
  const firstGen = gen;

  console.log(`[evolve] 迭代蒸馏：${INFINITE ? '无限' : GENS + ' 代'} × 每代 ${GAMES} 局陪练自生成  depth=${DEPTH}  并发=${PARALLEL}`);
  console.log(`[evolve] 起始模型 ${cur}  基础标签 ${BASE_LABELS.length} 个文件  代号从 gen${gen} 起`);

  for (let done = 0; INFINITE || done < GENS; done++, gen++) {
    console.log(`\n========== 第 ${gen} 代${INFINITE ? '' : `（${done + 1}/${GENS}）`}（陪练=${cur}） ==========`);
    const t0 = Date.now();

    // 1. 陪练自生成
    const genData = `data/labeled-gen${gen}.txt`;
    run(process.execPath, [
      'tools/distill/selfplay.mjs',
      '--mode', 'sp', '--model', cur,
      '--games', String(GAMES), '--depth', String(DEPTH),
      '--parallel', String(PARALLEL), '--out', genData,
    ]);

    // 2. 合并（历代 gen 数据全保留进训练集）
    const files = [...BASE_LABELS];
    for (let k = 1; k < gen; k++) {
      const f = `data/labeled-gen${k}.txt`;
      if (existsSync(f)) files.push(f);
    }
    files.push(genData);
    const n = mergeLabels(files, MERGED);
    console.log(`[evolve] 合并 ${files.length} 个数据源 → ${MERGED}（${n} 条去重）`);

    // 3. 训练
    const model = `data/model-gen${gen}.onnx`;
    run(PYTHON, ['tools/distill/train.py', '--data', MERGED, '--out', model]);

    // 4. Gate：晋级赛（新版 vs 上一代最佳），累计 Elo 记录绝对进步
    const elo = runGate(model, cur);
    if (elo === null) throw new Error('Gate 对打没解析出 Elo，检查 match 输出');
    history.push({ gen, elo, model });
    const promoted = elo >= 0; // 得分率 ≥ 50% 才晋级
    if (promoted) {
      cumulativeElo += elo;
      cur = model;
      copyFileSync(model, BEST);
    }
    const line = `gen${gen}  Elo_vs_prev=${elo >= 0 ? '+' : ''}${elo}  cumulative=${cumulativeElo >= 0 ? '+' : ''}${cumulativeElo}  ` +
      `${promoted ? 'PROMOTED' : 'KEPT'}  ${((Date.now() - t0) / 60000).toFixed(1)}min  ${model}`;
    console.log(`[evolve] ${line}`);
    appendFileSync(EVOLVE_LOG, `${new Date().toISOString()}  ${line}\n`);
  }

  console.log('\n========== 总结 ==========');
  for (const h of history) console.log(`  第 ${h.gen} 代: Elo ${h.elo}  (${h.model})`);
  console.log(`[evolve] 本次最佳: ${cur}（历史累计见 ${EVOLVE_LOG}，最佳模型 ${BEST}）`);
  console.log('[evolve] 教师基线参考: node tools/distill/match.mjs --games 20 --depth 3 --opp pikafish');
}

main().catch((e) => { console.error(`[evolve] 致命错误: ${e.message}`); process.exit(1); });
