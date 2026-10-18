# match-forever.ps1 - Unattended NATCH runner (survives crashes, reboots and days).
#
# ASCII ONLY on purpose: Windows PowerShell 5.1 reads a non-BOM .ps1 as ANSI,
# so any Chinese text here would be garbled. Keep all messages English.
#
# WHY THIS EXISTS (the "dies after ~8 games" problem):
#   - match.mjs writes NO per-game result line, so one crash loses the whole shard.
#   - its game number always restarts at 1, so a restart re-plays finished games.
#   - there was no watchdog: a hung node process just sat there forever.
#   This script fixes all three:
#     1. each game is appended immediately to shard-N.jsonl -> nothing is lost;
#     2. --start is derived from the jsonl -> exact resume, no duplicates;
#     3. a watchdog restarts dead shards with exponential backoff, and kills
#        shards that stop producing results for -StallMinutes.
#
# WHAT "DONE" MEANS:
#   Every shard has -GamesPerShard distinct game indices recorded in its jsonl.
#
# Usage (from repo root, no -ExecutionPolicy needed on RemoteSigned):
#   .\tools\distill\match-forever.ps1 -GamesPerShard 50000 -Parallel 6
#   .\tools\distill\match-forever.ps1 -GamesPerShard 50000 -Parallel 6 -StatusOnly
#   .\tools\distill\match-forever.ps1 -GamesPerShard 50000 -Parallel 6 -Stop
#
# Safe to Ctrl+C (children are killed) or to close the window / reboot (relaunch
# the same command and it continues where it left off).
#
# Leave the machine alone for days:
#   .\tools\distill\match-forever.ps1 -GamesPerShard 50000 -Parallel 6 `
#       | Tee-Object -FilePath data\match-forever\console.log -Append
#   (or use the small start-match-forever.ps1 launcher)

param(
  [int]$GamesPerShard = 50000,
  [string]$OutDir = "data/match-forever",
  [string]$Model  = "data/model-big2.onnx",
  [string]$Model2 = "data/model-big.onnx",
  [int]$Depth = 3,
  [int]$TimeMs = 200,
  [int]$MaxPly = 120,
  [int]$Opening = 4,
  [int]$Parallel = 6,
  [int]$BaseSeed = 10007,
  [int]$StallMinutes = 30,
  [int]$MaxConsecutiveFailures = 20,
  [int]$PollSeconds = 15,
  [switch]$StatusOnly,
  [switch]$Stop,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
# The child's log lines are UTF-8, and the final summary echoes a few of them.
# Without this the console renders them as garbage under the default GBK page.
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
Set-Location (Join-Path $PSScriptRoot "..\..")
# .NET APIs resolve relative paths against Environment.CurrentDirectory, which
# Set-Location does NOT update. Without this, relative paths break when the
# console was started elsewhere (e.g. the user home directory).
[Environment]::CurrentDirectory = (Get-Location).ProviderPath
$repo = (Get-Location).ProviderPath
Write-Host "[forever] repo root: $repo"

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) { throw "[forever] node not found in PATH" }

# ---------------------------------------------------------------- helpers

function Get-ShardFile([int]$i, [string]$ext) {
  Join-Path $OutDir ("shard-{0}.{1}" -f $i, $ext)
}

