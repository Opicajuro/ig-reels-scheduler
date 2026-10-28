# Stops the web app, the worker, file storage and the database, in that order. Localirs.exe runs this with no
# window when you quit it, and the uninstaller runs it before removing files. Output goes to data\stop.log.
$ErrorActionPreference = "Stop"
$install = $PSScriptRoot
$data = Join-Path $install "data"
New-Item -ItemType Directory -Force -Path $data | Out-Null
Start-Transcript -Path (Join-Path $data "stop.log") | Out-Null
try {
  $pgBin = Join-Path $install "tools\postgres\bin"
  . (Join-Path $install "services.ps1")

  Stop-ProcessFromPidFile $data "web"
  Stop-ProcessFromPidFile $data "worker"
  Stop-ProcessFromPidFile $data "storage"
  Stop-Database $pgBin $data
  Write-Host "Localirs stopped."
} catch {
  Write-Host "Localirs did not stop cleanly: $_"
  exit 1
} finally {
  Stop-Transcript | Out-Null
}
