# Pikafish 启动脚本（PowerShell）
# 用法：右键"使用 PowerShell 运行"，或 .\start-bridge.ps1
# 前提：dist/ 下已解压 Pikafish-Windows-x86-64-universal.exe 与 pikafish.nnue

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$bridge = Join-Path $PSScriptRoot "bridge.mjs"
$node = "C:\Program Files\nodejs\node.exe"
if (-not (Test-Path $node)) { $node = "node" }

Write-Host "启动 Pikafish 桥接服务 (http://127.0.0.1:8788) ..." -ForegroundColor Green
& $node $bridge
