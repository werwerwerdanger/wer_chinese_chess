/**
 * 游戏控制器 — 状态管理 + 事件绑定 + 打谱回放
 */
import type { Move } from '@wer-chess/engine';
import type { EngineAdapter } from './engine-adapters/index.js';
import { drawBoard, xyToSquare, BOARD_PIXELS, type RenderOptions } from './renderer.js';

interface MoveRecord {
  /** 中文记谱（如 炮二平五），走子前生成 */
  notation: string;
  from: number;
  to: number;
  /** 该步之后的 FEN（回放跳转用） */
  fenAfter: string;
}

export class GameController {
  private selected: number | null = null;
  private legalFromSelected = new Set<number>();
  private records: MoveRecord[] = [];
  /** 当前回放位置（records.length = 最新；< length = 浏览历史中） */
  private viewIndex = 0;

  /** 当前生效的引擎（随对局模式切换） */
  private engine: EngineAdapter;
  private primaryEngine: EngineAdapter;

  private readonly opt: RenderOptions = {
    cell: 64,
    margin: 44,
    selected: null,
    legalTargets: new Set(),
    lastMove: null,
    checkedKing: null,
  };

  constructor(
    private readonly canvas: HTMLCanvasElement,
    engine: EngineAdapter,
    /** 可选的第二引擎（如 Pikafish），由对局模式下拉切换 */
    private readonly altEngine: EngineAdapter | null,
    /** 可选的第三引擎（本地 NNUE 蒸馏模型） */
    private readonly nnueEngine: EngineAdapter | null,
    private readonly statusBar: HTMLElement,
    private readonly moveList: HTMLElement,
    private readonly buttons: {
      undo: HTMLButtonElement; reset: HTMLButtonElement;
      prev: HTMLButtonElement; next: HTMLButtonElement;
      first: HTMLButtonElement; last: HTMLButtonElement;
      copyFen: HTMLButtonElement; loadFen: HTMLButtonElement; exportMoves: HTMLButtonElement;
    },
    private readonly fenInput: HTMLInputElement,
    private readonly mode: {
      select: HTMLSelectElement;      // 人机/人人
      aiDepth: HTMLSelectElement;     // AI 深度
    },
  ) {
    this.engine = engine;
    this.primaryEngine = engine;
    this.bindEvents();
    this.render();
    // 人机模式且轮到 AI（执黑）→ 开局即思考
    this.maybeAiMove();
  }

  /** 人机模式：AI 执黑（本地引擎 / Pikafish / NNUE 蒸馏模型） */
  private aiEnabled(): boolean {
    const v = this.mode.select.value;
    return v === 'pve' || v === 'pikafish' || v === 'nnue' || v === 'aivsai';
  }

  /** 该方是否由 AI 落子：人机模式 AI 执黑；AI 对下双方都是 AI */
  private aiPlaysSide(turn: 0 | 1): boolean {
    const v = this.mode.select.value;
    if (v === 'pvp') return false;
    if (v === 'aivsai') return true;
    return turn === 1;
  }

  private aiThinking = false;

  /** 对局模式切换：换引擎并对齐局面 */
  private onModeChange(): void {
    const v = this.mode.select.value;
    const next = v === 'pikafish' ? this.altEngine
      : v === 'nnue' ? this.nnueEngine
      : null;
    const target = next ?? this.primaryEngine;
    if (target && target !== this.engine) {
      target.loadFen(this.engine.getFen());
      this.engine = target;
    }
    this.render();
    this.maybeAiMove();
  }

  /** 轮到 AI 且局面未结束 → 异步思考并落子 */
  private maybeAiMove(): void {
    if (this.aiThinking) return;
    if (this.engine.gameOver()) return;
    const pos = this.engine.getPosition();
    if (!this.aiPlaysSide(pos.turn)) return; // 该方不由 AI 落子
    if (this.drawCheck()) return;            // 重复局面/步数上限判和，避免两个 AI 无限循环
    this.aiThinking = true;
    const side = pos.turn === 0 ? '红' : '黑';
    this.setStatus(`🤔 ${side}方 AI 思考中…`);
    // setTimeout 让状态栏先渲染；think 为异步（本地搜索 / UCI 桥接均适用）
    const beforeLen = this.records.length;
    const beforeView = this.viewIndex;
    setTimeout(async () => {
      try {
        const depth = Number(this.mode.aiDepth.value);
        const t = await this.engine.think(depth, 3000);
        // 等待期间用户可能重开/悔棋/回放切换引擎，局面已变则丢弃本次结果
        if (this.records.length !== beforeLen || this.viewIndex !== beforeView || this.viewIndex !== this.records.length) {
          return;
        }
        this.tryMove({ from: t.move.from, to: t.move.to });
        const v = this.mode.select.value;
        const who = v === 'aivsai' ? `${side}方` : v === 'pikafish' ? 'Pikafish' : v === 'nnue' ? '蒸馏模型' : 'AI';
        this.setStatus(`🤖 ${who}（深度${t.depth}，${t.nodes}节点，${t.timeMs}ms，评分${t.score > 0 ? '+' : ''}${Math.round(t.score)}｜红方视角）`);
      } catch (err) {
        this.setStatus(`❌ AI 出错：${(err as Error).message}`);
      } finally {
        this.aiThinking = false;
        this.maybeAiMove(); // AI 对下：连续走，直到终局 / 判和
      }
    }, 50);
  }

