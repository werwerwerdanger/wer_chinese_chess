# run-all.ps1 - One-click infinite distillation loop for the 4080 training machine.
# Usage:  powershell -ExecutionPolicy Bypass -File tools\distill\run-all.ps1 [-Python python] [-Games 2000]
# What it does (in order):
#   1. Start Pikafish bridge (:8788) in its own window if not running
#   2. Decompress data/*.gz that have no extracted .txt yet
#   3. One-time labeling of master-game positions (resumable, skipped when done)
#   4. Run evolve.mjs in infinite mode: spar-train-gate loop, model-best.onnx always updated
param(
  [string]$Python = "python",
  [int]$Games = 2000,
  [int]$Parallel = 12,
  [int]$Depth = 12,
  [int]$LabelDepth = 10,
  [int]$Gens = -1,
  [switch]$SkipLabel,
  [switch]$DryRun
)
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..\..")

function Test-Bridge {
  try {
    $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri "http://127.0.0.1:8788/ping"
    return $r.StatusCode -eq 200
  } catch { return $false }
}

function Expand-Gz([string]$Src, [string]$Dst) {
  $in = [IO.File]::OpenRead($Src)
  try {
    $gz = New-Object IO.Compression.GzipStream($in, [IO.Compression.CompressionMode]::Decompress)
    try {
      $out = [IO.File]::Create($Dst)
      try { $gz.CopyTo($out) } finally { $out.Close() }
    } finally { $gz.Close() }
  } finally { $in.Close() }
  Write-Host "[run-all] decompressed $Src -> $Dst"
}

Write-Host "[run-all] repo root: $(Get-Location)"

# --- 1. bridge ---
if (Test-Bridge) {
  Write-Host "[run-all] bridge already running on :8788"
} elseif ($DryRun) {
  Write-Host "[run-all] DRYRUN would start bridge in a new window"
} else {
  Write-Host "[run-all] starting bridge in a new window (keep it open)..."
  Start-Process -FilePath "node" -ArgumentList "tools/pikafish/bridge.mjs" -WorkingDirectory (Get-Location)
  $ok = $false
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 2
    if (Test-Bridge) { $ok = $true; break }
  }
  if (-not $ok) { throw "[run-all] bridge did not come up within 120s, check the bridge window" }
  Write-Host "[run-all] bridge is up"
}

# --- 2. decompress data ---
$pairs = @(
  @("data\positions.txt.gz",      "data\positions.txt"),
  @("data\labeled.txt.gz",        "data\labeled.txt"),
  @("data\positions-web.txt.gz",  "data\positions-web.txt"),
  @("data\labeled-selfplay.txt.gz","data\labeled-selfplay.txt")
)
foreach ($p in $pairs) {
  if ((Test-Path $p[0]) -and -not (Test-Path $p[1])) {
    if ($DryRun) { Write-Host "[run-all] DRYRUN would decompress $($p[0])" }
    else { Expand-Gz $p[0] $p[1] }
  }
}

# --- 3. one-time labeling of master positions (resumable; cheap when already complete) ---
if ($SkipLabel) {
  Write-Host "[run-all] -SkipLabel: skipping master-position labeling, go straight to the evolve loop"
} elseif (Test-Path "data\positions-web.txt") {
  Write-Host "[run-all] ensuring master positions are labeled (resumable, fast if already done)..."
  if ($DryRun) { Write-Host "[run-all] DRYRUN would run label.mjs now" }
  else {
    node tools/distill/label.mjs --in data/positions-web.txt --out data/labeled-web.txt --depth $LabelDepth
    if ($LASTEXITCODE -ne 0) { throw "[run-all] label.mjs failed" }
  }
}

if ($DryRun) {
  Write-Host "[run-all] DRYRUN would now run:"
  Write-Host "[run-all]   node tools/distill/evolve.mjs --gens $Gens --games $Games --parallel $Parallel --depth $Depth --python $Python"
  exit 0
}

# --- 4. evolve loop ($Gens < 0 = infinite) ---
if ($Gens -lt 0) {
  Write-Host "[run-all] starting INFINITE evolve loop (Ctrl+C to stop; progress in data\evolve-log.txt)"
} else {
  Write-Host "[run-all] starting evolve loop for $Gens generation(s) (progress in data\evolve-log.txt)"
}
node tools/distill/evolve.mjs --gens $Gens --games $Games --parallel $Parallel --depth $Depth --python $Python
