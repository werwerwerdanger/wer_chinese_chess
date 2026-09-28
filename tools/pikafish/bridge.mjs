/**
 * Pikafish UCI 桥接服务 — 让浏览器前端/蒸馏标注脚本能调用本地 Pikafish 引擎
 *
 * 浏览器无法直接 spawn 进程，本服务作为薄代理：
 *   POST /think  body: { fen, depth }  →  { move, scoreCp, mate, depth, nodes, timeMs }
 *   POST /eval-batch  body: { fens: string[], depth }  →  { results: [{fen, scoreCp, mate, ...}] }
 *
 * 引擎池：多个 Pikafish 进程并行处理批量请求（环境变量 PIKAFISH_WORKERS 可调，默认 12）。
 * 单实例串行处理分到自己的请求；实例崩溃自动重启；毒局面（非法 FEN）重试后仍死则跳过。
 * 启动：node bridge.mjs  （默认端口 8788）
 */
import http from 'node:http';
import os from 'node:os';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXE = path.join(__dirname, 'dist', 'Pikafish-Windows-x86-64-universal.exe');
const CWD = path.join(__dirname, 'dist');
const PORT = 8788;
const WORKERS = Math.max(1, Math.min(Number(process.env.PIKAFISH_WORKERS ?? 12), os.cpus().length));

/** 单个 UCI 引擎进程：串行处理分配给它的请求；崩溃自动重启 */
class UciEngine {
  constructor(id) {
    this.id = id;
    this.alive = false;
    this.available = false; // ready 握手完成才算真正可用
    this.busy = Promise.resolve(); // 本实例的串行队列
    this.start();
  }

  start() {
    this.proc = spawn(EXE, [], { cwd: CWD, stdio: ['pipe', 'pipe', 'pipe'] });
    this.lines = [];
    this.recent = []; // 黑匣子：引擎最近输出的行，退出时倒出来
    this.proc.stdout.setEncoding('utf8');
    this.pending = '';
    this.proc.stdout.on('data', (chunk) => {
      this.pending += chunk;
      const parts = this.pending.split('\n');
      this.pending = parts.pop() ?? ''; // 最后一段可能是不完整行，留到下个 chunk
      for (const line of parts) {
        const t = line.trim();
        if (t) {
          this.lines.push(t);
          this.recent.push(t);
          if (this.recent.length > 40) this.recent.shift();
        }
      }
    });
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (c) => process.stderr.write(`[eng${this.id}:err] ` + c));
    this.proc.on('error', (e) => console.error(`[eng${this.id}] spawn error: ${e.message}`));
    // 引擎暴死时 stdin 的异步 EPIPE 无法同步捕获，吞掉由 alive/available 标志统一处理
    this.proc.stdin.on('error', () => {});
    // 引擎退出时倒出黑匣子，看它临死前最后的输出
    this.proc.on('exit', (code) => {
      this.alive = false;
      this.available = false;
      const tail = this.recent.slice(-10).map((l) => `    ${l}`).join('\n');
      console.error(`[eng${this.id}] pikafish exited: ${code}\n[eng${this.id}] 最后输出:\n${tail || '    (无输出)'}`);
      setTimeout(() => this.restart(), 3000);
    });
    this.alive = true; // spawn 成功即允许握手命令；exit 事件再置 false
  }

  async restart() {
    try {
      this.start();
      await this.ready();
      this.available = true; // 握手完成后才放行业务请求
      console.error(`[eng${this.id}] pikafish 重启完成，恢复服务`);
    } catch (err) {
      this.alive = false;
      this.available = false;
      console.error(`[eng${this.id}] 重启失败: ${err.message}，5 秒后再试`);
      setTimeout(() => this.restart(), 5000);
    }
  }

  send(cmd) {
    if (!this.alive) throw new Error('engine down, restarting');
    try {
      this.proc.stdin.write(cmd + '\n');
    } catch {
      throw new Error('engine stdin broken, restarting');
    }
  }

  /** 等待匹配谓词的行出现，返回该行（不消费其他行） */
  waitFor(pred, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const tick = () => {
        const hit = this.lines.find(pred);
        if (hit) return resolve(hit);
        if (Date.now() - start > timeoutMs) return reject(new Error('uci timeout'));
        setTimeout(tick, 15);
      };
      tick();
    });
  }

  async ready() {
    this.lines = [];
    this.send('uci');
    await this.waitFor((l) => l === 'uciok');
    this.send('isready');
    await this.waitFor((l) => l === 'readyok');
  }

  async init() {
    await this.ready();
    this.available = true;
  }

  /** 等本实例 ready 握手完成（毒局面崩掉后的重试用） */
  ensureAlive() {
    if (this.available) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setInterval(() => {
        if (this.available) { clearInterval(t); resolve(); }
      }, 300);
    });
  }

  /** 跑一次搜索，返回 bestmove 与统计 */
  async think(fen, depth) {
    this.lines = [];
    this.send(`position fen ${fen}`);
    this.send(`go depth ${depth}`);

    let scoreCp = null;
    let mate = null;
    let lastDepth = 0;
    let nodes = 0;
    let timeMs = 0;

    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      if (!this.alive) throw new Error('engine died on this position (illegal FEN?)');
      // 先扫 info 再看 bestmove：浅搜时 info 和 bestmove 同批到达，
      // 若先判 bestmove 直接 return 会漏掉全部统计（深度/节点/评分恒 0）
      for (const l of this.lines) {
        const m = l.match(/\bdepth (\d+)\b.*?\bscore (cp|mate) (-?\d+).*?\bnodes (\d+).*?\btime (\d+)\b/);
        if (m && l.startsWith('info')) {
          lastDepth = Number(m[1]);
          if (m[2] === 'cp') { scoreCp = Number(m[3]); mate = null; }
          else { mate = Number(m[3]); scoreCp = null; }
          nodes = Number(m[4]);
          timeMs = Number(m[5]);
        }
      }
      const line = this.lines.find((l) => l.startsWith('bestmove '));
      if (line) {
        const move = line.split(/\s+/)[1] ?? '';
        return { move, scoreCp, mate, depth: lastDepth, nodes, timeMs };
      }
      await new Promise((r) => setTimeout(r, 15));
    }
    throw new Error('pikafish search timeout');
  }
}

