# m4b — 搜索层视角 bug（奇数深度会挑最差着法）

> 2026-10-04 发现并修复。这个 bug 一直在悄悄拉低 AI 棋力，也是"AI 会乱跑/主动送子"的直接原因。

## 症状

换模型后做体检时发现同一局面、不同深度给出的分数**符号乱跳**（红方走子，开局，NNUE 蒸馏模型）：

| 深度 | 返回着法 | 返回评分 |
|---:|---|---:|
| 1 | 炮八进八（b2b9，白兑炮换马） | **+544** |
| 2 | 炮八进八 | **−544** |
| 3 | 炮八进二（b2b4） | **+2884** |

另取"黑缺一车（红大优）"局面，同样正负交替：depth1 −1226 / depth2 +1625 / depth3 −1226。
更刺眼的是 depth1 的选着：**炮八进八**把炮送到对方底线上被车吃掉，是净亏的着法——
而引擎自己在 depth2 给这个着法的评价就是 −544。即"引擎明知差还偏要选它"。

## 定位

`engine-ai/src/search.ts`，negamax 的叶子交接处：

```ts
if (ply >= MAX_PLY) return sign * this.quiescence(alpha, beta, sign, 0, deadlineHit);
if (depth <= 0)     return sign * this.quiescence(alpha, beta, sign, 4, deadlineHit);
```

而 `quiescence` 内部：

```ts
const standPat = sign * this.evalFn(this.board);   // 红方视角 × sign = 当前走子方视角
...
const score = -this.quiescence(-beta, -alpha, -sign, qdepth - 1, ...);  // 标准 negamax 取负
```

也就是说 **`quiescence` 返回的本来就是"当前走子方视角"**，调用侧再乘一次 `sign` 就等于多翻一次符号。
`sign = +1`（该叶子轮到红走）时碰巧没事，`sign = −1`（轮到黑走）时符号被翻错。

## 后果为什么这么严重

叶子被翻错符号后，上一层取负传播，结果**每个"轮到黑走的叶子"把它的父节点从 max 节点变成了 min 节点**。
由于叶子轮谁走只取决于根到叶子的距离奇偶性，于是：

- **偶数深度的根**：错误的翻转两两抵消 → 行为正确（这也是旧测试能过的原因）；
- **奇数深度的根**：整个根退化成"取最小" → **专挑最差着法**。

浏览器里 NNUE/Pikafish 模式默认深度 3、本地引擎常用深度 3/4，也就是说
**用户实际对局时，AI 有一半时间在挑最差的着法**。之前所有棋力指标（含
"gen30 vs Pikafish 0胜2和18负、Elo −512"）都是在坏掉的搜索上测的，参考价值要打折。

## 修复

```ts
if (ply >= MAX_PLY) return this.quiescence(alpha, beta, sign, 0, deadlineHit);
if (depth <= 0)     return this.quiescence(alpha, beta, sign, 4, deadlineHit);
```

并在 `alphabeta` 头部写死视角约定（谁改谁读），`search()` 的文档同步说明
"返回值 = 当前走子方视角，UI 要红方视角需自行乘 sign"。
adapter 侧（`local-adapter` / `nnue-serve`）注释同步纠正，Pikafish adapter 也统一成
"红方视角 + 厘兵"，前端状态栏补上"｜红方视角"避免误读。

## 验证

1. **回归测试先证伪再证真**：新增 `engine-ai/tests/search.test.ts` 两组用例
   （奇数层不得挑最差着法；1/2/3 层都必须吃掉白送的车）。
   用旧代码跑 → **2 个用例失败**（`expect to be 40, received 65`：引擎在奇数层放弃吃车）；
   用修复后代码跑 → 8/8 全绿。
2. **端到端复测**：修完后同一开局 1~4 层评分同号、量级正常；
   `深度1/2/3` 不再正负跳变（见 `tools/distill/probe-eval.mjs`）。

```powershell
npx vitest run engine-ai/tests/search.test.ts
node tools/distill/probe-eval.mjs --compare data/model-best.onnx data/model-prev.onnx
```

## 教训

1. negamax 的"视角约定"是这类 bug 的高发点，必须在**文件头 + 每个跨层接口**写清楚；
   叶子/静态搜索的交接处尤其容易多乘或少乘一次符号。
2. 只测"着法合法""能搜出将杀"是不够的——**符号类 bug 只会体现在"选着质量"上**，
   回归测试必须构造"已知优劣局面 + 多个深度（奇偶都要）"。
3. 用户抱怨"AI 乱跑"时，先怀疑搜索/评估实现，别急着怪模型。

## 后续

- 所有历史 Elo 数字需在修复后的引擎上重测（正在做：`match.mjs --opp nnue --model2 旧最佳`）。
- 迭代蒸馏的 Gate 用的是同一套搜索，之前的"晋级"判定同样带着这个 bug 的噪声。
