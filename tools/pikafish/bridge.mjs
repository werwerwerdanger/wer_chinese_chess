/**
 * Pikafish UCI 桥接服务 — 让浏览器前端能调用本地 Pikafish 引擎
 *
 * 浏览器无法直接 spawn 进程，本服务作为薄代理：
 *   POST /think  body: { fen, depth }  →  { move, scoreCp, mate, depth, nodes, timeMs }
 *
 * Pikafish 无状态处理：每个请求 position fen 重设，go depth N，等 bestmove。
 * 启动：node bridge.mjs  （默认端口 8788）
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXE = path.join(__dirname, 'dist', 'Pikafish-Windows-x86-64-universal.exe');
const CWD = path.join(__dirname, 'dist');
const PORT = 8788;

/** 常驻 UCI 引擎进程，请求串行处理（象棋思考天然互斥） */
class UciEngine {
  constructor() {
    this.proc = spawn(EXE, [], { cwd: CWD, stdio: ['pipe', 'pipe', 'ignore'] });
    this.lines = [];
    this.proc.stdout.setEncoding('utf8');
    this.pending = '';
    this.proc.stdout.on('data', (chunk) => {
      this.pending += chunk;
      const parts = this.pending.split('\n');
      this.pending = parts.pop() ?? ''; // 最后一段可能是不完整行，留到下个 chunk
      for (const line of parts) {
        const t = line.trim();
        if (t) this.lines.push(t);
      }
    });
    this.proc.on('exit', (code) => console.error(`[bridge] pikafish exited: ${code}`));
  }

  send(cmd) {
    this.proc.stdin.write(cmd + '\n');
  }

  /** 等待匹配谓词的行出现，返回该行（不消费其他行） */
  waitFor(pred, timeoutMs = 120000) {
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
      const line = this.lines.find((l) => l.startsWith('bestmove '));
      if (line) {
        const move = line.split(/\s+/)[1] ?? '';
        return { move, scoreCp, mate, depth: lastDepth, nodes, timeMs };
      }
      // 收集最后一条完整 info（含 score 的才更新；不锚定字段序，用词边界宽松匹配）
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
      await new Promise((r) => setTimeout(r, 15));
    }
    throw new Error('pikafish search timeout');
  }
}

const engine = new UciEngine();
await engine.ready();
console.log('[bridge] pikafish ready');

http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'GET' && req.url === '/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, name: 'Pikafish 2026-09-06' }));
    return;
  }

  if (req.method === 'POST' && req.url === '/think') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      try {
        const { fen, depth } = JSON.parse(body);
        if (!fen || !Number.isFinite(depth)) throw new Error('bad request');
        const r = await engine.think(fen, Math.min(Math.max(1, depth | 0), 20));
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
        const results = [];
        for (const fen of fens) {
          try {
            const r = await engine.think(fen, d);
            results.push({ fen, ...r });
          } catch (err) {
            results.push({ fen, error: String(err.message ?? err) });
          }
        }
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
