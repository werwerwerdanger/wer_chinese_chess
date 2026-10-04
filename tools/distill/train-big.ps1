# train-big.ps1 - One-shot large-data distillation train (run on the training machine).
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File tools\distill\train-big.ps1 -Python <venv python>
#
# What it does:
#   1. Decompress data\*.gz that have no extracted .txt yet (labeled*.txt are committed gzipped)
#   2. Sanity check: torch importable + every dataset file present
#   3. Train ONCE on the union of all labeled datasets (streaming, dedup by position)
#      -> data\model-big.onnx  +  data\model-big.pt  +  data\train-big.log
#
# Why separate from run-all.ps1: run-all.ps1 is the infinite spar-train-gate loop.
# This is the one-off "big data" run -- no selfplay, no gate, just fit everything.
#
# NOTES
#  - train.py now streams: it keeps 91 bytes/position in RAM instead of a 1261-float
#    one-hot (200万 samples ~ 180 MB instead of ~20 GB). Low-RAM boxes are fine.
#  - val loss is split by ORIGINAL position, so mirror copies never leak across
#    train/val. Compare val numbers only between runs made with this script.
param(
  [string]$Python = "python",
  [int]$Epochs = 40,
  [int]$Batch = 4096,
  [float]$Lr = 0.001,
  [string]$Hidden = "1024,512,256",
  [string]$Out = "data/model-big.onnx",
  [int]$Limit = 0,
  [string]$Data = "",
  [switch]$NoDedup,
  [switch]$DryRun
)
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..\..")
Write-Host "[train-big] repo root: $(Get-Location)"

function Expand-Gz([string]$Src, [string]$Dst) {
  $in = [IO.File]::OpenRead($Src)
  try {
    $gz = New-Object IO.Compression.GzipStream($in, [IO.Compression.CompressionMode]::Decompress)
    try {
      $out = [IO.File]::Create($Dst)
      try { $gz.CopyTo($out) } finally { $out.Close() }
    } finally { $gz.Close() }
  } finally { $in.Close() }
  Write-Host "[train-big] decompressed $Src -> $Dst"
}

# --- 1. decompress ---
$pairs = @(
  @("data\labeled.txt.gz",          "data\labeled.txt"),
  @("data\labeled-web.txt.gz",      "data\labeled-web.txt"),
  @("data\labeled-selfplay.txt.gz", "data\labeled-selfplay.txt")
)
foreach ($p in $pairs) {
  if ((Test-Path $p[0]) -and -not (Test-Path $p[1])) {
    if ($DryRun) { Write-Host "[train-big] DRYRUN would decompress $($p[0])" }
    else { Expand-Gz $p[0] $p[1] }
  }
}

# --- 2. sanity check ---
if ($Data -eq "") {
  $parts = @()
  foreach ($f in @("data\labeled.txt", "data\labeled-web.txt", "data\labeled-selfplay.txt")) {
    if (Test-Path $f) { $parts += ($f -replace '\\', '/') } else { Write-Host "[train-big] (skip, not present) $f" }
  }
  if ($parts.Count -eq 0) { throw "[train-big] no labeled dataset found under data\" }
  $Data = ($parts -join ",")
}

Write-Host "[train-big] datasets: $Data"
if ($DryRun) {
  Write-Host "[train-big] DRYRUN would run:"
  Write-Host "[train-big]   $Python tools/distill/train.py --data $Data --out $Out --epochs $Epochs --batch $Batch --hidden $Hidden"
  exit 0
}

& $Python -c "import torch; print('[train-big] torch', torch.__version__, 'cuda', torch.cuda.is_available())"
if ($LASTEXITCODE -ne 0) {
  throw "[train-big] torch not importable with '$Python'. Install it first, e.g.:`n  pip install torch onnx"
}

# --- 3. train ---
$args = @(
  "tools/distill/train.py",
  "--data", $Data,
  "--out", $Out,
  "--epochs", "$Epochs",
  "--batch", "$Batch",
  "--lr", "$Lr",
  "--hidden", $Hidden,
  "--log", "data/train-big.log"
)
if ($Limit -gt 0) { $args += @("--limit", "$Limit") }
if ($NoDedup) { $args += "--no-dedup" }

Write-Host "[train-big] >>> $Python $($args -join ' ')"
& $Python @args
if ($LASTEXITCODE -ne 0) { throw "[train-big] train.py failed with exit code $LASTEXITCODE" }

Write-Host ""
Write-Host "[train-big] done. Artifacts:"
Write-Host "[train-big]   $Out"
Write-Host "[train-big]   $($Out -replace '\.onnx$', '.pt')"
Write-Host "[train-big]   data/train-big.log  (epoch / train-loss / val-loss per line)"
Write-Host ""
Write-Host "[train-big] next steps (copy the model back, then health-check it):"
Write-Host "[train-big]   node tools/distill/probe-eval.mjs --model $Out --sample data/labeled-web.txt --n 2000"
Write-Host "[train-big]   node tools/distill/showplay.mjs  --model $Out --plies 24"
Write-Host "[train-big]   node tools/distill/match.mjs --games 40 --depth 6 --model $Out --opp nnue --model2 data/model-best.onnx"
