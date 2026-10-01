/**
 * 本地蒸馏模型服务 —— 让网页用上 NNUE 蒸馏引擎
 *
 * 浏览器跑 ONNX（方案A onnxruntime-web）需要同步桥改造，先用最小方案：
 * 本机起 HTTP 服务（onnxruntime-node + Searcher），网页新模式把 think 转发过来。
 * 与 pikafish bridge 完全同构，端口 8789。
 *
 * 用法（esbuild 打包后）：
 *   node tools/distill/nnue-serve.mjs --model data/model.onnx [--port 8789]
 *
 * POST /think  body: { fen, depth }  →  { move(uci), score, depth, nodes, timeMs }
 */
import http from 'node:http';
import { Board, generateLegalMoves } from '@wer-chess/engine';
import type { Move } from '@wer-chess/engine';
import { Searcher } from '@wer-chess/engine-ai';
import { NnueEvaluator } from '../../engine-ai/src/nnue';

const argv = process.argv.slice(2);
const get = (k: string, d: string) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d;
};
const MODEL = get('model', 'data/model.onnx');
const PORT = Number(get('port', '8789'));

/** sq → UCI "b2"（file a-i = col 0-8, rank 0-9 = 9-row，与 pikafish-adapter 一致） */
function sqToUci(sq: number): string {
  const row = Math.floor(sq / 9), col = sq % 9;
  return `${String.fromCharCode(97 + col)}${9 - row}`;
}

const nn = new NnueEvaluator(MODEL);

http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'GET' && req.url === '/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, name: `NNUE serve (${MODEL})` }));
    return;
  }

  if (req.method === 'POST' && req.url === '/think') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try {
        const { fen, depth } = JSON.parse(body) as { fen: string; depth: number };
        if (!fen || !Number.isFinite(depth)) throw new Error('bad request');
        const board = new Board(fen);
        const evalFn = (b: Board) => nn.evalBoard(b);
        const searcher = new Searcher(board, 1 << 17, evalFn);
        const t0 = performance.now();
        // NNUE 评估 ~0.4ms/次，深搜节点爆炸（depth4 实测 20s+）；
        // 交互场景钳制 depth≤3、时限 3s，超时返回当前最优
        const r = searcher.search(Math.min(Math.max(1, depth | 0), 3), 3000);
        if (!r.bestMove) throw new Error('无棋可走');
        // SearchResult.score 是红方视角 → 转行棋方视角（与 local-adapter 一致）
        const sign = board.turn === 0 ? 1 : -1;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          move: `${sqToUci((r.bestMove as Move).from)}${sqToUci((r.bestMove as Move).to)}`,
          score: r.score * sign,
          depth: r.depth,
          nodes: r.nodes,
          timeMs: Math.round(performance.now() - t0),
        }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String((err as Error).message ?? err) }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end();
}).listen(PORT, '127.0.0.1', () => {
  console.log(`[nnue-serve] model=${MODEL}  listening on http://127.0.0.1:${PORT}`);
  console.log(`[nnue-serve] 合法走法兜底校验由前端完成（generateLegalMoves）`);
});

// 顺带暴露一个合法性检查辅助，防止前端拿到非法着法
export function legalCount(fen: string): number {
  return generateLegalMoves(new Board(fen), new Board(fen).turn).length;
}
void legalCount;
