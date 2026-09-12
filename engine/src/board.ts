/**
 * 棋盘类 — 局面存储、FEN 解析/生成、make/unmake、Zobrist 增量哈希
 *
 * 性能设计：
 * - 90 格一维 Uint8Array，避免嵌套数组开销
 * - make/unmake 增量更新 Zobrist，不重算全盘
 * - 双方将位实时维护（kingSquare[2]），inCheck 判定 O(子数)
 */
import { Color, Piece, type Move, type UndoInfo, type HashKey } from './types.js';
import {
  BOARD_COLS, BOARD_ROWS, BOARD_SIZE, INITIAL_FEN, PIECE_TO_FEN_CHAR,
  ZOBRIST_PIECE, ZOBRIST_TURN, colOf, inPalace, pieceFromFenChar,
  rowOf, sq, KING_OF,
} from './constants.js';

export class Board {
  /** 90 格棋盘，值为 Piece 枚举 */
  readonly squares = new Uint8Array(BOARD_SIZE);

  /** 当前行棋方 */
  turn: Color = Color.Red;

  /** 双方将帅位置 */
  readonly kingSquare = new Int8Array(2).fill(-1);

  /** 当前局面 Zobrist 键 */
  hashKey: HashKey = 0n;

  constructor(fen: string = INITIAL_FEN) {
    this.loadFen(fen);
  }

  /** 从 FEN 载入局面 */
  loadFen(fen: string): void {
    this.squares.fill(Piece.None);
    this.kingSquare.fill(-1);
    this.hashKey = 0n;

    const [placement, side] = fen.trim().split(/\s+/);
    if (!placement) throw new Error(`bad FEN: ${fen}`);

    const rows = placement.split('/');
    if (rows.length !== BOARD_ROWS) throw new Error(`FEN 需要 10 行，得到 ${rows.length}`);

    for (let r = 0; r < BOARD_ROWS; r++) {
      let c = 0;
      for (const ch of rows[r]!) {
        if (c >= BOARD_COLS) throw new Error(`第 ${r} 行超宽: ${rows[r]}`);
        if (ch >= '1' && ch <= '9') {
          c += ch.charCodeAt(0) - 48;
        } else {
          const p = pieceFromFenChar(ch);
          if (p === Piece.None) throw new Error(`非法字符 '${ch}' in FEN`);
          this.setPiece(sq(r, c), p);
          c++;
        }
      }
      if (c !== BOARD_COLS) throw new Error(`第 ${r} 行宽度 ${c} ≠ 9`);
    }

    this.turn = side === 'b' ? Color.Black : Color.Red;
    this.hashKey ^= ZOBRIST_TURN[this.turn]!;

    if (this.kingSquare[0]! < 0 || this.kingSquare[1]! < 0) {
      throw new Error('FEN 缺少将/帅');
    }
  }

  /** 生成 FEN（round-trip 测试用） */
  toFen(): string {
    const rows: string[] = [];
    for (let r = 0; r < BOARD_ROWS; r++) {
      let row = '';
      let empty = 0;
      for (let c = 0; c < BOARD_COLS; c++) {
        const p = this.squares[sq(r, c)]!;
        if (p === Piece.None) {
          empty++;
        } else {
          if (empty > 0) { row += String(empty); empty = 0; }
          row += PIECE_TO_FEN_CHAR[p];
        }
      }
      if (empty > 0) row += String(empty);
      rows.push(row);
    }
    return `${rows.join('/')} ${this.turn === Color.Red ? 'w' : 'b'}`;
  }

  /** 放子（内部用，更新哈希与将位） */
  private setPiece(square: number, p: Piece): void {
    this.squares[square] = p;
    this.hashKey ^= ZOBRIST_PIECE[p]![square]!;
    if (p === Piece.RedKing) this.kingSquare[Color.Red] = square;
    else if (p === Piece.BlackKing) this.kingSquare[Color.Black] = square;
  }

  at(square: number): Piece {
    return this.squares[square]! as Piece;
  }