# Count distinct game indices in a shard jsonl. Streams line by line: a shard
# log can grow to tens of MB, and [IO.File]::ReadAllText on it every poll would
# burn CPU for no reason.
function Measure-Shard([int]$i) {
  $f = Get-ShardFile $i "jsonl"
  $res = [pscustomobject]@{
    Done = 0; W = 0; D = 0; L = 0; Bad = 0; MaxG = -1
    LastWrite = [datetime]::MinValue; Bytes = 0
  }
  if (-not (Test-Path $f)) { return $res }
  $info = Get-Item $f
  $res.Bytes = $info.Length
  $res.LastWrite = $info.LastWriteTime
  $seen = New-Object 'System.Collections.Generic.HashSet[int]'
  # FileShare ReadWrite is critical: the child appends to this jsonl every few
  # seconds, and StreamReader's default share mode (Read only) makes that
  # append fail with EBUSY -- killing the shard every time a poll lands mid-
  # write. (This was the real "dies after a few games" bug.)
  $fs = New-Object System.IO.FileStream($f, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
  $reader = New-Object System.IO.StreamReader($fs, [Text.Encoding]::UTF8)
  try {
    while ($null -ne ($line = $reader.ReadLine())) {
      if ($line.Length -eq 0) { continue }
      try { $o = $line | ConvertFrom-Json } catch { $res.Bad++; continue }
      if ($null -eq $o.g) { $res.Bad++; continue }
      $g = [int]$o.g
      if ($seen.Add($g)) {
        $res.Done++
        switch ($o.r) {
          "new"   { $res.W++ }
          "draw"  { $res.D++ }
          "old"   { $res.L++ }
        }
        if ($g -gt $res.MaxG) { $res.MaxG = $g }
      }
    }
  } finally { $reader.Dispose() }
  return $res
}

function Get-EloText([double]$rate) {
  if ($rate -le 0.001) { return "-999 (or worse)" }
  if ($rate -ge 0.999) { return "+999 (or better)" }
  return "{0:N0}" -f (-400.0 * [math]::Log10((1.0 / $rate) - 1.0))
}

function Write-Report([object[]]$stats) {
  $tw = 0; $td = 0; $tl = 0; $tdone = 0
  foreach ($s in $stats) { $tw += $s.W; $td += $s.D; $tl += $s.L; $tdone += $s.Done }
  $n = $tw + $td + $tl
  $rate = if ($n -gt 0) { ([double]$tw + 0.5 * [double]$td) / [double]$n } else { 0.0 }
  Write-Host ("[forever] games {0}  (target {1} x {2} = {3})" -f $tdone, $Parallel, $GamesPerShard, ($Parallel * $GamesPerShard))
  Write-Host ("[forever] new {0} W / {1} D / {2} L   score {3:N4}   Elo(model-model2) {4}" -f $tw, $td, $tl, $rate, (Get-EloText $rate))
}

function Stop-Tree([int]$procId) {
  # node spawns nothing here (onnxruntime workers are threads), so a plain kill
  # is enough; -Force because a busy child may ignore a soft stop.
  try { Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue } catch { }
}

# ---------------------------------------------------------------- control

# WHY WE DO NOT USE Start-Process HERE:
#   Windows PowerShell 5.1's Start-Process builds a case-insensitive env map
#   from the current process environment and throws
#     ArgumentException: "an item with the same key has already been added"
#   when both HTTPS_PROXY and https_proxy exist (mingw/msys shells, CI agents,
#   IDE terminals all export them). Nothing we pass to Start-Process avoids it,
#   and SetEnvironmentVariable cannot remove the pair either -- so the symptom
#   is "the script does nothing / dies immediately".
#   System.Diagnostics.Process inherits the block as-is and works fine.
#
#   Trade-off: with RedirectStandardOutput=true the child's output travels
#   through a pipe and the log only grows in ~4 KB chunks. Acceptable here:
#   progress is measured from the per-game jsonl, never from the log.

function Start-ChildNode([string[]]$nodeArgs, [string]$stdoutPath, [string]$stderrPath) {
  $quoted = $nodeArgs | ForEach-Object {
    if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ }
  }
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $nodeCmd.Source
  $psi.Arguments = ($quoted -join ' ')
  # Absolute WorkingDirectory matters: the child resolves tools/distill/* and
  # data/*.onnx relative to its own cwd, not to ours.
  $psi.WorkingDirectory = $root
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.CreateNoWindow = $true
  $proc = New-Object System.Diagnostics.Process
  $proc.StartInfo = $psi
  if (-not $proc.Start()) { throw "Process.Start returned false" }
  # Async draining is mandatory: otherwise the 64 KB pipe fills up and the
  # child blocks forever on write -- the classic silent hang.
  #
  # The callback runs in its own scope: local variables ($outPath, ...) are
  # NOT visible there, the payload must come through -MessageData ($Event.MessageData).
  # UTF-8 explicitly: the node output is UTF-8 and StreamWriter defaults to ANSI.
  # Append-and-close per line, never hold the file open: children inherit our
  # handles, and a held-open log would make the next launch of the same shard
  # fail with "file is being used by another process".
  $msg = [pscustomobject]@{
    Out = $stdoutPath; Err = $stderrPath
    Utf8 = New-Object System.Text.UTF8Encoding($false)
  }
  $null = Register-ObjectEvent -InputObject $proc -EventName OutputDataReceived -Action {
    try {
      if ($null -ne $EventArgs.Data) {
        [System.IO.File]::AppendAllText($Event.MessageData.Out, $EventArgs.Data + "`r`n", $Event.MessageData.Utf8)
      }
    } catch { }
  } -MessageData $msg
  $null = Register-ObjectEvent -InputObject $proc -EventName ErrorDataReceived -Action {
    try {
      if ($null -ne $EventArgs.Data) {
        [System.IO.File]::AppendAllText($Event.MessageData.Err, $EventArgs.Data + "`r`n", $Event.MessageData.Utf8)
      }
    } catch { }
  } -MessageData $msg
  $proc.BeginOutputReadLine()
  $proc.BeginErrorReadLine()
  return $proc
}

