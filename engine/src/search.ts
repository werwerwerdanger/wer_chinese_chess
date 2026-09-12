/**
 * Alpha-Beta 搜索引擎 v1 — 迭代加深 + 置换表 + MVV-LVA 排序
 *
 * 架构（negamax 变体，每层取反视角分数）：
 *   searchRoot(depth) 迭代加深 1..depth，每层用上一层的最佳走法优先排序
 *   alphabeta(depth, alpha, beta) 主体
 *   quiescence(depth) 静态搜索：叶子节点只搜吃子，防水平线效应
 *
 * 置换表：Zobrist 键 → {depth, score, flag, bestMove}
 *   flag: EXACT(精确) / LOWER(beta截断) / UPPER(alpha截断)
 *
 * 性能目标：初始局面 depth 4 < 1s（TS 单线程）
 */
import type { Board } from './board.js';
import type { Move, SearchResult, UndoInfo } from './types.js';
import { generatePseudoLegalMoves } from './movegen.js';
import { inCheck } from './legality.js';
import { evaluate, mvvlva, MATE_SCORE } from './eval.js';

/** 无走子哨兵 */
const NO_MOVE: Move = { from: -1, to: -1, captured: 255 as never };

const enum TTFlag { Exact = 0, Lower = 1, Upper = 2 }

interface TTEntry {
  depth: number;
  score: number;
  flag: TTFlag;
  bestMove: Move;
}

export class Searcher {
  private readonly board: Board;
  private readonly tt = new Map<bigint, TTEntry>();
  private readonly ttMax: number;
  private nodes = 0;
  private readonly history = new Map<string, number>(); // "from-to" → 排序分

  /** 搜索中检出（当前走子方被将死/困毙）时由 makeMove 感知 */
  private searchAborted = false;

  constructor(board: Board, ttMax = 1 << 18) {
    this.board = board;
    this.ttMax = ttMax;
  }

  /** 清空置换表（新对局/悔棋后调用，防止跨局面污染） */
  clear(): void {
    this.tt.clear();
    this.history.clear();
  }

  /**
   * 迭代加深搜索入口。
   * @param maxDepth 最大深度
   * @param timeLimitMs 时间上限（默认 3s，软限制，在节点间检查）
   */
  search(maxDepth: number, timeLimitMs = 3000): SearchResult {
    const start = Date.now();
    this.nodes = 0;
    this.searchAborted = false;

    let best: Move = NO_MOVE;
    let bestScore = 0;
    let completedDepth = 0;

    for (let depth = 1; depth <= maxDepth; depth++) {
      const deadlineHit = () => Date.now() - start > timeLimitMs;
      const result = this.searchRoot(depth, deadlineHit);
      if (this.searchAborted) break; // 时间到，丢弃未完成的这一层
      best = result.move;
      bestScore = result.score;
      completedDepth = depth;
      // 已找到必胜/必败，无需更深
      if (Math.abs(bestScore) >= MATE_SCORE - 100) break;
    }

    return {
      bestMove: best.from >= 0 ? best : null,
      score: bestScore,
      depth: completedDepth,
      nodes: this.nodes,
      timeMs: Date.now() - start,
    };
  }

  private searchRoot(depth: number, deadlineHit: () => boolean): { move: Move; score: number } {
    const side = this.board.turn;
    const sign = side === 0 ? 1 : -1; // evaluate 是红方视角，negamax 需要当前方视角
    const moves = this.orderedRootMoves();

    let bestMove = moves[0] ?? NO_MOVE;
    let bestScore = -Infinity;

    for (const m of moves) {
      if (deadlineHit()) { this.searchAborted = true; return { move: bestMove, score: bestScore }; }
      const undo = this.board.makeMove(m);
      // 走完对手被将死/困毙 → 极大分（考虑剩余深度让快杀优先）
      let score: number;
      if (this.noMovesFor(this.board.turn)) {
        score = (MATE_SCORE - depth) * (side === 0 ? 1 : -1) * sign;
      } else {
        score = -this.alphabeta(depth - 1, -Infinity, Infinity, sign === 1 ? -1 : 1, deadlineHit);
      }
      this.board.unmakeMove(m, undo);

      if (this.searchAborted) return { move: bestMove, score: bestScore };
      if (score > bestScore) {
        bestScore = score;
        bestMove = m;
      }
    }
    return { move: bestMove, score: bestScore };
  }

