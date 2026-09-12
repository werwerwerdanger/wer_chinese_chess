# wer_chinese_chess — 中国象棋

TypeScript 实现的中国象棋引擎 + Web 对弈界面。npm workspaces 三包架构：

```
wer_chinese_chess/
├── engine/     # 后端·规则引擎：走子生成、局面管理、规则判定、中文记谱
├── engine-ai/  # 后端·AI 搜索：局面评估、Alpha-Beta 搜索引擎
└── web/        # 前端：Canvas UI（经 engine-adapters 接口层调用后端）
```

## 后端·规则引擎（engine/）

纯逻辑，无 DOM 依赖，可独立测试 / 被 AI 包与前端共同复用。

| 模块 | 职责 |
|------|------|
| `src/types.ts` | 棋子编码（None=255 防冲突）、走子/撤销接口 |
| `src/constants.ts` | 90 格坐标系、九宫/象区/过河判定、Zobrist 表 |
| `src/board.ts` | 棋盘类：FEN 解析、make/unmake、增量 Zobrist、将帅照面 |
| `src/movegen.ts` | 七种棋子伪合法走子（蹩马腿/塞象眼/炮架/过河兵） |
| `src/legality.ts` | 将军反向探测、送将过滤、将死/困毙 |
| `src/notation.ts` | 中文纵线记谱（炮二平五式） |
| `tests/` | perft(1..4)=44/1920/79666/3290240 金标准 + 记谱用例 |

## 后端·AI 搜索（engine-ai/）

在规则引擎之上实现博弈搜索，与规则解耦，可独立替换更强实现。

| 模块 | 职责 |
|------|------|
| `src/eval.ts` | 局面评估：子力价值 + 位置价值表（PST） |
| `src/search.ts` | 迭代加深 + negamax Alpha-Beta + 置换表 + 静态搜索 + MVV-LVA |
| `tests/` | 合法性/一致性/性能基线/自对弈冒烟 |

## 前端（web/）

Canvas 棋盘渲染 + 交互 + 打谱。

| 模块 | 职责 |
|------|------|
| `src/engine-adapters/` | **引擎接口层**：UI 只认 `EngineAdapter` 接口，换引擎只换 adapter |
| `src/renderer.ts` | Canvas 绘制：棋盘、棋子（PNG 素材）、选中/落点/将军高亮 |
| `src/game.ts` | 游戏控制：点击走子、人机/人人、悔棋、回放、FEN 载入/导出 |
| `public/pieces/` | PIL 生成的 PNG 棋子素材（`scripts/gen_pieces.py`） |

## 快速开始

```bash
npm install
npm test        # 后端两包全部测试
npm run dev     # dev server → http://localhost:5173
npm run build   # 前端构建
```

## 里程碑

- [x] M1 规则引擎（走子生成/合法性，perft 金标准全对）
- [x] M2 前端（Canvas 棋盘、对弈、悔棋、将军/终局提示）
- [x] M2.5 打谱（中文记谱、着法列表回放、FEN 载入）
- [x] M3 AI 搜索引擎（评估 + Alpha-Beta + 迭代加深 + 置换表）
- [ ] M3.5 后端双包拆分（规则引擎 / AI 搜索）
- [ ] M4 对战对接（UCCI 协议 / 班内对抗 adapter）
- [ ] M5 报告撰写