if ($Stop) {
  $pids = @()
  for ($i = 1; $i -le $Parallel; $i++) {
    $pf = Get-ShardFile $i "pid"
    if (Test-Path $pf) {
      $v = (Get-Content $pf -ErrorAction SilentlyContinue | Select-Object -First 1)
      if ($v -match '^\d+$') { $pids += [int]$v }
    }
  }
  if ($pids.Count -eq 0) { Write-Host "[forever] no recorded shard pids in $OutDir"; exit 0 }
  foreach ($p in $pids) { Stop-Tree $p; Write-Host "[forever] killed pid $p" }
  exit 0
}

if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir | Out-Null }

# $root is what the children get as WorkingDirectory, so it must be absolute.
$root = (Resolve-Path ".").ProviderPath
$ModelAbs = (Resolve-Path $Model).ProviderPath
$Model2Abs = (Resolve-Path $Model2).ProviderPath

# All derived paths must be ABSOLUTE before we hand them to another process or
# to a background event action: those resolve relative names against their own
# working directory, not ours.
$OutDir = (Resolve-Path $OutDir).ProviderPath

if ($DryRun) {
  # DryRun must never block: print the launch plan once and exit.
  for ($i = 1; $i -le $Parallel; $i++) {
    $seed = $BaseSeed + $i * 7919
    Write-Host ("[forever] DRYRUN shard {0}: node tools/distill/run-match-long.mjs --out {1} --games {2} --depth {3} --time {4} --model {5} --model2 {6} --opening {7} --max-ply {8} --seed {9}" -f `
      $i, (Get-ShardFile $i "jsonl"), $GamesPerShard, $Depth, $TimeMs, $ModelAbs, $Model2Abs, $Opening, $MaxPly, $seed)
  }
  exit 0
}

if ($StatusOnly) {
  $stats = @()
  for ($i = 1; $i -le $Parallel; $i++) { $stats += Measure-Shard $i }
  for ($i = 1; $i -le $Parallel; $i++) {
    $s = $stats[$i - 1]
    Write-Host ("[forever] shard {0}: {1}/{2}  {3}W/{4}D/{5}L  last write {6:HH:mm:ss}" -f `
      $i, $s.Done, $GamesPerShard, $s.W, $s.D, $s.L, $s.LastWrite)
  }
  Write-Report $stats
  exit 0
}

