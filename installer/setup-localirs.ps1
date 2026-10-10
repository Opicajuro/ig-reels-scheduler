# Runs once after install, and again if you need to change the setup. Asks for the few things only you can give
# (a Resend key for sign-in email and a sender address), starts the database and file storage on this PC, and
# writes the app settings. Nothing else is installed.
$ErrorActionPreference = "Stop"
$install = $PSScriptRoot
$app = Join-Path $install "app"
$tools = Join-Path $install "tools"
$data = Join-Path $install "data"
$node = Join-Path $tools "node\node.exe"
$pgBin = Join-Path $tools "postgres\bin"
New-Item -ItemType Directory -Force -Path $data | Out-Null

function New-Secret([int]$length) {
  -join ((48..57 + 65..90 + 97..122) | Get-Random -Count $length | ForEach-Object { [char]$_ })
}

$secretsPath = Join-Path $data "secrets.json"
if (Test-Path $secretsPath) {
  $secrets = Get-Content $secretsPath -Raw | ConvertFrom-Json
} else {
  Write-Host "Localirs setup. You need a Resend account for sign-in emails (https://resend.com)."
  $secrets = [pscustomobject]@{
    resendApiKey = Read-Host "Resend API key (starts with re_)"
    emailFrom = Read-Host "Sender address, for example Scheduler <alerts@your-domain.com>"
    postgresSuperPassword = New-Secret 24
    postgresAppPassword = New-Secret 24
    minioPassword = New-Secret 24
  }
  $secrets | ConvertTo-Json | Set-Content -Path $secretsPath
}

$pgData = Join-Path $data "postgres"
if (-not (Test-Path $pgData)) {
  $pwFile = Join-Path $data "pgpass.tmp"
  Set-Content -NoNewline -Path $pwFile -Value $secrets.postgresSuperPassword
  & (Join-Path $pgBin "initdb.exe") -D $pgData -U postgres --pwfile=$pwFile -E UTF8 | Out-Null
  Remove-Item $pwFile
}
& (Join-Path $pgBin "pg_ctl.exe") -D $pgData -l (Join-Path $data "postgres.log") -o "-p 5432" start | Out-Null

$env:MINIO_ROOT_USER = "localirs"
$env:MINIO_ROOT_PASSWORD = $secrets.minioPassword
Start-Process -WindowStyle Hidden -FilePath (Join-Path $tools "minio.exe") -ArgumentList @(
  "server", (Join-Path $data "minio"), "--address", "127.0.0.1:9000", "--console-address", "127.0.0.1:9001"
) -RedirectStandardOutput (Join-Path $data "minio.log") -RedirectStandardError (Join-Path $data "minio.err.log")
Start-Sleep -Seconds 5

$env:LOCALIRS_DB_PASSWORD = $secrets.postgresAppPassword
$env:LOCALIRS_POSTGRES_ADMIN_URL = "postgresql://postgres:$($secrets.postgresSuperPassword)@127.0.0.1:5432/postgres"
$env:LOCALIRS_MINIO_PASSWORD = $secrets.minioPassword
$env:LOCALIRS_RESEND_API_KEY = $secrets.resendApiKey
$env:LOCALIRS_EMAIL_FROM = $secrets.emailFrom
$env:LOCALIRS_CHROME_PATH = Join-Path $tools "chrome\chrome-headless-shell.exe"
$env:LOCALIRS_WHISPER_BIN = Join-Path $tools "whisper\whisper-cli.exe"
$env:LOCALIRS_WHISPER_MODEL = Join-Path $tools "whisper\ggml-base.bin"
$env:PATH = "$tools;$env:PATH"

Push-Location $app
& $node "node_modules\tsx\dist\cli.mjs" "scripts\local-setup.ts"
Pop-Location
Write-Host "Setup finished. Start Localirs from the Start menu."
