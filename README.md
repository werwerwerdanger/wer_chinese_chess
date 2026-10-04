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

## 蒸馏工具链（tools/distill/）

Pikafish 当教师、小 MLP 当学生的迭代蒸馏管线（详见 `docs/devlog/m4-nnue-distill.md`）。

```powershell
.\tools\distill\run-all.ps1                 # 一键：起桥 → 解压 → 标注 → 迭代闭环
node tools/distill/evolve-plot.mjs --out fig.html --md summary.md   # 进化曲线
node tools/distill/probe-eval.mjs --compare 新.onnx 旧.onnx         # 换模型前的体检
node tools/distill/match.mjs --model 新.onnx --opp nnue --model2 旧.onnx --games 20
```

⚠️ **改了 `engine/src`、`engine-ai/src` 或 `tools/distill/*.ts` 之后必须重新打包**，
否则跑的还是旧代码。打包参数已固定在脚本里：

```powershell
.\tools\distill\build-distill.ps1
```

⚠️ **搜索层视角约定（踩过坑）**：`Searcher.search()` 的 `score` 是**当前走子方视角**，
adapter 里乘 `sign`（红+1/黑-1）才变成「红方视角」。历史 bug 见
`docs/devlog/m4b-search-sign-bug.md`：叶子处多乘一次 `sign`，导致**奇数深度整棵树退化成取最小**，
根节点专挑最差着法（开局 depth1 会主动白兑炮换马、评分随深度正负跳变）。
`engine-ai/tests/search.test.ts` 已有回归测试钉死。

⚠️ **NNUE 输入向量必须清零（踩过坑）**：`NnueEvaluator.evalBoard` 复用同一个 1261 维 buffer，
`encodeFenInto` 只写 1 不写 0 → 新局面的向量里残留上一个局面的棋子，模型看到"叠加局面"
（开局被评成 −1754、搜索里除首次之外全是垃圾）。见 `docs/devlog/m4c-nnue-input-buffer-bug.md`；
`engine-ai/tests/nnue.test.ts`「评估结果与评估历史无关」用例钉死。

排障工具箱（都在 `tools/distill/`）：`showplay.mjs`（把 AI 实际下的棋逐步打出来）、
`probe-eval.mjs`（换模型体检）、`bench-eval.mjs`（评估吞吐基准）、`evolve-plot.mjs`（进化曲线）。


## 里程碑

- [x] M1 规则引擎（走子生成/合法性，perft 金标准全对）
- [x] M2 前端（Canvas 棋盘、对弈、悔棋、将军/终局提示）
- [x] M2.5 打谱（中文记谱、着法列表回放、FEN 载入）
- [x] M3 AI 搜索引擎（评估 + Alpha-Beta + 迭代加深 + 置换表）
- [ ] M3.5 后端双包拆分（规则引擎 / AI 搜索）
- [ ] M4 对战对接（UCCI 协议 / 班内对抗 adapter）
- [ ] M5 报告撰写
