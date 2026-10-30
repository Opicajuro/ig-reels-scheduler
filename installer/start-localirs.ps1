# Starts the database, file storage, the background worker and the web app. Localirs.exe runs this with no window,
# waits for the web app to answer, then opens it. Everything printed here goes to data\start.log, which Localirs.exe
# shows if starting fails. A service that is already running is left as it is.
$ErrorActionPreference = "Stop"
$install = $PSScriptRoot
$data = Join-Path $install "data"
New-Item -ItemType Directory -Force -Path $data | Out-Null
Start-Transcript -Path (Join-Path $data "start.log") | Out-Null
try {
  $app = Join-Path $install "app"
  $tools = Join-Path $install "tools"
  $node = Join-Path $tools "node\node.exe"
  $pgBin = Join-Path $tools "postgres\bin"
  . (Join-Path $install "services.ps1")
  $env:PATH = "$tools;$env:PATH"

  # Runs a database or Prisma tool and adds its output to data\restore.log. Inside this function a message on stderr
  # (psql prints notices there) does not end the script; the exit code decides.
  function Invoke-RestoreTool([string]$log, [string]$exe, [string[]]$arguments) {
    $ErrorActionPreference = "Continue"
    & $exe @arguments 2>&1 | ForEach-Object { "$_" } | Add-Content -Path $log
    if ($LASTEXITCODE -ne 0) { throw "$(Split-Path -Leaf $exe) failed (exit code $LASTEXITCODE)." }
  }

  # A restore asked for on the Settings page (data\restore-request.json, written by src/lib/backup.ts) runs here, with
  # the database running and before file storage, the worker and the web app start, so nothing uses what it replaces.
  # The database is dropped and made again from the backup's dump as the app's role, then migrated, so a backup from
  # an older build gets this build's tables. On failure the request stays, so the next start tries again.
  function Restore-Backup([string]$requestPath) {
    $log = Join-Path $data "restore.log"
    $backup = (Get-Content $requestPath -Raw -Encoding UTF8 | ConvertFrom-Json).backupPath
    Add-Content -Path $log -Value "$(Get-Date -Format s) Restoring $backup"
    try {
      foreach ($name in @("web", "worker", "storage")) {
        if (Test-RunningFromPidFile $data $name) { throw "Localirs is still running ($name). Quit it from its tray icon first." }
      }
      $dump = Join-Path $backup "localirs.dump"
      if (-not (Test-Path $dump)) { throw "$dump is missing." }
      $secrets = Get-Content (Join-Path $data "secrets.json") -Raw | ConvertFrom-Json
      $env:PGPASSWORD = $secrets.postgresSuperPassword
      try {
        $admin = @("-h", "127.0.0.1", "-p", "5432", "-U", "postgres")
        Invoke-RestoreTool $log (Join-Path $pgBin "psql.exe") ($admin + @("-d", "postgres", "-v", "ON_ERROR_STOP=1",
          "-c", "DROP DATABASE IF EXISTS localirs WITH (FORCE)", "-c", "CREATE DATABASE localirs OWNER localirs"))
        Invoke-RestoreTool $log (Join-Path $pgBin "pg_restore.exe") ($admin + @("-d", "localirs", "--no-owner", "--role=localirs",
          "--exit-on-error", "--single-transaction", $dump))
      } finally {
        Remove-Item Env:\PGPASSWORD
      }
      Copy-Item -Force (Join-Path $backup "secrets.json") (Join-Path $data "secrets.json")
      # The app's .env holds the key that decrypts the tokens and secrets in the restored database.
      Copy-Item -Force (Join-Path $backup "app.env") (Join-Path $app ".env")
      $backupStorage = Join-Path $backup "seaweedfs"
      if (Test-Path $backupStorage) {
        $storage = Join-Path $data "seaweedfs"
        Remove-Item -Recurse -Force $storage
        Copy-Item -Recurse $backupStorage $storage
      }
      Push-Location $app
      try {
        Invoke-RestoreTool $log $node @("node_modules\prisma\build\index.js", "migrate", "deploy")
      } finally {
        Pop-Location
      }
    } catch {
      Add-Content -Path $log -Value "$(Get-Date -Format s) Restore failed: $_"
      throw "Restoring the backup in $backup failed: $_ The details are in data\restore.log. Open Localirs again to try again, or delete data\restore-request.json to start without restoring."
    }
    Remove-Item -Force $requestPath
    Add-Content -Path $log -Value "$(Get-Date -Format s) Restored $backup"
    Write-Host "Restored the backup in $backup."
  }

  Start-Database $pgBin $data
  $restoreRequest = Join-Path $data "restore-request.json"
  if (Test-Path $restoreRequest) { Restore-Backup $restoreRequest }
  Start-Storage $tools $data
  Start-HiddenProcess $data "worker" $node $app @("node_modules\tsx\dist\cli.mjs", "--env-file-if-exists=.env", "src\worker\index.ts")
  # 127.0.0.1 only: Localirs has no sign-in, so other PCs on the network must not reach it.
  Start-HiddenProcess $data "web" $node $app @("node_modules\next\dist\bin\next", "start", "-p", "3000", "-H", "127.0.0.1")
  Write-Host "Localirs started."
} catch {
  Write-Host "Localirs did not start: $_"
  exit 1
} finally {
  Stop-Transcript | Out-Null
}
