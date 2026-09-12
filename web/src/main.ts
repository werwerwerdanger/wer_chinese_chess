import { GameController } from './game.js';
import { LocalEngineAdapter } from './engine-adapters/index.js';

const canvas = document.getElementById('board') as HTMLCanvasElement;
const status = document.getElementById('status')!;
const moves = document.getElementById('moves')!;
const btnUndo = document.getElementById('btn-undo') as HTMLButtonElement;
const btnReset = document.getElementById('btn-reset') as HTMLButtonElement;

new GameController(canvas, new LocalEngineAdapter(), status, moves, {
  undo: btnUndo,
  reset: btnReset,
});
