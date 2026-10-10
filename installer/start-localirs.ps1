# Starts the database, file storage, the background worker and the web app, then opens the app in the browser.
$ErrorActionPreference = "Stop"
$install = $PSScriptRoot
$app = Join-Path $install "app"
$tools = Join-Path $install "tools"
$data = Join-Path $install "data"
$node = Join-Path $tools "node\node.exe"
$pgBin = Join-Path $tools "postgres\bin"
$env:PATH = "$tools;$env:PATH"

& (Join-Path $pgBin "pg_ctl.exe") -D (Join-Path $data "postgres") status | Out-Null
if ($LASTEXITCODE -ne 0) {
  & (Join-Path $pgBin "pg_ctl.exe") -D (Join-Path $data "postgres") -l (Join-Path $data "postgres.log") -o "-p 5432" start | Out-Null
}

Start-Process -WindowStyle Hidden -FilePath (Join-Path $tools "weed.exe") -ArgumentList @(
  "server", "-dir=`"$(Join-Path $data "seaweedfs")`"", "-s3", "-s3.port=9000",
  "-s3.config=`"$(Join-Path $data "s3.json")`"", "-s3.iam.config=`"$(Join-Path $data "iam.json")`"",
  "-ip=127.0.0.1", "-ip.bind=127.0.0.1"
) -RedirectStandardOutput (Join-Path $data "storage.log") -RedirectStandardError (Join-Path $data "storage.err.log")

Push-Location $app
Start-Process -WindowStyle Hidden -FilePath $node -ArgumentList @("node_modules\tsx\dist\cli.mjs", "--env-file-if-exists=.env", "src\worker\index.ts") -RedirectStandardOutput (Join-Path $data "worker.log") -RedirectStandardError (Join-Path $data "worker.err.log")
Start-Process -WindowStyle Hidden -FilePath $node -ArgumentList @("node_modules\next\dist\bin\next", "start", "-p", "3000") -RedirectStandardOutput (Join-Path $data "web.log") -RedirectStandardError (Join-Path $data "web.err.log")
Pop-Location

Start-Sleep -Seconds 6
Start-Process "http://localhost:3000/clips"