// --- 引擎池 ---
const engines = [];
for (let i = 0; i < WORKERS; i++) engines.push(new UciEngine(i));
for (const e of engines) await e.init();
console.log(`[bridge] ${WORKERS} 个 Pikafish 实例就绪`);

let rr = 0;

/** 单个局面评估：等实例活着 → 搜索 → 崩了（毒局面）重试至多 3 次 */
async function evalOne(e, fen, depth) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await e.ensureAlive();
    try {
      return { fen, ...(await e.think(fen, depth)) };
    } catch (err) {
      if (attempt === 2) return { fen, error: String(err.message ?? err) };
    }
  }
}

/** 轮询分配到引擎池，返回带串行保证的 Promise */
function submitEval(fen, depth) {
  const e = engines[rr++ % engines.length];
  const p = e.busy.then(() => evalOne(e, fen, depth));
  e.busy = p.catch(() => {});
  return p;
}

http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'GET' && req.url === '/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, name: 'Pikafish 2026-09-06', workers: WORKERS }));
    return;
  }

  if (req.method === 'POST' && req.url === '/think') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      try {
        const { fen, depth } = JSON.parse(body);
        if (!fen || !Number.isFinite(depth)) throw new Error('bad request');
        const r = await submitEval(fen, Math.min(Math.max(1, depth | 0), 20));
        if (r.error) throw new Error(r.error);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(r));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err.message ?? err) }));
      }
    });
    return;
  }

  // 蒸馏管线②：批量标注。body: { fens: string[], depth } → { results: [{fen, scoreCp, mate, ...}] }
  // Pikafish 的 score 是行棋方视角；label.mjs 负责转红方视角
  if (req.method === 'POST' && req.url === '/eval-batch') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      try {
        const { fens, depth } = JSON.parse(body);
        if (!Array.isArray(fens) || fens.length === 0) throw new Error('bad request');
        const d = Math.min(Math.max(1, (depth | 0) || 14), 20);
        const results = await Promise.all(fens.map((fen) => submitEval(fen, d)));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ results }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err.message ?? err) }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end();
}).listen(PORT, '127.0.0.1', () => console.log(`[bridge] listening on http://127.0.0.1:${PORT}`));
