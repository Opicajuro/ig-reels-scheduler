# Stops the web app, the worker, file storage and the database, in that order, then ends anything else still running
# from the tools folder (versions before the tray launcher kept no PID files) and the AI video engine in data\ai. Localirs.exe runs this with no window
# when you quit it, the uninstaller runs it before removing files, and setup runs it from its temp folder before an
# update, passing the install folder. Output goes to data\stop.log.
param([string]$InstallDir = $PSScriptRoot)
$ErrorActionPreference = "Stop"
$install = $InstallDir
# A fresh install has nothing to stop.
if (-not (Test-Path (Join-Path $install "tools"))) { exit 0 }
$data = Join-Path $install "data"
New-Item -ItemType Directory -Force -Path $data | Out-Null
Start-Transcript -Path (Join-Path $data "stop.log") | Out-Null
try {
  $pgBin = Join-Path $install "tools\postgres\bin"
  . (Join-Path $PSScriptRoot "services.ps1")

  Stop-ProcessFromPidFile $data "web"
  Stop-ProcessFromPidFile $data "worker"
  Stop-ProcessFromPidFile $data "storage"
  if (Test-Path (Join-Path $data "postgres")) { Stop-Database $pgBin $data }
  Stop-ProcessesInFolder (Join-Path $install "tools")
  # ComfyUI, which makes AI videos, runs from the data folder (data\ai) with its own Python.
  Stop-ProcessesInFolder (Join-Path $data "ai")
  Write-Host "Localirs stopped."
} catch {
  Write-Host "Localirs did not stop cleanly: $_"
  exit 1
} finally {
  Stop-Transcript | Out-Null
}
