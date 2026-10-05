# selfplay-big.ps1 - Overnight self-play data generation (run on the 4080 training box).
#
# Generates ~2 million labeled positions by having the student model self-play
# against Pikafish (Pikafish scores every position). ~100 labels per game.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File tools\distill\selfplay-big.ps1
#   powershell -ExecutionPolicy Bypass -File tools\distill\selfplay-big.ps1 -Games 20000 -Depth 10
#
# What it does:
#   1. Start the Pikafish bridge (:8788) in a new window if not already running
#   2. Run selfplay.mjs (mode sp) -> data\labeled-selfplay-big.txt
#
# Time estimate (depth 12, 12 parallel): ~3000 games / 75 min -> 20000 games ~ 8 hours.
# Lower --Depth for speed, higher for cleaner labels.
param(
  [int]$Games = 20000,
  [int]$Depth = 10,
  [int]$Parallel = 12,
  [string]$Model = "data/model-big.onnx",
  [string]$Out = "data/labeled-selfplay-big.txt",
  [int]$Opening = 6,
  [int]$MaxPly = 160
)
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..\..")
Write-Host "[selfplay-big] repo root: $(Get-Location)"

function Test-Bridge {
  try {
    $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri "http://127.0.0.1:8788/ping"
    return $r.StatusCode -eq 200
  } catch { return $false }
}

if (Test-Bridge) {
  Write-Host "[selfplay-big] bridge already running on :8788"
} else {
  Write-Host "[selfplay-big] starting bridge in a new window (keep it open)..."
  Start-Process -FilePath "node" -ArgumentList "tools/pikafish/bridge.mjs" -WorkingDirectory (Get-Location)
  $ok = $false
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 2
    if (Test-Bridge) { $ok = $true; break }
  }
  if (-not $ok) { throw "[selfplay-big] bridge did not come up within 120s" }
  Write-Host "[selfplay-big] bridge is up"
}

Write-Host "[selfplay-big] selfplay: $Games games, depth $Depth, parallel $Parallel"
Write-Host "[selfplay-big] model: $Model  ->  out: $Out  (~$([math]::Round($Games * 100 / 1e4, 0)) 万 labels estimated)"

node tools/distill/selfplay.mjs --mode sp --model $Model --games $Games --depth $Depth --parallel $Parallel --out $Out --opening $Opening --max-ply $MaxPly

if ($LASTEXITCODE -ne 0) { throw "[selfplay-big] selfplay.mjs failed" }
Write-Host "[selfplay-big] done -> $Out"
Write-Host "[selfplay-big] next: train on it + existing labels, e.g.:"
Write-Host "[selfplay-big]   .\tools\distill\train-big.ps1 -Python python -Data ""data/labeled.txt,data/labeled-web.txt,data/labeled-selfplay.txt,$Out"" -Out data/model-big2.onnx -Epochs 40"
