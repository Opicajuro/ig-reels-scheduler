# Starts and stops the database, file storage, worker and web app on this PC. Dot-sourced by setup-localirs.ps1,
# start-localirs.ps1 and stop-localirs.ps1, so all three handle them the same way. Each function throws when its
# service cannot be started.

# A plain TCP connect with a short timeout; Test-NetConnection falls back to ping and DNS and takes many seconds.
function Test-LocalPort([int]$port) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    return $client.ConnectAsync("127.0.0.1", $port).Wait(500)
  } catch {
    return $false
  } finally {
    $client.Dispose()
  }
}

# The Server header of whatever answers on the port, so another program on 9000 is not mistaken for SeaweedFS.
function Get-ServerHeader([int]$port) {
  $request = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:$port/")
  $request.Timeout = 2000
  try {
    $response = $request.GetResponse()
  } catch [System.Net.WebException] {
    $response = $_.Exception.Response
  }
  if ($null -eq $response) { return "" }
  try { return [string]$response.Headers["Server"] } finally { $response.Close() }
}

# Every process Localirs starts writes its id to data\run\<name>.pid, so a second start skips it and Quit can stop it.
function Get-PidFile([string]$data, [string]$name) {
  $run = Join-Path $data "run"
  New-Item -ItemType Directory -Force -Path $run | Out-Null
  return Join-Path $run "$name.pid"
}

function Test-RunningFromPidFile([string]$data, [string]$name) {
  $pidFile = Get-PidFile $data $name
  if (-not (Test-Path $pidFile)) { return $false }
  return $null -ne (Get-Process -Id ([int](Get-Content $pidFile -Raw)) -ErrorAction SilentlyContinue)
}

function Start-HiddenProcess([string]$data, [string]$name, [string]$filePath, [string]$workDir, [string[]]$arguments) {
  if (Test-RunningFromPidFile $data $name) { return }
  $process = Start-Process -PassThru -WindowStyle Hidden -WorkingDirectory $workDir -FilePath $filePath -ArgumentList $arguments `
    -RedirectStandardOutput (Join-Path $data "$name.log") -RedirectStandardError (Join-Path $data "$name.err.log")
  Set-Content -Path (Get-PidFile $data $name) -Value $process.Id -Encoding ascii
}

# Stops the process and its children (tsx and next start run child processes of their own).
function Stop-ProcessFromPidFile([string]$data, [string]$name) {
  $pidFile = Get-PidFile $data $name
  if (Test-RunningFromPidFile $data $name) {
    & taskkill.exe /PID ([int](Get-Content $pidFile -Raw)) /T /F | Out-Null
  }
  Remove-Item -Force $pidFile -ErrorAction SilentlyContinue
}

# Ends every process whose program is inside the folder. One that already exited in the meantime is skipped.
function Stop-ProcessesInFolder([string]$folder) {
  $prefix = $folder.TrimEnd("\") + "\"
  Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

function Start-Database([string]$pgBin, [string]$data) {
  $pgData = Join-Path $data "postgres"
  & (Join-Path $pgBin "pg_ctl.exe") -D $pgData status | Out-Null
  if ($LASTEXITCODE -eq 0) { return }
  # This folder's database is not running, so anything on 5432 is another program, usually an earlier Localirs install.
  if (Test-LocalPort 5432) {
    throw "Port 5432 is used by another program, probably Localirs installed in another folder. Quit that one (its tray icon or its PowerShell window), or restart the PC, then try again."
  }
  # No pipe here: pg_ctl's child keeps a pipe open for as long as the server runs, which would hang the script.
  & (Join-Path $pgBin "pg_ctl.exe") -D $pgData -l (Join-Path $data "postgres.log") -o "-p 5432" -w start
  if ($LASTEXITCODE -ne 0) {
    $log = Get-Content (Join-Path $data "postgres.log") -Tail 15 -ErrorAction SilentlyContinue
    throw "The database did not start. The end of data\postgres.log:`r`n$($log -join "`r`n")"
  }
}

function Stop-Database([string]$pgBin, [string]$data) {
  $pgData = Join-Path $data "postgres"
  & (Join-Path $pgBin "pg_ctl.exe") -D $pgData status | Out-Null
  if ($LASTEXITCODE -ne 0) { return }
  & (Join-Path $pgBin "pg_ctl.exe") -D $pgData -m fast -w stop | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "The database did not stop. See data\postgres.log" }
}

function Start-Storage([string]$tools, [string]$data) {
  if (Test-LocalPort 9000) {
    if ((Get-ServerHeader 9000) -like "SeaweedFS*") { return }
    throw "Port 9000 is used by another program. Close it, then try again."
  }
  Start-HiddenProcess $data "storage" (Join-Path $tools "weed.exe") $tools @(
    "server", "-dir=`"$(Join-Path $data "seaweedfs")`"", "-s3", "-s3.port=9000",
    "-s3.config=`"$(Join-Path $data "s3.json")`"", "-s3.iam.config=`"$(Join-Path $data "iam.json")`"",
    "-ip=127.0.0.1", "-ip.bind=127.0.0.1"
  )
  for ($attempt = 0; $attempt -lt 60; $attempt++) {
    if (Test-LocalPort 9000) { return }
    Start-Sleep -Milliseconds 500
  }
  throw "File storage did not start. See data\storage.err.log"
}
