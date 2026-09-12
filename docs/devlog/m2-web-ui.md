# M2 前端 UI 开发日志

## 2026-09-12 11:30 ~ 11:45

### 做了什么
Canvas 棋盘渲染 + 点击交互 + engine-adapters 接口层。

### 架构决策（>>报告素材："UI与AI对接"章节）
**engine-adapters 接口层**是本阶段最重要的设计：
- UI 只依赖 `EngineAdapter` 接口（getPosition/legalMoves/makeMove/undo/inCheck/gameOver...）
- 不直接 import 引擎内部模块
- 动机：课程比赛允许组间对抗，将来接其他组的引擎（HTTP/WebSocket/UCCI 桥接）只写新 adapter，UI 零改动
- 这是"依赖倒置"的实际应用：高层 UI 不依赖低层引擎，两者都依赖抽象接口

### 渲染实现
- 纯函数式 `drawBoard(ctx, squares, opt)`：网格线/楚河汉界/九宫斜线/炮兵位标记/棋子/选中框/绿点落点/将军红圈，一次全画
- 坐标换算：引擎 (row,col) ↔ 画布 (x,y)，点击命中用 0.45 格半径圆判定
- 上一步走子绿框标记，被将军方将位红圈

### 踩坑记录
**坑1：TS 严格模式批量报错**
- 现象：web 包 build 时 engine 源码报 10+ 个错误（web 的 tsconfig 开了 noUncheckedIndexedAccess，engine 自己的没开）
- 根因：两包 tsconfig 严格度不一致；`for (const [dr,dc] of [[-1,0],[1,0]...])` 解构出的元素是 `number | undefined`
- 修复：方向数组显式标 `ReadonlyArray<readonly [number, number]>`；删未使用变量/导入
- 教训：monorepo 里各包编译配置要统一严格度，否则"在 A 包合法的代码在 B 包编译失败"

**坑2：沙箱 curl 测 localhost 被代理劫持**
- 现象：curl http://localhost:5173 返回"upstream connect failed 10061"
- 根因：环境变量 https_proxy 指向沙箱代理，localhost 请求也被转发了
- 修复：`curl --noproxy '*'`
- 教训：本机调试命令要记得绕代理

### 测试与交付
- `npm run build` 通过（tsc --noEmit + vite build），产物 16KB gzip 6KB
- dev server localhost:5173 可玩，人人对弈 + 悔棋 + 终局判定
- commit c5efad1 推送