  /**
   * negamax alpha-beta 主体。sign = 当前方视角系数（红+1/黑-1）。
   */
  private alphabeta(
    depth: number,
    alpha: number,
    beta: number,
    sign: number,
    deadlineHit: () => boolean,
  ): number {
    this.nodes++;

    // 重复局面（Zobrist 相同）判和 → 0 分。简化处理：当前 hash 出现在 TT 的 Exact 表项
    // （更严谨需要历史 hash 列表；v1 从简）

    if (depth <= 0) {
      return sign * this.quiescence(alpha, beta, sign, 4, deadlineHit);
    }

    const key = this.board.hashKey;
    const ttEntry = this.tt.get(key);
    if (ttEntry && ttEntry.depth >= depth) {
      if (ttEntry.flag === TTFlag.Exact) return ttEntry.score;
      if (ttEntry.flag === TTFlag.Lower && ttEntry.score >= beta) return ttEntry.score;
      if (ttEntry.flag === TTFlag.Upper && ttEntry.score <= alpha) return ttEntry.score;
    }

    const checked = inCheck(this.board, this.board.turn);
    // 将军延伸：被将军时加深一层（不白算）
    if (checked && depth < 3) depth++;

    const moves = this.orderedMoves(ttEntry?.bestMove);
    let bestScore = -Infinity;
    let bestMove = NO_MOVE;
    let searched = 0;
    const alphaOrig = alpha;

    for (const m of moves) {
      if ((this.nodes & 1023) === 0 && deadlineHit()) {
        this.searchAborted = true;
        return alpha; // 返回当前界，丢弃本层
      }
      const undo = this.board.makeMove(m);
      let score: number;
      if (this.noMovesFor(this.board.turn)) {
        // 对手无棋可走：将死/困毙 → 对当前方大优
        score = MATE_SCORE - depth;
      } else {
        score = -this.alphabeta(depth - 1, -beta, -alpha, -sign, deadlineHit);
      }
      this.board.unmakeMove(m, undo);
      searched++;

      if (this.searchAborted) return alpha;

      if (score > bestScore) {
        bestScore = score;
        bestMove = m;
        if (score > alpha) alpha = score;
        if (alpha >= beta) {
          // beta 截断：记录历史启发
          const hk = `${m.from}-${m.to}`;
          this.history.set(hk, (this.history.get(hk) ?? 0) + depth * depth);
          break;
        }
      }
    }

    if (searched === 0) {
      // 自己无棋可走（将死/困毙）→ 大负分
      return -MATE_SCORE + depth;
    }

    // 写置换表
    if (!this.searchAborted) {
      const flag = bestScore <= alphaOrig ? TTFlag.Upper
        : bestScore >= beta ? TTFlag.Lower
        : TTFlag.Exact;
      if (this.tt.size >= this.ttMax) this.evictTT();
      this.tt.set(key, { depth, score: bestScore, flag, bestMove });
    }

    return bestScore;
  }

  /** 静态搜索：只延伸吃子着法，直到局面安静 */
  private quiescence(
    alpha: number,
    beta: number,
    sign: number,
    qdepth: number,
    deadlineHit: () => boolean,
  ): number {
    this.nodes++;
    const standPat = sign * evaluate(this.board);
    if (qdepth <= 0 || (this.nodes & 1023) === 0 && deadlineHit()) {
      this.searchAborted = this.searchAborted || (this.nodes & 1023) === 0 && deadlineHit();
      return standPat;
    }
    if (standPat >= beta) return standPat; // 静态截断
    if (standPat > alpha) alpha = standPat;

    // 只搜吃子
    const captures = generatePseudoLegalMoves(this.board, this.board.turn)
      .filter((m) => m.captured !== 255)
      .sort((a, b) => this.captureScore(b) - this.captureScore(a));

    for (const m of captures) {
      const undo = this.board.makeMove(m);
      // 走完自己被将军 → 非法，跳过（伪合法过滤）
      if (inCheck(this.board, this.board.turn === 0 ? 1 : 0)) {
        this.board.unmakeMove(m, undo);
        continue;
      }
      const score = -this.quiescence(-beta, -alpha, -sign, qdepth - 1, deadlineHit);
      this.board.unmakeMove(m, undo);
      if (score >= beta) return score;
      if (score > alpha) alpha = score;
    }
    return alpha;
  }

  /** side 方是否无合法走子（将死/困毙判定） */
  private noMovesFor(side: 0 | 1): boolean {
    const pseudo = generatePseudoLegalMoves(this.board, side);
    for (const m of pseudo) {
      const undo = this.board.makeMove(m);
      const ok = !inCheck(this.board, side) && !this.board.kingsFacing();
      this.board.unmakeMove(m, undo);
      if (ok) return false;
    }
    return true;
  }

  private captureScore(m: Move): number {
    return mvvlva(m.captured, this.board.at(m.from));
  }

  /** 根节点排序：置换表最佳 + 历史 + 吃子 */
  private orderedRootMoves(): Move[] {
    const ttBest = this.tt.get(this.board.hashKey)?.bestMove;
    return this.legalMovesSorted(ttBest);
  }

  private orderedMoves(ttBest: Move | undefined): Move[] {
    return this.legalMovesSorted(ttBest);
  }

  /** 生成合法走子并排序：TT最佳 > 吃子(MVV-LVA) > 历史启发 */
  private legalMovesSorted(ttBest: Move | undefined): Move[] {
    const side = this.board.turn;
    const pseudo = generatePseudoLegalMoves(this.board, side);
    const legal: Move[] = [];
    for (const m of pseudo) {
      const undo = this.board.makeMove(m);
      if (!inCheck(this.board, side) && !this.board.kingsFacing()) legal.push(m);
      this.board.unmakeMove(m, undo);
    }
    return legal.sort((a, b) => {
      // TT 最佳最优先
      if (ttBest && a.from === ttBest.from && a.to === ttBest.to) return -1;
      if (ttBest && b.from === ttBest.from && b.to === ttBest.to) return 1;
      const ca = a.captured !== 255 ? this.captureScore(a) : 0;
      const cb = b.captured !== 255 ? this.captureScore(b) : 0;
      if (ca !== cb) return cb - ca;
      // 历史启发
      const ha = this.history.get(`${a.from}-${a.to}`) ?? 0;
      const hb = this.history.get(`${b.from}-${b.to}`) ?? 0;
      return hb - ha;
    });
  }

  private evictTT(): void {
    // 简单策略：清掉一半（Map 无序，近似随机驱逐）
    let i = 0;
    for (const k of this.tt.keys()) {
      this.tt.delete(k);
      if (++i >= this.ttMax / 2) break;
    }
  }
}

/** 便捷函数：给局面找最佳走子 */
export function findBestMove(board: Board, depth = 4, timeLimitMs = 3000): SearchResult {
  const s = new Searcher(board);
  return s.search(depth, timeLimitMs);
}
