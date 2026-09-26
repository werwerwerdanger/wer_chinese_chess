/**
 * 蒸馏管线 ①—— 自对弈局面生成
 *
 * 用法（先打包再跑）：
 *   npx esbuild tools/distill/datagen.ts --bundle --platform=node --format=esm --outfile=tools/distill/datagen.mjs
 *   node tools/distill/datagen.mjs --games 1000 --depth 3 --out data/positions.txt
 *
 * 逻辑：每局开局随机扰动 8 步（均匀随机、允许送子——教师会如实标分），
 * 然后双方用本地 Searcher 自对弈，沿途每个局面写一条 FEN。
 * 数据分布 ≈ 真实对局，供 Pikafish 标注（管线 ②）。
 */
import {
  Board, INITIAL_FEN, generateLegalMoves, isCheckmate, isStalemate,
  type Move,
} from '@wer-chess/engine';
import { findBestMove } from '@wer-chess/engine-ai';
import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

interface Args {
  games: number;      // 局数
  depth: number;      // 自对弈搜索深度
  openingPlies: number; // 开局随机扰动步数（半回合）
  maxPly: number;     // 单局步数上限（防无限长局）
  timeLimitMs: number;  // 每步时间上限
  out: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (k: string, d: string) => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1]! : d;
  };
  return {
    games: Number(get('games', '1000')),
    depth: Number(get('depth', '3')),
    openingPlies: Number(get('opening-plies', '8')),
    maxPly: Number(get('max-ply', '160')),
    timeLimitMs: Number(get('time', '1000')),
    out: get('out', 'data/positions.txt'),
  };
}

function perturbOpening(board: Board, plies: number): void {
  for (let i = 0; i < plies; i++) {
    const moves = generateLegalMoves(board, board.turn);
    if (moves.length === 0) return;
    const m: Move = moves[Math.floor(Math.random() * moves.length)]!;
    board.makeMove(m);
  }
}

/** 走一步自对弈，返回是否继续 */
function step(board: Board, args: Args): boolean {
  // 无棋可走 = 将杀或困毙，局面已记录，结束
  const moves = generateLegalMoves(board, board.turn);
  if (moves.length === 0) return false;
  if (isCheckmate(board, board.turn) || isStalemate(board, board.turn)) return false;
  const r = findBestMove(board, args.depth, args.timeLimitMs);
  if (!r.bestMove) return false;
  board.makeMove(r.bestMove);
  return true;
}

function main(): void {
  const args = parseArgs();
  if (!existsSync(dirname(args.out))) mkdirSync(dirname(args.out), { recursive: true });

  const t0 = Date.now();
  let totalPositions = 0;
  let finished = 0;

  for (let g = 1; g <= args.games; g++) {
    const board = new Board(INITIAL_FEN);
    perturbOpening(board, args.openingPlies);

    const seen = new Set<string>(); // 局内去重（长将循环等）
    let plies = 0;
    for (; plies < args.maxPly; plies++) {
      const fen = board.toFen();
      if (!seen.has(fen)) {
        seen.add(fen);
        appendFileSync(args.out, fen + '\n');
        totalPositions++;
      }
      if (!step(board, args)) break;
    }
    finished++;

    if (g % 50 === 0 || g === args.games) {
      const dt = (Date.now() - t0) / 1000;
      process.stdout.write(
        `[datagen] 局 ${g}/${args.games}  局面 ${totalPositions}  ` +
        `均速 ${(dt / g).toFixed(1)}s/局  预计剩余 ${((dt / g) * (args.games - g) / 60).toFixed(0)} 分钟\n`,
      );
    }
  }

  console.log(`[datagen] 完成：${finished} 局，共 ${totalPositions} 个局面 → ${args.out}`);
  console.log(`[datagen] 下一步：node tools/distill/label.mjs --in ${args.out} --out data/labeled.txt`);
}

main();