if (-not $DryRun) {
  foreach ($f in @($Model, $Model2)) {
    if (-not (Test-Path $f)) { throw "[forever] model not found: $f" }
  }
  if (-not (Test-Path "tools/distill/run-match-long.mjs")) {
    throw "[forever] missing tools/distill/run-match-long.mjs"
  }
}

Write-Host ("[forever] model  = {0}" -f $Model)
Write-Host ("[forever] model2 = {0}" -f $Model2)
Write-Host ("[forever] depth={0} time={1}ms opening={2} maxPly={3}" -f $Depth, $TimeMs, $Opening, $MaxPly)
Write-Host ("[forever] shards={0} x {1} games   out={2}" -f $Parallel, $GamesPerShard, $OutDir)
Write-Host ("[forever] stall kill: {0} min without a new result" -f $StallMinutes)

# ---------------------------------------------------------------- main loop

$state = @{}
for ($i = 1; $i -le $Parallel; $i++) {
  $state[$i] = [pscustomobject]@{
    Proc = $null; Fails = 0; NextTry = [datetime]::MinValue
    Restarts = 0; LastDone = -1; LastChange = Get-Date
  }
}

# Ctrl+C / window close: take the children down with us instead of leaving
# orphaned node processes that keep fighting for CPU on the next launch.
$null = Register-EngineEvent PowerShell.Exiting -Action {
  foreach ($k in $state.Keys) {
    $p = $state[$k].Proc
    if ($p -and -not $p.HasExited) { try { $p.Kill() } catch { } }
  }
}

$t0 = Get-Date
$lastReport = Get-Date

