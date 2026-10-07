/**
 * test-engine.mjs —— 诊断 Pikafish 引擎「搜完 bestmove 就 exit -1」的问题
 *
 * 模拟桥接：spawn 引擎、保持 stdin 打开、连发 uci/isready/position/go，
 * 观察引擎是否搜完就死，并抓取退出前的 stderr（真凶往往在 stderr 里）。
 *
 * 用法（在 4080 上，仓库根目录）：
 *   node tools/pikafish/test-engine.mjs
 *
 * 判读：
 *   - 6 秒内 bestmove 出现 ≥3 次 → 引擎健康（搜完不死、能连续响应）
 *   - bestmove 只有 1 次 + [EXIT] code=4294967295 → 引擎搜完就死（本问题）
 *   - 看 [stderr] 行：引擎退出前的报错就在那
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const exe = path.join(__dirname, 'dist', 'Pikafish-Windows-x86-64-universal.exe');
const cwd = path.join(__dirname, 'dist');

console.log('[test] exe =', exe);
const p = spawn(exe, [], { cwd });
let out = '';
p.stdout.on('data', (c) => { out += c; });
p.stderr.on('data', (c) => process.stderr.write('[stderr] ' + c));
p.on('exit', (code, sig) => console.log(`[EXIT] code=${code} signal=${sig}  (4294967295 = -1 = 异常退出)`));
p.stdin.on('error', (e) => console.log(`[stdin-err] ${e.code}`));

p.stdin.write('uci\nisready\nposition fen rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w\ngo depth 6\n');

let bestmoves = 0;
const iv = setInterval(() => {
  const n = (out.match(/bestmove /g) || []).length;
  if (n > bestmoves) { bestmoves = n; console.log(`[t] bestmove 出现 ${n} 次`); }
  p.stdin.write('go depth 6\n');
}, 1000);

setTimeout(() => {
  clearInterval(iv);
  console.log(`[END] 6 秒内共 ${bestmoves} 次 bestmove（≥3 = 引擎健康；=1 = 搜完就死）`);
  p.kill();
}, 6000);
