/**
 * AI 搜索引擎入口 — 规则引擎（@wer-chess/engine）之上的评估与搜索层
 */
export { evaluate, mvvlva, PIECE_VALUES, MATE_SCORE } from './eval.js';
export { Searcher, findBestMove } from './search.js';
