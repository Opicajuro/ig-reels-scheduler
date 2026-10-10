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

function New-SigningKey {
  $bytes = New-Object byte[] 32
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  [Convert]::ToBase64String($bytes)
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
    storageSecret = New-Secret 24
    storageSigningKey = New-SigningKey
  }
  $secrets | ConvertTo-Json | Set-Content -Path $secretsPath
}

# File storage (SeaweedFS) reads these two files: one identity for the app, and the key it signs temporary tokens with.
$storageData = Join-Path $data "seaweedfs"
New-Item -ItemType Directory -Force -Path $storageData | Out-Null
$storageConfig = Join-Path $data "s3.json"
$storageIam = Join-Path $data "iam.json"
@{ identities = @(@{ name = "localirs"; credentials = @(@{ accessKey = "localirs"; secretKey = $secrets.storageSecret }); actions = @("Admin", "Read", "Write", "List", "Tagging") }) } | ConvertTo-Json -Depth 6 | Set-Content -Path $storageConfig -Encoding ascii
@{ sts = @{ signingKey = $secrets.storageSigningKey } } | ConvertTo-Json -Depth 4 | Set-Content -Path $storageIam -Encoding ascii

$pgData = Join-Path $data "postgres"
if (-not (Test-Path $pgData)) {
  $pwFile = Join-Path $data "pgpass.tmp"
  Set-Content -NoNewline -Path $pwFile -Value $secrets.postgresSuperPassword
  & (Join-Path $pgBin "initdb.exe") -D $pgData -U postgres --pwfile=$pwFile -E UTF8 | Out-Null
  Remove-Item $pwFile
}
& (Join-Path $pgBin "pg_ctl.exe") -D $pgData -l (Join-Path $data "postgres.log") -o "-p 5432" start | Out-Null

Start-Process -WindowStyle Hidden -FilePath (Join-Path $tools "weed.exe") -ArgumentList @(
  "server", "-dir=`"$storageData`"", "-s3", "-s3.port=9000", "-s3.config=`"$storageConfig`"", "-s3.iam.config=`"$storageIam`"",
  "-ip=127.0.0.1", "-ip.bind=127.0.0.1"
) -RedirectStandardOutput (Join-Path $data "storage.log") -RedirectStandardError (Join-Path $data "storage.err.log")
$storageReady = $false
for ($attempt = 0; $attempt -lt 30 -and -not $storageReady; $attempt++) {
  $storageReady = Test-NetConnection -ComputerName 127.0.0.1 -Port 9000 -InformationLevel Quiet
  if (-not $storageReady) { Start-Sleep -Seconds 1 }
}
if (-not $storageReady) { throw "File storage did not start. See data\storage.err.log" }

$env:LOCALIRS_DB_PASSWORD = $secrets.postgresAppPassword
$env:LOCALIRS_POSTGRES_ADMIN_URL = "postgresql://postgres:$($secrets.postgresSuperPassword)@127.0.0.1:5432/postgres"
$env:LOCALIRS_STORAGE_SECRET = $secrets.storageSecret
$env:LOCALIRS_RESEND_API_KEY = $secrets.resendApiKey
$env:LOCALIRS_EMAIL_FROM = $secrets.emailFrom
$env:LOCALIRS_CHROME_PATH = Join-Path $tools "chrome\chrome-headless-shell.exe"
$env:LOCALIRS_WHISPER_BIN = Join-Path $tools "whisper\Release\whisper-cli.exe"
$env:LOCALIRS_WHISPER_MODEL = Join-Path $tools "whisper\ggml-base.bin"
$env:PATH = "$tools;$env:PATH"

Push-Location $app
& $node "node_modules\tsx\dist\cli.mjs" "scripts\local-setup.ts"
Pop-Location
Write-Host "Setup finished. Start Localirs from the Start menu."
