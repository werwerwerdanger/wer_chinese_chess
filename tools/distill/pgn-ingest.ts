/**
 * 蒸馏数据源扩展 —— 中文记法 PGN 棋谱回放
 *
 * 输入：datasets/ccpd/Dataset/ 下的大师对局 PGN（中文纵线记法，如"炮二平五"）
 * 过程：按 FEN 建 Board → 逐着解析中文记法 → 合法性校验（generateLegalMoves）→ 回放
 * 输出：data/positions-web.txt（每行一个 FEN，全局去重）
 *
 * 用法（esbuild 打包后）：
 *   node tools/distill/pgn-ingest.mjs --root <pgn目录> --out data/positions-web.txt [--limit 500]
 *
 * 解析规则（与引擎坐标约定一致）：
 *   红方纵线 一..九 = col 8..0；黑方 1..9 = col 8..0
 *   直线子（车炮帅兵）进/退 N = 行数；斜行子（马相仕）进/退后跟目标纵线
 *   前/中/後 处理同列同名子歧义；最终合法性一律由 generateLegalMoves 兜底
 */
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { Board, generateLegalMoves, Color } from '@wer-chess/engine';
import type { Move } from '@wer-chess/engine';

/** 编码探测：utf8(严格) → big5 → gb18030（数据源是台湾/大陆混合） */
function decodeAuto(buf: Buffer): string {
  for (const enc of ['utf-8', 'big5', 'gb18030'] as const) {
    try {
      return new TextDecoder(enc, { fatal: true }).decode(buf);
    } catch { /* 试下一个 */ }
  }
  return buf.toString('utf8');
}

// ---------- 记法元素表 ----------

/** 棋子名 → 类型（0帅/仕/相... 与 PieceType 一致：King Advisor Elephant Horse Rook Cannon Pawn） */
const PIECE_CHARS: Record<string, number> = {
  // 红（繁/简都收）
  '帥': 0, '帅': 0, '仕': 1, '相': 2, '馬': 3, '马': 3, '車': 4, '车': 4, '炮': 5, '兵': 6,
  // 黑
  '將': 0, '将': 0, '士': 1, '象': 2, '馬': 3, '车': 4, '砲': 5, '卒': 6,
};

const NUM_CN: Record<string, number> = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };

function parseNum(ch: string): number {
  if (NUM_CN[ch] !== undefined) return NUM_CN[ch];
  const d = ch.charCodeAt(0);
  // 全角 １-９ (FF11-FF19) 与半角
  if (d >= 0xFF10 && d <= 0xFF19) return d - 0xFF10;
  if (d >= 48 && d <= 57) return d - 48;
  return -1;
}

function colFromNum(n: number, side: 0 | 1): number {
  // 红：一(1)=col8 ... 九(9)=col0；黑：1=col0 ... 9=col8（黑方从自己右手数）
  return side === 0 ? 8 - (n - 1) : n - 1;
}

// ---------- 中文记法 → 着法 ----------

// 注意：带 前/後/中 前缀时 from 纵线可省略（标准记法"前馬進五"），该组可选
const MOVE_RE = /^(前|後|后|中)?([帥帅將将仕士相象馬马车車炮砲兵卒])([一二三四五六七八九１２３４５６７８９1-9])?([平進进退])([一二三四五六七八九１２３４５６７８９1-9])$/;

/** 纵线号 → 列号。红方恒为 一(1)=col8..九(9)=col0；
 * 黑方两岸数据集不统一：A=从黑右手数(1=col0)，B=与红同向(1=col8)。同一局内必然只用一种。 */
function colOf(n: number, side: 0 | 1, mode: 'A' | 'B'): number {
  if (side === 0) return 8 - (n - 1);
  return mode === 'A' ? n - 1 : 8 - (n - 1);
}

/** 解析一条中文记法（单一映射 mode）；失败返回 null。合法性由 generateLegalMoves 兜底。 */
function parseChineseMove(board: Board, token: string, mode: 'A' | 'B'): Move | null {
  const m = MOVE_RE.exec(token.trim());
  if (!m) return null;
  const [, prefix, pieceCh, fromNumCh, action, toNumCh] = m as unknown as [string, string, string, string, string, string];

  const type = PIECE_CHARS[pieceCh];
  if (type === undefined) return null;
  const side = board.turn as 0 | 1;
  const fromN = fromNumCh ? parseNum(fromNumCh) : 0;
  const toN = toNumCh ? parseNum(toNumCh) : -1;
  if (fromN < 0 || toN < 1) return null;

  const squares = board.squares;
  const cands: number[] = [];
  if (fromN >= 1) {
    // 指定 from 纵线：该列上所有同色同类子
    const fc = colOf(fromN, side, mode);
    if (fc < 0 || fc > 8) return null;
    for (let r = 0; r < 10; r++) {
      const p = squares[r * 9 + fc]!;
      if (p !== 255 && (p >> 3 & 1) === side && (p & 7) === type) cands.push(r * 9 + fc);
    }
  } else {
    // 前/後/中 省略 from 纵线：全盘同色同类子
    for (let r = 0; r < 10; r++) {
      for (let c = 0; c < 9; c++) {
        const p = squares[r * 9 + c]!;
        if (p !== 255 && (p >> 3 & 1) === side && (p & 7) === type) cands.push(r * 9 + c);
      }
    }
  }
  if (cands.length === 0) return null;

  // 前/後/中 消歧（红前=行号小，黑前=行号大）；无前缀时保留全部候选，
  // 由合法着唯一性裁决（另一个往往走不了这一步）
  let froms: number[];
  if (cands.length > 1 && prefix) {
    const sorted = [...cands].sort((a, b) => (a - b) * (side === 0 ? 1 : -1));
    if (prefix === '前') froms = [sorted[0]!];
    else if (prefix === '後' || prefix === '后') froms = [sorted[sorted.length - 1]!];
    else froms = [sorted[Math.floor(sorted.length / 2)]!];
  } else {
    froms = cands;
  }

  const legal = generateLegalMoves(board, board.turn as Color);
  const forward = side === 0 ? -1 : 1;
  const tcWant = colOf(toN, side, mode);
  const matches: Move[] = [];
  for (const from of froms) {
    const fr = Math.floor(from / 9), fc2 = from % 9;
    for (const mv of legal) {
      if (mv.from !== from) continue;
      const tr = Math.floor(mv.to / 9), tc = mv.to % 9;
      if (action === '平') {
        if (tr === fr && tc === tcWant) matches.push(mv);
        continue;
      }
      const adv = action === '進' || action === '进';
      const dr = tr - fr;
      const dirOk = adv ? Math.sign(dr) === forward : Math.sign(dr) === -forward;
      if (!dirOk || dr === 0) continue;
      const straight = (type === 4 || type === 5 || type === 0 || type === 6); // 车炮帅兵走直线
      if (straight) {
        if (tc === fc2 && Math.abs(dr) === toN) matches.push(mv);
      } else {
        if (tc === tcWant) matches.push(mv);
      }
    }
  }
  return matches.length === 1 ? matches[0]! : null;
}