  /** AI 对下兜底：重复局面（同一 FEN 出现 3 次）或步数超限 → 判和，终止循环 */
  private drawCheck(): boolean {
    if (this.records.length >= 200) {
      this.setStatus('🤝 步数上限（200），判和');
      return true;
    }
    const fen = this.engine.getFen();
    let cnt = 0;
    for (const r of this.records) if (r.fenAfter === fen) cnt++;
    if (cnt >= 2) {
      this.setStatus('🤝 和棋（重复局面）');
      return true;
    }
    return false;
  }

  private bindEvents(): void {
    this.canvas.addEventListener('click', (e) => this.onClick(e));
    this.mode.select.addEventListener('change', () => this.onModeChange());
    this.buttons.undo.addEventListener('click', () => this.undo());
    this.buttons.reset.addEventListener('click', () => this.reset());
    this.buttons.first.addEventListener('click', () => this.seek(0));
    this.buttons.prev.addEventListener('click', () => this.seek(this.viewIndex - 1));
    this.buttons.next.addEventListener('click', () => this.seek(this.viewIndex + 1));
    this.buttons.last.addEventListener('click', () => this.seek(this.records.length));
    this.buttons.copyFen.addEventListener('click', () => this.copyFen());
    this.buttons.loadFen.addEventListener('click', () => this.loadFen());
    this.buttons.exportMoves.addEventListener('click', () => this.exportMoves());
    this.moveList.addEventListener('click', (e) => {
      const row = (e.target as HTMLElement).closest('[data-idx]');
      if (row) this.seek(Number((row as HTMLElement).dataset.idx) + 1);
    });
  }

  /** 浏览历史中的局面跳转（不影响 records） */
  private seek(n: number): void {
    const target = Math.max(0, Math.min(n, this.records.length));
    if (target === this.viewIndex) return;
    // 从记录重建：回到 target 步后的 FEN
    const fen = target === 0 ? this.startFen() : this.records[target - 1]!.fenAfter;
    this.engine.loadFen(fen);
    this.viewIndex = target;
    this.selected = null;
    this.legalFromSelected.clear();
    this.render();
  }

  private startFen(): string {
    // reset 后第一手前的 FEN：直接用当前局面反推不可靠，由外部维护
    // 这里简化：records[0] 走子前的局面 = startFen，用 engine.reset 后 getFen
    this.engine.reset();
    const fen = this.engine.getFen();
    // 恢复到 viewIndex
    this.replayTo(this.viewIndex);
    return fen;
  }

  /** 从头重放到第 n 步（engine 已 reset） */
  private replayTo(n: number): void {
    for (let i = 0; i < n; i++) {
      const rec = this.records[i]!;
      this.engine.makeMove({ from: rec.from, to: rec.to, captured: 0 as never });
    }
  }

  private onClick(e: MouseEvent): void {
    if (this.engine.gameOver()) return;
    if (this.aiThinking) return; // AI 思考中锁操作
    // 该方由 AI 落子 → 玩家不可操作（AI 对下时双方都锁）
    if (this.aiPlaysSide(this.engine.getPosition().turn)) return;
    // 处于回放态 → 先跳回最新
    if (this.viewIndex < this.records.length) {
      this.seek(this.records.length);
      return;
    }
    const rect = this.canvas.getBoundingClientRect();
    const scale = BOARD_PIXELS(this.opt) / rect.width;
    const x = (e.clientX - rect.left) * scale;
    const y = (e.clientY - rect.top) * scale;
    const sqIdx = xyToSquare(x, y, this.opt);
    if (sqIdx === null) return;

    const pos = this.engine.getPosition();
    const piece = pos.squares[sqIdx]!;

    if (this.selected !== null && this.legalFromSelected.has(sqIdx)) {
      this.tryMove({ from: this.selected, to: sqIdx });
      return;
    }

    const isOwnPiece = piece !== 255 && ((piece >> 3) & 1) === pos.turn;
    if (isOwnPiece) {
      this.selected = sqIdx;
      this.legalFromSelected = new Set(
        this.engine.legalMoves().filter((m) => m.from === sqIdx).map((m) => m.to),
      );
    } else {
      this.selected = null;
      this.legalFromSelected.clear();
    }
    this.render();
  }

  private tryMove(move: { from: number; to: number }): void {
    // 记谱须在走子前生成
    const notation = this.engine.describeMove(
      { from: move.from, to: move.to, captured: 0 as never } as Move,
    ) ?? `${move.from}→${move.to}`;
    try {
      this.engine.makeMove(move as never);
    } catch (err) {
      this.setStatus(`❌ ${(err as Error).message}`);
      return;
    }
    this.records.push({ notation, ...move, fenAfter: this.engine.getFen() });
    this.viewIndex = this.records.length;
    this.selected = null;
    this.legalFromSelected.clear();
    this.render();
    // 人机模式：轮到 AI → 思考
    this.maybeAiMove();
  }

