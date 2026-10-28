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

  Start-Database $pgBin $data
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
