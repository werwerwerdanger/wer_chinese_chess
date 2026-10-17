# train-match-big.ps1 - One-shot: train the 143W-data model, then match it vs the 100W model.
#
# Run this on the GPU box (the one with CUDA torch), not on the laptop.
#
# Usage:
#   .\tools\distill\train-match-big.ps1 -Python python
#   .\tools\distill\train-match-big.ps1 -Python python -Games 100000 -Depth 10 -Parallel 16
#   .\tools\distill\train-match-big.ps1 -Python python -SkipTrain        # only match
#   .\tools\distill\train-match-big.ps1 -Python python -SkipMatch        # only train
#
# ASCII only on purpose: legacy .ps1 hosts read non-BOM files as ANSI.
#
# What it does:
#   1. Decompress data\*.gz that have no extracted .txt yet.
#   2. Verify all four datasets exist:
#        labeled.txt + labeled-web.txt + labeled-selfplay.txt + labeled-selfplay-big.txt
#   3. Train on their union (dedup by position, mirror augmentation) -> data\model-big2.onnx
#      Same hyper-parameters as the 100W model: hidden 1024,512,256 / 40 epochs / batch 4096 / lr 1e-3
#   4. Match model-big2.onnx vs model-big.onnx (delegates to match-big.ps1).

param(
  [string]$Python = "python",
  [int]$Epochs = 40,
  [int]$Batch = 4096,
  [int]$Games = 10000,
  [int]$Depth = 3,
  [int]$TimeMs = 200,
  [int]$Parallel = 8,
  [switch]$SkipTrain,
  [switch]$SkipMatch
)

$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..\..")
Write-Host "[train-match] repo root: $(Get-Location)"

function Expand-Gz([string]$Src, [string]$Dst) {
  $in = [IO.File]::OpenRead($Src)
  try {
    $gz = New-Object IO.Compression.GzipStream($in, [IO.Compression.CompressionMode]::Decompress)
    try {
      $out = [IO.File]::Create($Dst)
      try { $gz.CopyTo($out) } finally { $out.Close() }
    } finally { $gz.Close() }
  } finally { $in.Close() }
  Write-Host "[train-match] decompressed $Src -> $Dst"
}

# --- 1. decompress committed .gz files if needed ---
$gzPairs = @(
  @("data/labeled.txt.gz",          "data/labeled.txt"),
  @("data/labeled-web.txt.gz",      "data/labeled-web.txt"),
  @("data/labeled-selfplay.txt.gz", "data/labeled-selfplay.txt")
)
foreach ($p in $gzPairs) {
  if ((Test-Path $p[0]) -and -not (Test-Path $p[1])) { Expand-Gz $p[0] $p[1] }
}

# --- 2. verify datasets ---
$dataFiles = @(
  "data/labeled.txt",
  "data/labeled-web.txt",
  "data/labeled-selfplay.txt",
  "data/labeled-selfplay-big.txt"
)
$present = @()
$missing = @()
foreach ($f in $dataFiles) {
  if (Test-Path $f) { $present += $f } else { $missing += $f }
}
if ($missing.Count -gt 0) {
  throw "[train-match] missing data files: $($missing -join ', '). Copy them over first."
}
Write-Host "[train-match] datasets: $($present -join ', ')"

# --- 3. train ---
if (-not $SkipTrain) {
  $val = & $Python -c "import torch; print(torch.__version__, torch.cuda.is_available())"
  if ($LASTEXITCODE -ne 0) { throw "[train-match] torch not importable with '$Python'" }
  Write-Host "[train-match] torch: $val"

  $joined = ($present -join ",")
  Write-Host "[train-match] === training (epochs=$Epochs batch=$Batch) ==="
  & $Python "tools/distill/train.py" `
    --data $joined `
    --out "data/model-big2.onnx" `
    --epochs $Epochs `
    --batch $Batch `
    --log "data/train-big2.log"
  if ($LASTEXITCODE -ne 0) { throw "[train-match] train.py failed with exit $LASTEXITCODE" }
}

if (-not (Test-Path "data/model-big2.onnx")) {
  throw "[train-match] data/model-big2.onnx not found"
}
if (-not (Test-Path "data/model-big.onnx")) {
  throw "[train-match] data/model-big.onnx not found (the 100W baseline)"
}

# --- 4. match ---
if (-not $SkipMatch) {
  Write-Host "[train-match] === match ($Games games) ==="
  & (Join-Path $PSScriptRoot "match-big.ps1") `
    -Games $Games `
    -Depth $Depth `
    -TimeMs $TimeMs `
    -Parallel $Parallel `
    -Model "data/model-big2.onnx" `
    -Model2 "data/model-big.onnx"
}

Write-Host "[train-match] done."