  private undo(): void {
    if (this.aiThinking) return;
    // 人机模式：撤销 AI 一步 + 玩家一步，回到玩家上次行棋前
    const steps = this.aiEnabled() && this.records.length >= 2 ? 2 : 1;
    for (let i = 0; i < steps && this.records.length > 0; i++) {
      this.engine.undo();
      this.records.pop();
    }
    this.viewIndex = this.records.length;
    this.selected = null;
    this.legalFromSelected.clear();
    this.render();
  }

  private reset(): void {
    this.engine.reset();
    this.records = [];
    this.viewIndex = 0;
    this.selected = null;
    this.legalFromSelected.clear();
    this.render();
    this.maybeAiMove(); // FEN 载入后可能轮 AI
  }

  private copyFen(): void {
    const fen = this.engine.getFen();
    navigator.clipboard.writeText(fen).then(
      () => this.setStatus(`📋 FEN 已复制：${fen}`),
      () => { this.fenInput.value = fen; this.setStatus('剪贴板不可用，FEN 已填入输入框'); },
    );
  }

  private loadFen(): void {
    const fen = this.fenInput.value.trim();
    if (!fen) { this.setStatus('请先在输入框粘贴 FEN'); return; }
    try {
      this.engine.loadFen(fen);
      this.records = [];
      this.viewIndex = 0;
      this.selected = null;
      this.legalFromSelected.clear();
      this.render();
      this.setStatus('✅ 局面已载入');
    } catch (err) {
      this.setStatus(`❌ ${(err as Error).message}`);
    }
  }

  private exportMoves(): void {
    const text = this.records.map((r, i) => `${i + 1}. ${r.notation}`).join('，');
    navigator.clipboard.writeText(text).then(
      () => this.setStatus(`📋 棋谱已复制（${this.records.length} 手）`),
      () => { this.fenInput.value = text; this.setStatus('剪贴板不可用，棋谱已填入输入框'); },
    );
  }

  /** 供外部事件（如棋子 PNG 素材加载完成）触发的一帧重绘 */
  refresh(): void {
    this.render();
  }

  private render(): void {
    const pos = this.engine.getPosition();
    const viewing = this.viewIndex < this.records.length;
    const lastRec = viewing
      ? this.records[this.viewIndex - 1] ?? null
      : this.records[this.records.length - 1] ?? null;

    this.opt.selected = this.selected;
    this.opt.legalTargets = this.legalFromSelected;
    this.opt.lastMove = lastRec ? { from: lastRec.from, to: lastRec.to } : null;
    this.opt.checkedKing = this.engine.inCheck()
      ? findKing(pos.squares, pos.turn)
      : null;

    drawBoard(this.canvas.getContext('2d')!, pos.squares, this.opt);
    this.renderMoveList();
    this.updateStatus(pos.turn, viewing);
  }

  private renderMoveList(): void {
    this.moveList.innerHTML = '';
    for (let i = 0; i < this.records.length; i++) {
      const rec = this.records[i]!;
      const row = document.createElement('div');
      row.dataset.idx = String(i);
      const side = i % 2 === 0 ? '红' : '黑';
      row.textContent = `${Math.floor(i / 2) + 1}. ${side} ${rec.notation}`;
      if (i === this.viewIndex - 1) row.classList.add('current');
      this.moveList.appendChild(row);
    }
    // 只滚动列表自身（scrollIntoView 会连带滚动页面，导致画面抖动）
    const cur = this.moveList.querySelector('.current');
    if (cur) {
      const listRect = this.moveList.getBoundingClientRect();
      const rowRect = cur.getBoundingClientRect();
      this.moveList.scrollTop +=
        rowRect.top - listRect.top - (listRect.height - rowRect.height) / 2;
    }
  }

  private updateStatus(turn: 0 | 1, viewing: boolean): void {
    if (viewing) {
      this.setStatus(`⏪ 回放中（第 ${this.viewIndex}/${this.records.length} 手），点击棋盘回到最新`);
      return;
    }
    const over = this.engine.gameOver();
    if (over) {
      this.setStatus(over === 'red-win' ? '🎉 红方胜！' : '🎉 黑方胜！');
      return;
    }
    const side = turn === 0 ? '红方' : '黑方';
    const check = this.engine.inCheck() ? ' —— 将军！' : '';
    this.setStatus(`轮到 ${side} 走棋${check}`);
  }

  private setStatus(text: string): void {
    this.statusBar.textContent = text;
  }
}

function findKing(squares: ReadonlyArray<number>, turn: 0 | 1): number | null {
  const target = turn === 0 ? 0 : 8;
  for (let i = 0; i < 90; i++) {
    if (squares[i] === target) return i;
  }
  return null;
}
