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
    private readonly engine: EngineAdapter,
    private readonly statusBar: HTMLElement,
    private readonly moveList: HTMLElement,
    private readonly buttons: {
      undo: HTMLButtonElement; reset: HTMLButtonElement;
      prev: HTMLButtonElement; next: HTMLButtonElement;
      first: HTMLButtonElement; last: HTMLButtonElement;
      copyFen: HTMLButtonElement; loadFen: HTMLButtonElement; exportMoves: HTMLButtonElement;
    },
    private readonly fenInput: HTMLInputElement,
  ) {
    this.bindEvents();
    this.render();
  }

  private bindEvents(): void {
    this.canvas.addEventListener('click', (e) => this.onClick(e));
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

    const isOwnPiece = piece !== 255 && ((piece >> 3) & 1) !== pos.turn;
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
  }

  private undo(): void {
    this.engine.undo();
    this.records.pop();
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
    const cur = this.moveList.querySelector('.current');
    cur?.scrollIntoView({ block: 'nearest' });
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
