# build-distill.ps1 - rebuild bundled .mjs from .ts sources (esbuild)
#
# Why this exists: the 4080 training box and the local model server run the *bundled*
# .mjs files (no TS runtime there). Any change under engine/src, engine-ai/src or
# tools/distill/*.ts MUST be re-bundled, otherwise the machine keeps running old code.
#
# Usage (from anywhere):
#   powershell -ExecutionPolicy Bypass -File tools\distill\build-distill.ps1
#   .\tools\distill\build-distill.ps1
#
# Flags are pinned to the ones used originally (verified byte-identical output):
#   --bundle --platform=node --format=esm --external:onnxruntime-node
$ErrorActionPreference = 'Stop'

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
Set-Location $repoRoot

$targets = @('match', 'selfplay', 'nnue-serve', 'smoke-nnue', 'pgn-ingest', 'datagen')
$esbuild = Join-Path $repoRoot 'node_modules\.bin\esbuild.cmd'
if (-not (Test-Path $esbuild)) { throw "esbuild not found at $esbuild - run 'npm install' first" }

foreach ($t in $targets) {
    $src = "tools/distill/$t.ts"
    if (-not (Test-Path $src)) { Write-Host "[build] skip $src (missing)"; continue }
    & $esbuild $src --bundle --platform=node --format=esm --external:onnxruntime-node --outfile="tools/distill/$t.mjs"
    if ($LASTEXITCODE -ne 0) { throw "[build] esbuild failed on $t" }
    Write-Host "[build] $t.ts -> tools/distill/$t.mjs"
}
Write-Host '[build] done.'
