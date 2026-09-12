# wer_chinese_chess — 中国象棋课程设计

成都理工大学《计算机问题求解课程设计》题目12：亚洲象棋。

npm workspaces 双包架构，前后端同语言（TypeScript）：

```
wer_chinese_chess/
├── engine/   # 后端：引擎（纯逻辑，无 DOM 依赖，可独立测试）
└── web/      # 前端：Canvas UI（经 engine-adapters 接口层调用引擎）
```

## 后端（engine/）

走子生成、局面管理、规则判定、（进行中）AI 搜索。

| 模块 | 职责 |
|------|------|
| `src/types.ts` | 棋子编码（None=255 防冲突）、走子/撤销接口 |
| `src/constants.ts` | 90 格坐标系、九宫/象区/过河判定、Zobrist 表 |
| `src/board.ts` | 棋盘类：FEN 解析、make/unmake、增量 Zobrist、将帅照面 |
| `src/movegen.ts` | 七种棋子伪合法走子（蹩马腿/塞象眼/炮架/过河兵） |
| `src/legality.ts` | 将军反向探测、送将过滤、将死/困毙 |
| `src/notation.ts` | 中文纵线记谱（炮二平五式） |
| `tests/` | vitest：perft(1..4)=44/1920/79666/3290240 金标准 + 记谱用例，24/24 绿 |

```bash
cd engine && npx vitest run   # 跑测试
```

## 前端（web/）

Canvas 棋盘渲染 + 交互 + 打谱。

| 模块 | 职责 |
|------|------|
| `src/engine-adapters/` | **引擎接口层**：UI 只认 `EngineAdapter` 接口，接其他组引擎只换 adapter |
| `src/renderer.ts` | Canvas 绘制：棋盘、棋子（PNG 素材）、选中/落点/将军高亮 |
| `src/game.ts` | 游戏控制：点击走子、悔棋、回放（⏮◀▶⏭）、FEN 载入/导出 |
| `public/pieces/` | PIL 生成的 PNG 棋子素材（`scripts/gen_pieces.py`） |

```bash
npm run dev    # dev server → http://localhost:5173
npm run build -w web   # 类型检查 + 产物构建
```

## 里程碑

- [x] M1 引擎规则层（走子生成/合法性，perft 金标准全对）
- [x] M2 前端（Canvas 棋盘、人人对弈、悔棋、将军/终局提示）
- [x] M2.5 打谱（中文记谱、着法列表回放、FEN 载入）
- [ ] M3 AI 搜索引擎（评估函数 + Alpha-Beta + 迭代加深 + 置换表）
- [ ] M4 对战对接（UCCI 协议 / 班内对抗 adapter）
- [ ] M5 报告撰写（七章结构，与开发并行）

## 课程备注

- 评分：平时 10% + 比赛 30% + 答辩 40% + 报告 20%
- 同题班内多组可选，代码相同均零分 —— 保持代码自主性
