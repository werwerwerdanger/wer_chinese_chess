/**
 * 游戏控制器 — 状态管理 + 事件绑定
 */
import type { Move } from '@wer-chess/engine';
import type { EngineAdapter } from './engine-adapters/index.js';
import { drawBoard, xyToSquare, BOARD_PIXELS, type RenderOptions } from './renderer.js';

export class GameController {
  private selected: number | null = null;
  private legalFromSelected = new Set<number>();
  private lastMove: { from: number; to: number } | null = null;
  private moveCount = 0;

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
    private readonly buttons: { undo: HTMLButtonElement; reset: HTMLButtonElement },
  ) {
    this.bindEvents();
    this.render();
  }

  private bindEvents(): void {
    this.canvas.addEventListener('click', (e) => this.onClick(e));
    this.buttons.undo.addEventListener('click', () => this.undo());
    this.buttons.reset.addEventListener('click', () => this.reset());
  }

  private onClick(e: MouseEvent): void {
    if (this.engine.gameOver()) return;
    const rect = this.canvas.getBoundingClientRect();
    const scale = BOARD_PIXELS(this.opt) / rect.width;
    const x = (e.clientX - rect.left) * scale;
    const y = (e.clientY - rect.top) * scale;
    const sqIdx = xyToSquare(x, y, this.opt);
    if (sqIdx === null) return;

    const pos = this.engine.getPosition();
    const piece = pos.squares[sqIdx]!;

    // 已选中 → 尝试落子
    if (this.selected !== null && this.legalFromSelected.has(sqIdx)) {
      this.tryMove({ from: this.selected, to: sqIdx });
      return;
    }

    // 点己方子 → 选中（红=0：bit3=0；黑=1）
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
    try {
      this.engine.makeMove(move as Move);
      this.lastMove = { from: move.from, to: move.to };
      this.moveCount++;
      this.selected = null;
      this.legalFromSelected.clear();
      this.appendMoveList(move);
    } catch (err) {
      this.setStatus(`❌ ${(err as Error).message}`);
    }
    this.render();
  }

  private undo(): void {
    if (this.engine.undo()) {
      // 弹走着法列表最后一行
      const rows = this.moveList.querySelectorAll('div');
      if (rows.length > 0) rows[rows.length - 1]!.remove();
      this.moveCount = Math.max(0, this.moveCount - 1);
      this.selected = null;
      this.legalFromSelected.clear();
      this.lastMove = null; // 简化：悔棋后不显示上一步标记
    }
    this.render();
  }

  private reset(): void {
    this.engine.reset();
    this.selected = null;
    this.legalFromSelected.clear();
    this.lastMove = null;
    this.moveCount = 0;
    this.moveList.innerHTML = '';
    this.render();
  }

  private appendMoveList(move: { from: number; to: number }): void {
    const pos = this.engine.getPosition();
    const side = pos.turn === 1 ? '红' : '黑'; // 走完已换手，故取反
    const desc = `${this.moveCount}. ${side}：${describe(move)}`;
    const row = document.createElement('div');
    row.textContent = desc;
    this.moveList.appendChild(row);
    this.moveList.scrollTop = this.moveList.scrollHeight;
  }

  private render(): void {
    const pos = this.engine.getPosition();
    this.opt.selected = this.selected;
    this.opt.legalTargets = this.legalFromSelected;
    this.opt.lastMove = this.lastMove;
    // 被将军高亮：当前行棋方的将位
    this.opt.checkedKing = this.engine.inCheck()
      ? findKing(pos.squares, pos.turn)
      : null;

    drawBoard(this.canvas.getContext('2d')!, pos.squares, this.opt);
    this.updateStatus(pos.turn);
  }

  private updateStatus(turn: 0 | 1): void {
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

function describe(move: { from: number; to: number }): string {
  const f = `${Math.floor(move.from / 9)},${move.from % 9}`;
  const t = `${Math.floor(move.to / 9)},${move.to % 9}`;
  return `(${f})→(${t})`;
}

function findKing(squares: ReadonlyArray<number>, turn: 0 | 1): number | null {
  // 红帅=0，黑将=8；turn 是当前行棋方（被将军方）
  const target = turn === 0 ? 0 : 8;
  for (let i = 0; i < 90; i++) {
    if (squares[i] === target) return i;
  }
  return null;
}
