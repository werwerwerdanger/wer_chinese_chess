# M4 · Pikafish 本地部署与桥接接入

日期：2026-09-25

## 目标

把腾讯开源 NNUE 引擎 Pikafish 接入 Web UI 作为"强引擎"AI，同时保持
engine-ai 自研搜索引擎可用（模式下拉切换）。这也是后续蒸馏路线的基建：
Pikafish 先当教师，将来自己训练的网络经同一 adapter 接口替换。

## 踩坑记录

### 1. GitHub release 直连不通，代理 502

沙箱内 `curl https://github.com/...` 直连超时、走系统代理返回 CONNECT 502
（与早前 git HTTPS 推送同病）。解法：ghfast.top 镜像前缀下载 release 大文件成功。

### 2. UCI info 行正则一次离谱失败

第一版用 `^info .* depth (\d+) .*score ...` 抓评分，实测永远不匹配。
逐步二分正则才定位：**`^info ` 把 "info" 后的空格吃掉了**，剩下的文本里
"depth" 前面没有空格（`seldepth` 又不算），`.* depth ` 永远失配。
教训：字段序解析别锚定 `^info`，用词边界宽松匹配 + `startsWith('info')` 分离判断。

### 3. stdout 分块截断长行

Node 子进程 stdout 按chunk 到达，一行 info 可能被拆成两半，
`split('\n')` 会产生残行。必须维护 pending 缓冲，`parts.pop()` 留尾。
否则 bestmove 能拿到（短行），score/nodes 统计随机丢失。

### 4. PowerShell 输出 / bash shim

WorkBuddy 沙箱 shim 偶发把 PATH 打碎（dirname/head 全找不到），
用 `export PATH="/c/Users/20633/.workbuddy/binaries/PortableGit/.../usr/bin:$PATH"` 手动救。
PowerShell 工具的 stdout 捕获不稳，脚本类操作优先 bash + 绝对路径。

## 设计决策

- **桥接而非 WASM**：浏览器不能 spawn 进程，起一个零依赖 Node HTTP 服务
  （`tools/pikafish/bridge.mjs`，:8788）做薄代理。`POST /think {fen, depth}`，
  返回 `{move, scoreCp, mate, depth, nodes, timeMs}`。Pikafish 无状态处理，
  每请求 `position fen` 重设，免去增量同步。
- **装饰器适配器**：`PikafishAdapter` 组合 `LocalEngineAdapter`，规则/合法性/
  记谱/回放全部委托本地引擎，只重写 `think()`。UI 的 `EngineAdapter` 接口零改动。
- **think() 改异步**：接口签名 `think(): Promise<...>`，为 Web Worker 化和
  外部引擎铺路。game.ts 的 AI 回调加竞态防护（等待期间重开/回放则丢弃结果）。
- **难度映射**：UI 深度下拉 2/4/6 → Pikafish `go depth` 6/12/18（×3 封顶 18）。
- **坐标换算金标准**：`engine-ai/tests/uci-coord.test.ts` 用开局全部合法走法
  做往返测试 + 炮二平五 (h2e2) 等语义抽查。rank 0 = 红方底线 = row 9。

## 验证

- `curl POST /think` depth 12/18：返回 `c3c4`（挺兵），cp 26~31，580ms 内完成
- vitest 41 用例全绿（含新增 4 个坐标测试）
- `npm run build` 通过

## 待办

- 浏览器端到端点击验证（本轮 agent-browser daemon 损坏未跑通，下次补）
- Pikafish 多请求并发锁（当前串行足够）
- 蒸馏管线：Pikafish 输出 → 训练集 → PyTorch 小网络 → ONNX → 替换 evaluate()