  /** 执行走子，返回撤销信息。调用方需保证 move 合法（由 movegen 产出）。 */
  makeMove(move: Move): UndoInfo {
    const undo: UndoInfo = {
      captured: this.at(move.to),
      hashKey: this.hashKey,
    };

    const moving = this.at(move.from);
    // 摘掉被吃子
    if (undo.captured !== Piece.None) {
      this.hashKey ^= ZOBRIST_PIECE[undo.captured]![move.to]!;
      if (undo.captured === Piece.RedKing) this.kingSquare[Color.Red] = -1;
      if (undo.captured === Piece.BlackKing) this.kingSquare[Color.Black] = -1;
    }
    // 摘走子
    this.hashKey ^= ZOBRIST_PIECE[moving]![move.from]!;
    // 放到目标格
    this.squares[move.from] = Piece.None;
    this.squares[move.to] = moving;
    this.hashKey ^= ZOBRIST_PIECE[moving]![move.to]!;
    if (moving === Piece.RedKing) this.kingSquare[Color.Red] = move.to;
    if (moving === Piece.BlackKing) this.kingSquare[Color.Black] = move.to;

    // 换边
    this.turn ^= 1;
    this.hashKey ^= ZOBRIST_TURN[0]! ^ ZOBRIST_TURN[1]!;

    return undo;
  }

  /** 撤销走子 */
  unmakeMove(move: Move, undo: UndoInfo): void {
    const moved = this.at(move.to);

    this.squares[move.from] = moved;
    this.squares[move.to] = undo.captured;

    if (moved === Piece.RedKing) this.kingSquare[Color.Red] = move.from;
    if (moved === Piece.BlackKing) this.kingSquare[Color.Black] = move.from;
    if (undo.captured === Piece.RedKing) this.kingSquare[Color.Red] = move.to;
    if (undo.captured === Piece.BlackKing) this.kingSquare[Color.Black] = move.to;

    this.turn ^= 1;
    this.hashKey = undo.hashKey;
  }

  /** 克隆局面 */
  clone(): Board {
    const b = Object.create(Board.prototype) as Board;
    (b.squares as Uint8Array).set(this.squares);
    b.turn = this.turn;
    (b.kingSquare as Int8Array).set(this.kingSquare);
    b.hashKey = this.hashKey;
    return b;
  }

  /** 将帅是否照面（同一列且中间无子）— 用于合法性判定 */
  kingsFacing(): boolean {
    const rk = this.kingSquare[Color.Red]!;
    const bk = this.kingSquare[Color.Black]!;
    if (rk < 0 || bk < 0) return false;
    const rc = colOf(rk), bc = colOf(bk);
    if (rc !== bc) return false;
    const rr = rowOf(rk), br = rowOf(bk);
    for (let r = br + 1; r < rr; r++) {
      if (this.squares[sq(r, rc)] !== Piece.None) return false;
    }
    return true;
  }

  /** 简易局面文本渲染（终端调试用） */
  ascii(): string {
    const files = '  0 1 2 3 4 5 6 7 8';
    const sep = '  +------------------------+';
    const lines = [files, sep];
    for (let r = 0; r < BOARD_ROWS; r++) {
      let row = `${r} |`;
      for (let c = 0; c < BOARD_COLS; c++) {
        const p = this.squares[sq(r, c)]!;
        const ch = p === Piece.None ? '.' : (PIECE_TO_FEN_CHAR[p] ?? '?');
        row += ch === '.' ? ' .' : (ch === ch.toUpperCase() ? ` ${ch}` : ` ${ch}`);
      }
      row += ' |';
      lines.push(row);
    }
    lines.push(sep);
    lines.push(`  turn: ${this.turn === Color.Red ? 'Red' : 'Black'}`);
    return lines.join('\n');
  }

  /** 校验局面内部一致性（测试用） */
  validateConsistency(): void {
    for (let s = 0; s < BOARD_SIZE; s++) {
      const p = this.squares[s]!;
      if (p !== Piece.None && (p & 7) === 0 && p !== Piece.RedKing && p !== Piece.BlackKing) {
        throw new Error(`格 ${s} 非法棋子编码 ${p}`);
      }
    }
    // 重算 Zobrist 对账
    let h = 0n;
    for (let s = 0; s < BOARD_SIZE; s++) {
      const p = this.squares[s]!;
      if (p !== Piece.None) h ^= ZOBRIST_PIECE[p]![s]!;
    }
    h ^= ZOBRIST_TURN[this.turn]!;
    if (h !== this.hashKey) throw new Error('Zobrist 键与棋盘不一致');
    // 将位对账
    for (let s = 0; s < BOARD_SIZE; s++) {
      if (this.squares[s] === Piece.RedKing && this.kingSquare[Color.Red] !== s)
        throw new Error('红帅位置缓存失效');
      if (this.squares[s] === Piece.BlackKing && this.kingSquare[Color.Black] !== s)
        throw new Error('黑将位置缓存失效');
    }
    // 将必须在九宫
    for (const c of [Color.Red, Color.Black] as const) {
      const ks = this.kingSquare[c]!;
      if (ks >= 0 && !inPalace(rowOf(ks), colOf(ks), c)) throw new Error('将不在九宫');
    }
  }
}

export { KING_OF };
