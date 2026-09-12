/**
 * Canvas 棋盘渲染器 — 纯函数式绘制，不做状态管理
 *
 * 坐标约定（与引擎一致）：
 *   引擎 (row, col) → 画布 (x, y) = (margin + col*cell, margin + row*cell)
 *   row 0 在画面顶部（黑方），row 9 在底部（红方）
 */
import { PIECE_NAMES, type Piece } from '@wer-chess/engine';

// ---------------------------------------------------------------------------
// PNG 棋子素材（scripts/gen_pieces.py 生成），按 Piece 编码缓存
// ---------------------------------------------------------------------------
const PIECE_IMG_FILES: Record<number, string> = {
  0: 'red_king', 1: 'red_advisor', 2: 'red_elephant', 3: 'red_horse',
  4: 'red_rook', 5: 'red_cannon', 6: 'red_pawn',
  8: 'black_king', 9: 'black_advisor', 10: 'black_elephant', 11: 'black_horse',
  12: 'black_rook', 13: 'black_cannon', 14: 'black_pawn',
};

const pieceImages = new Map<number, HTMLImageElement>();
let imagesReady = false;
/** 素材全部就绪后调用（GameController 用于触发一次重绘） */
let onImagesReady: (() => void) | null = null;

export function setOnImagesReady(cb: () => void): void {
  onImagesReady = cb;
  if (imagesReady) cb(); // 已就绪则立即触发
}

/** 预加载全部棋子 PNG；全部就绪前 drawPiece 回退到 Canvas 手绘 */
export function preloadPieceImages(): void {
  let pending = Object.keys(PIECE_IMG_FILES).length;
  const done = () => {
    if (--pending === 0) { imagesReady = true; onImagesReady?.(); }
  };
  for (const [code, file] of Object.entries(PIECE_IMG_FILES)) {
    const img = new Image();
    img.onload = () => { pieceImages.set(Number(code), img); done(); };
    img.onerror = done; // 单张失败不阻塞，该棋子保持手绘
    img.src = `/pieces/${file}.png`;
  }
}

export interface RenderOptions {
  cell: number;       // 格子边长 px
  margin: number;     // 棋盘留白 px
  selected: number | null;         // 选中的格子 index
  legalTargets: ReadonlySet<number>; // 可落子格 index 集合
  lastMove: { from: number; to: number } | null;
  checkedKing: number | null;     // 被将军的将位 index（红色高亮）
}

export const BOARD_PIXELS = (opt: RenderOptions) =>
  opt.margin * 2 + opt.cell * 8; // 棋盘线宽 8 格

export function squareToXY(sqIdx: number, opt: RenderOptions): { x: number; y: number } {
  const row = Math.floor(sqIdx / 9);
  const col = sqIdx % 9;
  return { x: opt.margin + col * opt.cell, y: opt.margin + row * opt.cell };
}

export function xyToSquare(x: number, y: number, opt: RenderOptions): number | null {
  const col = Math.round((x - opt.margin) / opt.cell);
  const row = Math.round((y - opt.margin) / opt.cell);
  if (row < 0 || row > 9 || col < 0 || col > 8) return null;
  // 圆形棋子判定：点击点距交点不超过 0.45 格
  const cx = opt.margin + col * opt.cell;
  const cy = opt.margin + row * opt.cell;
  const dist = Math.hypot(x - cx, y - cy);
  if (dist > opt.cell * 0.45) return null;
  return row * 9 + col;
}

/** 画整帧 */
export function drawBoard(
  ctx: CanvasRenderingContext2D,
  squares: ReadonlyArray<number>,
  opt: RenderOptions,
): void {
  const size = BOARD_PIXELS(opt);
  ctx.clearRect(0, 0, size, size);

  // 背景木纹色
  ctx.fillStyle = '#f0d9b5';
  ctx.fillRect(0, 0, size, size);

  drawGrid(ctx, opt);
  drawDecorations(ctx, opt);
  drawHighlights(ctx, opt);
  drawPieces(ctx, squares, opt);
}

function drawGrid(ctx: CanvasRenderingContext2D, opt: RenderOptions): void {
  ctx.strokeStyle = '#5b3a1e';
  ctx.lineWidth = 1.5;

  // 横线 10 条
  for (let row = 0; row < 10; row++) {
    const y = opt.margin + row * opt.cell;
    line(ctx, opt.margin, y, opt.margin + 8 * opt.cell, y);
  }
  // 竖线 9 条（中间 7 条分上下两段，因楚河汉界断开）
  for (let col = 0; col < 9; col++) {
    const x = opt.margin + col * opt.cell;
    if (col === 0 || col === 8) {
      line(ctx, x, opt.margin, x, opt.margin + 9 * opt.cell);
    } else {
      line(ctx, x, opt.margin, x, opt.margin + 4 * opt.cell);
      line(ctx, x, opt.margin + 5 * opt.cell, x, opt.margin + 9 * opt.cell);
    }
  }
  // 外框加粗
  ctx.lineWidth = 3;
  ctx.strokeRect(opt.margin, opt.margin, 8 * opt.cell, 9 * opt.cell);
}

