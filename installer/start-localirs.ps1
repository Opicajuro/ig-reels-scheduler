# Starts the database, file storage, the background worker and the web app, then opens the app in the browser.
$ErrorActionPreference = "Stop"
try {
  $install = $PSScriptRoot
  $app = Join-Path $install "app"
  $tools = Join-Path $install "tools"
  $data = Join-Path $install "data"
  $node = Join-Path $tools "node\node.exe"
  $pgBin = Join-Path $tools "postgres\bin"
  . (Join-Path $install "services.ps1")
  $env:PATH = "$tools;$env:PATH"

  Start-Database $pgBin $data
  Start-Storage $tools $data

  Start-Process -WindowStyle Hidden -WorkingDirectory $app -FilePath $node -ArgumentList @("node_modules\tsx\dist\cli.mjs", "--env-file-if-exists=.env", "src\worker\index.ts") -RedirectStandardOutput (Join-Path $data "worker.log") -RedirectStandardError (Join-Path $data "worker.err.log")
  Start-Process -WindowStyle Hidden -WorkingDirectory $app -FilePath $node -ArgumentList @("node_modules\next\dist\bin\next", "start", "-p", "3000") -RedirectStandardOutput (Join-Path $data "web.log") -RedirectStandardError (Join-Path $data "web.err.log")

  Start-Sleep -Seconds 6
  Start-Process "http://localhost:3000/clips"
} catch {
  # The window would close at once, so the error stays on screen until Enter.
  Write-Host "Localirs did not start: $_" -ForegroundColor Red
  Read-Host "Press Enter to close"
  exit 1
}
