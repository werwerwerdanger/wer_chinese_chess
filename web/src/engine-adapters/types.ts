/**
 * 引擎适配器接口 — UI 与引擎之间的唯一通道
 *
 * 设计动机：课程比赛允许组间对抗。本 UI 通过此接口与引擎解耦，
 * 将来接其他组的引擎（或 C++/WASM 引擎）时只需提供新的 Adapter 实现，
 * UI 代码零改动。
 */
import type { Move } from '@wer-chess/engine';

/** UI 所需的最小局面视图 */
export interface PositionView {
  /** 90 格棋盘（row*9+col），值为 Piece 编码 */
  readonly squares: ReadonlyArray<number>;
  /** 当前行棋方：0=红 1=黑 */
  turn: 0 | 1;
}

/**
 * 引擎适配器：负责局面管理与走子合法性。
 * 实现方需保证：
 * - legalMoves() 返回的走子执行后不会导致己方被将军或将帅照面
 * - makeMove 只接受 legalMoves() 中存在的走子
 */
export interface EngineAdapter {
  /** 引擎显示名 */
  readonly name: string;

  /** 当前局面视图 */
  getPosition(): PositionView;

  /** 当前行棋方的所有合法走子 */
  legalMoves(): Move[];

  /** 执行走子（非法走子抛 EngineError） */
  makeMove(move: Move): void;

  /** 悔棋（撤销一步） */
  undo(): boolean;

  /** 重开一局 */
  reset(): void;

  /** 当前行棋方是否被将军 */
  inCheck(): boolean;

  /** 终局判定：'red-win' | 'black-win' | 'draw'（困毙黑胜——中国象棋规则）| null（未结束） */
  gameOver(): 'red-win' | 'black-win' | null;

  /** 中文纵线格式走子描述（如 "炮二平五"），引擎不支持时返回 null */
  describeMove(move: Move): string | null;
}

/** 引擎异常 */
export class EngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EngineError';
  }
}
