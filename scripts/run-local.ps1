# Runs Localirs from this folder on Windows. Needs Node 22, Docker Desktop (running) and pnpm 10.28.0.
# Run it from the repo root: powershell -ExecutionPolicy Bypass -File scripts\run-local.ps1
# The wizard asks for your Resend key and sender address the first time, then starts Postgres and file storage,
# creates the bucket and applies the migrations. Then the worker opens in its own window and the web app runs here.
$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $root

pnpm install
if ($LASTEXITCODE -ne 0) { throw "pnpm install failed" }

pnpm wizard
if ($LASTEXITCODE -ne 0) { throw "Setup failed. Read the messages above." }

Start-Process powershell -ArgumentList @("-NoExit", "-Command", "pnpm worker") -WorkingDirectory $root
pnpm dev
