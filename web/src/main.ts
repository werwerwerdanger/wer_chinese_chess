import { GameController } from './game.js';
import { LocalEngineAdapter } from './engine-adapters/index.js';

const canvas = document.getElementById('board') as HTMLCanvasElement;
const status = document.getElementById('status')!;
const moves = document.getElementById('moves')!;
const fenInput = document.getElementById('fen-input') as HTMLInputElement;
const btn = (id: string) => document.getElementById(id) as HTMLButtonElement;

new GameController(canvas, new LocalEngineAdapter(), status, moves, {
  undo: btn('btn-undo'),
  reset: btn('btn-reset'),
  first: btn('btn-first'),
  prev: btn('btn-prev'),
  next: btn('btn-next'),
  last: btn('btn-last'),
  copyFen: btn('btn-copy-fen'),
  loadFen: btn('btn-load-fen'),
  exportMoves: btn('btn-export'),
}, fenInput);