function drawDecorations(ctx: CanvasRenderingContext2D, opt: RenderOptions): void {
  // 楚河汉界
  const midY = opt.margin + 4.5 * opt.cell;
  ctx.fillStyle = '#8b5a2b';
  ctx.font = `${Math.floor(opt.cell * 0.42)}px "KaiTi", "STKaiti", serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('楚 河', opt.margin + 2 * opt.cell, midY);
  ctx.fillText('汉 界', opt.margin + 6 * opt.cell, midY);

  // 炮位/兵位标记（小折角）
  const marks: Array<[number, number]> = [
    [2, 1], [2, 7], [3, 0], [3, 2], [3, 4], [3, 6], [3, 8], // 黑方
    [6, 0], [6, 2], [6, 4], [6, 6], [6, 8],                  // 红兵
    [7, 1], [7, 7],                                           // 红炮
  ];
  ctx.strokeStyle = '#5b3a1e';
  ctx.lineWidth = 1;
  for (const [row, col] of marks) {
    const x = opt.margin + col * opt.cell;
    const y = opt.margin + row * opt.cell;
    cross(ctx, x, y, opt.cell * 0.12);
  }

  // 九宫斜线
  ctx.lineWidth = 1.5;
  const palace = (r1: number, r2: number) => {
    const x1 = opt.margin + 3 * opt.cell, x2 = opt.margin + 5 * opt.cell;
    const y1 = opt.margin + r1 * opt.cell, y2 = opt.margin + r2 * opt.cell;
    line(ctx, x1, y1, x2, y2);
    line(ctx, x1, y2, x2, y1);
  };
  palace(0, 2);
  palace(7, 9);
}

function drawHighlights(ctx: CanvasRenderingContext2D, opt: RenderOptions): void {
  // 上一步走子标记
  if (opt.lastMove) {
    ctx.strokeStyle = 'rgba(60, 130, 60, 0.7)';
    ctx.lineWidth = 2.5;
    for (const s of [opt.lastMove.from, opt.lastMove.to]) {
      const { x, y } = squareToXY(s, opt);
      ctx.strokeRect(x - opt.cell * 0.38, y - opt.cell * 0.38, opt.cell * 0.76, opt.cell * 0.76);
    }
  }
  // 选中格
  if (opt.selected !== null) {
    const { x, y } = squareToXY(opt.selected, opt);
    ctx.strokeStyle = '#1a6ee0';
    ctx.lineWidth = 3;
    ctx.strokeRect(x - opt.cell * 0.4, y - opt.cell * 0.4, opt.cell * 0.8, opt.cell * 0.8);
  }
  // 可落子点
  ctx.fillStyle = 'rgba(30, 140, 30, 0.55)';
  for (const t of opt.legalTargets) {
    const { x, y } = squareToXY(t, opt);
    ctx.beginPath();
    ctx.arc(x, y, opt.cell * 0.11, 0, Math.PI * 2);
    ctx.fill();
  }
  // 被将军的王
  if (opt.checkedKing !== null) {
    const { x, y } = squareToXY(opt.checkedKing, opt);
    ctx.strokeStyle = '#d93025';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(x, y, opt.cell * 0.46, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function drawPieces(ctx: CanvasRenderingContext2D, squares: ReadonlyArray<number>, opt: RenderOptions): void {
  for (let i = 0; i < 90; i++) {
    const p = squares[i]!;
    if (p === 255) continue; // Piece.None
    const { x, y } = squareToXY(i, opt);
    drawPiece(ctx, x, y, p as Piece, opt);
  }
}

function drawPiece(ctx: CanvasRenderingContext2D, x: number, y: number, piece: Piece, opt: RenderOptions): void {
  // PNG 素材路径
  const img = imagesReady ? pieceImages.get(piece) : undefined;
  if (img) {
    const size = opt.cell * 0.92;
    ctx.drawImage(img, x - size / 2, y - size / 2, size, size);
    return;
  }
  // 回退：Canvas 手绘（素材未加载/加载失败时）
  const r = opt.cell * 0.42;
  const isRed = ((piece >> 3) & 1) === 0;

  // 阴影
  ctx.beginPath();
  ctx.arc(x + 2, y + 3, r, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.fill();

  // 棋子底
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = '#fae7c3';
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = isRed ? '#c0392b' : '#1a1a1a';
  ctx.stroke();
  // 内圈
  ctx.beginPath();
  ctx.arc(x, y, r * 0.82, 0, Math.PI * 2);
  ctx.lineWidth = 1;
  ctx.stroke();

  // 文字
  const ch = PIECE_NAMES[piece] ?? '?';
  ctx.fillStyle = isRed ? '#c0392b' : '#1a1a1a';
  ctx.font = `bold ${Math.floor(r * 1.05)}px "KaiTi", "STKaiti", "SimSun", serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(ch, x, y + r * 0.04);
}

function line(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number): void {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

/** 炮兵位的四角小折线（交点四周的 L 形标记） */
function cross(ctx: CanvasRenderingContext2D, x: number, y: number, d: number): void {
  const corners: Array<[number, number]> = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
  for (const [sx, sy] of corners) {
    const cx = x + sx * d;  // 折线拐角点
    const cy = y + sy * d;
    ctx.beginPath();
    ctx.moveTo(cx, cy + sy * d * 0.8); // 竖线段
    ctx.lineTo(cx, cy);
    ctx.lineTo(cx + sx * d * 0.8, cy); // 横线段
    ctx.stroke();
  }
}
