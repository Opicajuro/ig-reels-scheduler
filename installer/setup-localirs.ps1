# Runs after every install and update. Starts the database and file storage on this PC, and writes the app settings.
# The installer passes in the Resend API key and sender address from its own window. An update that leaves the key
# empty keeps the key saved before. Nothing here asks for input: the installer runs this window hidden, so everything
# printed here goes to data\setup.log, which the installer points to if setup fails.
param([string]$ResendApiKey = "", [string]$EmailFrom = "")
$ErrorActionPreference = "Stop"
$install = $PSScriptRoot
$data = Join-Path $install "data"
New-Item -ItemType Directory -Force -Path $data | Out-Null
Start-Transcript -Path (Join-Path $data "setup.log") | Out-Null
try {
  $app = Join-Path $install "app"
  $tools = Join-Path $install "tools"
  $node = Join-Path $tools "node\node.exe"
  $pgBin = Join-Path $tools "postgres\bin"
  . (Join-Path $install "services.ps1")

  function New-Secret([int]$length) {
    -join ((48..57 + 65..90 + 97..122) | Get-Random -Count $length | ForEach-Object { [char]$_ })
  }

  function New-SigningKey {
    $bytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    [Convert]::ToBase64String($bytes)
  }

  # .env values cannot be empty or hold quotes or line breaks, so the values are checked before they are saved.
  function Test-PlainValue([string]$value) {
    return $value.Trim() -ne "" -and $value -notmatch "[`"'\r\n]"
  }

  $secretsPath = Join-Path $data "secrets.json"
  if (Test-Path $secretsPath) {
    $secrets = Get-Content $secretsPath -Raw | ConvertFrom-Json
  } else {
    $secrets = [pscustomobject]@{
      resendApiKey = ""
      emailFrom = ""
      postgresSuperPassword = New-Secret 24
      postgresAppPassword = New-Secret 24
      storageSecret = New-Secret 24
      storageSigningKey = New-SigningKey
    }
  }
  if ($ResendApiKey -ne "") { $secrets.resendApiKey = $ResendApiKey }
  if ($EmailFrom -ne "") { $secrets.emailFrom = $EmailFrom }
  if (-not (Test-PlainValue $secrets.resendApiKey) -or -not (Test-PlainValue $secrets.emailFrom)) {
    throw "There is no Resend API key or sender address. Run the installer again and enter them."
  }
  $secrets | ConvertTo-Json | Set-Content -Path $secretsPath

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
    try {
      # --locale=C: with a non-English Windows locale (such as Slovak_Slovakia.1250), initdb's translated messages
      # come out in the Windows code page and the UTF-8 database rejects them ("invalid byte sequence for encoding").
      & (Join-Path $pgBin "initdb.exe") -D $pgData -U postgres --pwfile=$pwFile -E UTF8 --locale=C -A scram-sha-256
      if ($LASTEXITCODE -ne 0) { throw "Creating the database failed (initdb)." }
    } finally {
      # The file holds the database superuser password, so it never stays on disk.
      Remove-Item -Force $pwFile -ErrorAction SilentlyContinue
    }
  }
  Start-Database $pgBin $data
  Start-Storage $tools $data

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
  $setupExit = $LASTEXITCODE
  Pop-Location
  if ($setupExit -ne 0) { throw "Setup did not finish. The messages are in data\setup.log." }
  Write-Host "Setup finished."
} catch {
  Write-Host "Setup stopped: $_" -ForegroundColor Red
  exit 1
} finally {
  Stop-Transcript | Out-Null
}
