/**
 * run-match-long.mjs —— 用 esbuild 现场把 match-long.ts 打成临时 bundle 再跑
 *
 * 为什么不直接跑提交进仓库的 .mjs bundle：
 *   tools/distill/*.mjs 是产物，改 TS 后必须手动重新打包，长期任务里很容易忘
 *   ——结果跑了一整夜却是旧代码。这里每次启动都从源码重新 bundle
 *   （esbuild 是同步 API，约 0.2 秒），保证「跑的一定是当前源码」。
 *
 * 用法：
 *   node tools/distill/run-match-long.mjs --out data/match-big/shard-1.jsonl --games 12500 ...
 */
import { pathToFileURL } from 'node:url';
import { mkdirSync, unlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));

let esbuild;
try {
  esbuild = require('esbuild');
} catch {
  console.error('[run-long] esbuild not found. Run "npm install" in the repo root first.');
  process.exit(2);
}

const tmpDir = path.join(here, '..', '..', 'data', 'match-big');
mkdirSync(tmpDir, { recursive: true });
const outfile = path.join(tmpDir, `_match-long.${process.pid}.bundle.mjs`);

await esbuild.build({
  entryPoints: [path.join(here, 'match-long.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  external: ['onnxruntime-node'],
  outfile,
  logLevel: 'error',
  sourcemap: false,
});

process.on('exit', () => {
  try { unlinkSync(outfile); } catch { /* ignore */ }
});

await import(pathToFileURL(outfile).href);
