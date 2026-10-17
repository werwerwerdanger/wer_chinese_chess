# match-big.ps1 - Run a large parallel NNUE-vs-NNUE match.
#
# ASCII ONLY on purpose: Windows PowerShell 5.1 reads a non-BOM .ps1 as ANSI,
# so any Chinese text in this file would be garbled. Keep all messages English.
#
# Usage:
#   .\tools\distill\match-big.ps1 -Games 100000 -Depth 10 -Parallel 8
#   .\tools\distill\match-big.ps1 -Games 100000 -Depth 3 -Parallel 16 -TimeMs 200
#   .\tools\distill\match-big.ps1 -DryRun
#
# Notes:
#   - Depth is only an UPPER BOUND. The student NNUE evaluates at ~0.4ms/call,
#     so a deep target is usually unreachable; --time is the real limiter.
#     Keep TimeMs small (100-300ms) for throughput.
#   - Each shard is one node process with its own seed and log file.
#   - Results are aggregated from the per-shard logs at the end.

param(
  [int]$Games = 100000,
  [int]$Depth = 10,
  [int]$TimeMs = 200,
  [int]$Parallel = 8,
  [string]$Model  = "data/model-big2.onnx",
  [string]$Model2 = "data/model-big.onnx",
  [int]$MaxPly = 120,
  [int]$Opening = 4,
  [string]$OutDir = "data/match-big",
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..\..")
Write-Host "[match-big] repo root: $(Get-Location)"

if (-not $DryRun) {
  foreach ($f in @($Model, $Model2)) {
    if (-not (Test-Path $f)) { throw "[match-big] model not found: $f" }
  }
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $nodeCmd) { throw "[match-big] node not found in PATH" }
}

if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir | Out-Null }

$per = [int][math]::Ceiling([double]$Games / [double]$Parallel)
$estSec = [double]$Games * 60.0 * [double]$TimeMs / 1000.0 / [double]$Parallel
$estH = $estSec / 3600.0

Write-Host ("[match-big] games={0} depth={1} time={2}ms parallel={3}" -f $Games, $Depth, $TimeMs, $Parallel)
Write-Host ("[match-big] shards: {0} x {1} games" -f $Parallel, $per)
Write-Host ("[match-big] model  = {0}" -f $Model)
Write-Host ("[match-big] model2 = {0}" -f $Model2)
Write-Host ("[match-big] worst-case ETA ~ {0:N1} hours (usually much faster)" -f $estH)

if ($Depth -ge 6) {
  Write-Host ("[match-big] NOTE: depth {0} is a target. With a {1}ms time cap the search" -f $Depth, $TimeMs)
  Write-Host "[match-big]       returns whatever depth it reaches; it will not wait for depth 10."
}

$procs = @()
for ($i = 1; $i -le $Parallel; $i++) {
  $log = Join-Path $OutDir ("shard-{0}.log" -f $i)
  $errLog = Join-Path $OutDir ("shard-{0}.err.log" -f $i)
  $seed = $i * 7919
  $nodeArgs = @(
    "tools/distill/match.mjs",
    "--games", "$per",
    "--depth", "$Depth",
    "--time", "$TimeMs",
    "--model", $Model,
    "--model2", $Model2,
    "--opp", "nnue",
    "--opening", "$Opening",
    "--max-ply", "$MaxPly",
    "--seed", "$seed"
  )
  if ($DryRun) {
    Write-Host ("[match-big] DRYRUN node " + ($nodeArgs -join " "))
    continue
  }
  $p = Start-Process -FilePath $nodeCmd.Source -ArgumentList $nodeArgs -NoNewWindow -PassThru `
        -RedirectStandardOutput $log -RedirectStandardError $errLog
  $procs += $p
  Write-Host ("[match-big] shard {0} started (pid {1}) -> {2}" -f $i, $p.Id, $log)
}

if ($DryRun) { Write-Host "[match-big] DRYRUN done."; exit 0 }

$t0 = Get-Date
$lastReport = Get-Date
while (($procs | Where-Object { -not $_.HasExited }).Count -gt 0) {
  Start-Sleep -Seconds 5
  if (((Get-Date) - $lastReport).TotalSeconds -ge 60) {
    $done = 0
    foreach ($i in 1..$Parallel) {
      $log = Join-Path $OutDir ("shard-{0}.log" -f $i)
      if (Test-Path $log) {
        $text = [IO.File]::ReadAllText($log, [Text.Encoding]::UTF8)
        $ms = [regex]::Matches($text, '(\d+)/(\d+)')
        if ($ms.Count -gt 0) { $done += [int]$ms[$ms.Count - 1].Groups[1].Value }
      }
    }
    Write-Host ("[match-big] progress {0}/{1} games, {2:N1} min elapsed" -f $done, $Games, ((Get-Date) - $t0).TotalMinutes)
    $lastReport = Get-Date
  }
}

$totalW = 0; $totalD = 0; $totalL = 0; $shards = 0
foreach ($i in 1..$Parallel) {
  $log = Join-Path $OutDir ("shard-{0}.log" -f $i)
  if (-not (Test-Path $log)) { Write-Warning "missing $log"; continue }
  $text = [IO.File]::ReadAllText($log, [Text.Encoding]::UTF8)
  $m = [regex]::Match($text, '(\d+)\s*\u80DC\s*/\s*(\d+)\s*\u548C\s*/\s*(\d+)\s*\u8D1F')
  if ($m.Success) {
    $w = [int]$m.Groups[1].Value
    $d = [int]$m.Groups[2].Value
    $l = [int]$m.Groups[3].Value
    $totalW += $w; $totalD += $d; $totalL += $l; $shards++
    Write-Host ("[match-big] shard {0}: {1}W / {2}D / {3}L" -f $i, $w, $d, $l)
  } else {
    Write-Warning "could not parse result in $log"
  }
}

$n = $totalW + $totalD + $totalL
if ($n -eq 0) { throw "[match-big] no games recorded (check shard logs)" }

$rate = ([double]$totalW + 0.5 * [double]$totalD) / [double]$n
if ($rate -le 0.001) {
  $eloText = "-999 (or worse)"
} elseif ($rate -ge 0.999) {
  $eloText = "+999 (or better)"
} else {
  $eloText = "{0:N0}" -f (-400.0 * [math]::Log10((1.0 / $rate) - 1.0))
}

Write-Host ""
Write-Host "========================================================="
Write-Host ("[match-big] TOTAL: {0}W / {1}D / {2}L  ({3} games, {4} shards)" -f $totalW, $totalD, $totalL, $n, $shards)
Write-Host ("[match-big] score rate: {0:N4}" -f $rate)
Write-Host ("[match-big] Elo (model - model2): {0}" -f $eloText)
Write-Host ("[match-big] elapsed: {0:N1} min" -f ((Get-Date) - $t0).TotalMinutes)
Write-Host "========================================================="