while ($true) {
  $stats = @()
  for ($i = 1; $i -le $Parallel; $i++) { $stats += Measure-Shard $i }

  $allDone = $true
  for ($i = 1; $i -le $Parallel; $i++) {
    if ($stats[$i - 1].Done -lt $GamesPerShard) { $allDone = $false; break }
  }
  if ($allDone) {
    Write-Host "[forever] all shards reached target."
    Write-Report $stats
    break
  }

  $now = Get-Date
  for ($i = 1; $i -le $Parallel; $i++) {
    $st = $state[$i]
    $s = $stats[$i - 1]
    $alive = $st.Proc -and -not $st.Proc.HasExited

    if ($s.Done -ge $GamesPerShard) {
      if ($alive) {
        # Process finished a whole batch but the file says more is missing:
        # rare, but a batch may end early when every remaining index already
        # exists. Kill it and let the next launch take the rest.
        Stop-Tree $st.Proc.Id
      }
      continue
    }

    if ($alive) {
      # watchdog: a live process that produces no new result for N minutes is
      # hung (bad ONNX session, deadlocked worker thread, ...). Kill and retry.
      if ($s.Done -ne $st.LastDone) { $st.LastDone = $s.Done; $st.LastChange = $now }
      if (($now - $st.LastChange).TotalMinutes -ge $StallMinutes) {
        Write-Host ("[forever] shard {0} stalled at {1}/{2} for {3:N0} min -> kill pid {4}" -f `
          $i, $s.Done, $GamesPerShard, ($now - $st.LastChange).TotalMinutes, $st.Proc.Id)
        Stop-Tree $st.Proc.Id
        $st.Proc = $null
        $st.LastChange = $now
      }
      continue
    }

    # --- shard is not running; restart it, with exponential backoff
    if ($now -lt $st.NextTry) { continue }
    if ($st.Fails -ge $MaxConsecutiveFailures) {
      Write-Host ("[forever] shard {0} gave up after {1} consecutive failures; other shards continue." -f $i, $st.Fails)
      continue
    }

    $seed = $BaseSeed + $i * 7919
    $log = Get-ShardFile $i "log"
    $errLog = Get-ShardFile $i "err.log"
    $jsonl = Get-ShardFile $i "jsonl"
    $nodeArgs = @(
      "tools/distill/run-match-long.mjs",
      "--out", $jsonl,
      "--games", "$GamesPerShard",
      "--depth", "$Depth",
      "--time", "$TimeMs",
      "--model", $ModelAbs,
      "--model2", $Model2Abs,
      "--opening", "$Opening",
      "--max-ply", "$MaxPly",
      "--seed", "$seed"
    )
    if ($DryRun) {
      Write-Host ("[forever] DRYRUN shard {0} (done {1}): node {2}" -f $i, $s.Done, ($nodeArgs -join " "))
      continue
    }
    try {
      $p = Start-ChildNode $nodeArgs $log $errLog
      Set-Content -Path (Get-ShardFile $i "pid") -Value $p.Id -Encoding ASCII

      $st.Proc = $p
      $st.Restarts++
      $st.LastDone = $s.Done
      $st.LastChange = $now
      Write-Host ("[forever] shard {0} started (pid {1}) at {2}/{3}" -f $i, $p.Id, $s.Done, $GamesPerShard)
    } catch {
      $st.Fails++
      $st.NextTry = $now.AddSeconds([math]::Min(300, [math]::Pow(2, $st.Fails) * 5))
      Write-Host ("[forever] shard {0} launch failed ({1}); retry in {2:N0}s" -f $i, $_.Exception.Message, ($st.NextTry - $now).TotalSeconds)
    }
  }

  # --- harvest exited processes: success or failure bookkeeping
  foreach ($i in 1..$Parallel) {
    $st = $state[$i]
    if ($st.Proc -and $st.Proc.HasExited) {
      $exited = $st.Proc
      $st.Proc = $null
      # Release the redirected pipes and the per-process event subscriptions;
      # otherwise both accumulate across the (many) restarts of a long run.
      try { $exited.StandardOutput.Dispose(); $exited.StandardError.Dispose(); $exited.Dispose() } catch { }
      try {
        Get-EventSubscriber | Where-Object { $_.SourceObject -eq $exited } | Unregister-Event -ErrorAction SilentlyContinue
      } catch { }
      $code = $exited.ExitCode
      if ($code -eq 0) {
        $st.Fails = 0
        $st.NextTry = Get-Date
      } else {
        $st.Fails++
        $wait = [math]::Min(600, [math]::Pow(2, $st.Fails) * 10)
        $st.NextTry = (Get-Date).AddSeconds($wait)
        Write-Host ("[forever] shard {0} exited code {1} (fail {2}/{3}); retry in {4:N0}s" -f `
          $i, $code, $st.Fails, $MaxConsecutiveFailures, $wait)
      }
    }
  }

  if (((Get-Date) - $lastReport).TotalSeconds -ge 120) {
    $n = 0; $tw = 0; $td = 0; $tl = 0
    foreach ($s in $stats) { $tw += $s.W; $td += $s.D; $tl += $s.L; $n += $s.Done }
    $rate = if (($tw + $td + $tl) -gt 0) { ([double]$tw + 0.5 * [double]$td) / [double]($tw + $td + $tl) } else { 0 }
    $perMin = if (((Get-Date) - $t0).TotalMinutes -gt 0) { $n / ((Get-Date) - $t0).TotalMinutes } else { 0 }
    $aim = $Parallel * $GamesPerShard
    $eta = if ($perMin -gt 0) { (($aim - $n) / $perMin) } else { -1 }
    Write-Host ("[forever] {0}/{1} games  {2:N1}/min  new {3}W/{4}D/{5}L  score {6:N3}  elapsed {7:N1}h  ETA {8:N1}h" -f `
      $n, $aim, $perMin, $tw, $td, $tl, $rate, ((Get-Date) - $t0).TotalHours, ($eta / 60))
    $lastReport = Get-Date
  }

  Start-Sleep -Seconds $PollSeconds
}

Write-Host "[forever] finished."