// ---------- PGN 文件解析 ----------

function parsePgn(text: string): { fen: string; moves: string[] } | null {
  const fenMatch = /\[FEN "([^"]+)"\]/.exec(text);
  const fen = fenMatch ? fenMatch[1]! : 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w';
  // 取着法区（最后一组结果记号之后的内容都在 moves 区，直接滤掉结果行）
  const body = text.split(/\r?\n\r?\n/).slice(1).join('\n');
  const moves: string[] = [];
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.replace(/\d+\.\s*/g, ' ').trim();
    if (!line) continue;
    if (/^(1-0|0-1|1\/2-1\/2|\*)$/.test(line)) continue;
    for (const tok of line.split(/\s+/)) {
      if (!tok) continue;
      if (/^(1-0|0-1|1\/2-1\/2|\*)$/.test(tok)) continue;
      moves.push(tok);
    }
  }
  if (moves.length === 0) return null;
  return { fen, moves };
}

// ---------- 主流程 ----------

function* walkPgn(root: string): Generator<string> {
  for (const name of readdirSync(root)) {
    const p = join(root, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* walkPgn(p);
    else if (name.endsWith('.pgn')) yield p;
  }
}

function main() {
  const argv = process.argv.slice(2);
  const get = (k: string, d?: string) => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1]! : d;
  };
  const root = get('root')!;
  const out = get('out', 'data/positions-web.txt')!;
  const limit = Number(get('limit', '0'));

  const files = [...walkPgn(root)];
  const use = limit > 0 ? files.slice(0, limit) : files;
  console.log(`[ingest] ${use.length}/${files.length} 个 PGN 文件`);

  const seen = new Set<string>();
  const lines: string[] = [];
  let gamesOk = 0, gamesFail = 0, movesOk = 0, movesFail = 0;
  const failSamples: string[] = [];

  for (const file of use) {
    let text: string;
    try {
      text = decodeAuto(readFileSync(file));
    } catch {
      gamesFail++;
      continue;
    }
    // 简单乱码检测：合法 FEN 应含 '/' 和 'w'/'b'
    if (!text.includes('[FEN')) { gamesFail++; continue; }
    const g = parsePgn(text);
    if (!g) { gamesFail++; continue; }

    // 整局双 pass：映射 A（黑方从黑右手数）失败则整局换 B（黑方与红同向）重放
    let replayed: string[] | null = null;
    const failToks: string[] = [];
    for (const mode of ['A', 'B'] as const) {
      let b: Board;
      try {
        b = new Board(g.fen);
      } catch {
        break;
      }
      const fens: string[] = [b.toFen()];
      const localSeen = new Set<string>(fens);
      let ok = true;
      for (const tok of g.moves) {
        const mv = parseChineseMove(b, tok, mode);
        if (!mv) {
          failToks.push(`${mode}:${tok}@${g.moves.indexOf(tok)}`);
          ok = false;
          break;
        }
        b.makeMove(mv);
        const f = b.toFen();
        if (!localSeen.has(f)) { localSeen.add(f); fens.push(f); }
      }
      if (ok) { replayed = fens; break; }
    }

    if (replayed) {
      gamesOk++;
      movesOk += g.moves.length;
      for (const f of replayed) {
        if (!seen.has(f)) { seen.add(f); lines.push(f); }
      }
    } else {
      gamesFail++;
      movesFail += g.moves.length;
      if (failSamples.length < 8) failSamples.push(`${file}: "${failToks.join(' | ')}"`);
    }
  }

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, lines.join('\n') + '\n', 'utf8');
  console.log(`[ingest] 对局成功 ${gamesOk}  失败 ${gamesFail}  着法成功 ${movesOk}  解析失败 ${movesFail}`);
  console.log(`[ingest] 去重后局面 ${lines.length} 条 → ${out}`);
  if (failSamples.length) {
    console.log('[ingest] 失败样例:');
    for (const s of failSamples) console.log('  ' + s);
  }
}

main();
