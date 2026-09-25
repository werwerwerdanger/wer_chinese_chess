# tools/pikafish — 本地强引擎桥接

腾讯开源的 [Pikafish](https://github.com/official-pikafish/Pikafish)（NNUE，中国象棋 UCI 引擎）
经 HTTP 桥接接入本项目的 Web UI，作为"人机·强引擎"模式的 AI 后端。

## 一次性安装

1. 下载 [最新 release](https://github.com/official-pikafish/Pikafish/releases) 的 `Pikafish.*.7z`
   （GitHub 直连不通可用镜像：`https://ghfast.top/https://github.com/...`）
2. 解压到本目录的 `dist/`，需要其中两个文件：
   - `Pikafish-Windows-x86-64-universal.exe`
   - `pikafish.nnue`（NNUE 权重，引擎启动时自动加载）
3. 确认有 Node.js（≥ 18）

`dist/` 不入 git（体积 100MB+）。

## 日常使用

```
powershell -File start-bridge.ps1     # 启动桥接（默认端口 8788，保持窗口开着）
```

然后打开 Web UI，对局模式选 **"人机·强引擎 Pikafish"** 即可。

## 架构

```
浏览器 web UI ──POST /think {fen, depth}──▶ bridge.mjs ──UCI stdio──▶ Pikafish.exe
        ◀──{move, scoreCp, depth, nodes}──            ◀──info/bestmove──
```

- 浏览器无法 spawn 进程，桥接是薄 HTTP 代理（无第三方依赖，纯 Node 内置模块）
- 规则/局面管理/走法合法性仍由本地 `@wer-chess/engine` 负责，Pikafish 只出着法
- 坐标换算（file a-i + rank 0-9 ↔ 90 格编号）的金标准测试在
  `engine-ai/tests/uci-coord.test.ts`
