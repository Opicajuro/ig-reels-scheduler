# Runs once after install, and again if you need to change the setup. Asks for the few things only you can give
# (a Resend key for sign-in email and a sender address), starts the database and file storage on this PC, and
# writes the app settings. Nothing else is installed.
$ErrorActionPreference = "Stop"
# The setup window closes as soon as the script ends, so errors are shown and the window waits for Enter.
try {
  $install = $PSScriptRoot
  # PostgreSQL cannot create its database under a path with letters with accents (such as the y in "Novy" with an accent) (the installer refuses such
  # folders too), so stop here with a clear message instead of failing halfway through.
  if ($install -match "[^\x00-\x7F]") {
    throw "Localirs is installed in '$install', which has letters such as y with an accent. Uninstall it and install it again in a folder like C:\Localirs."
  }
  $app = Join-Path $install "app"
  $tools = Join-Path $install "tools"
  $data = Join-Path $install "data"
  $node = Join-Path $tools "node\node.exe"
  $pgBin = Join-Path $tools "postgres\bin"
  . (Join-Path $install "services.ps1")
  New-Item -ItemType Directory -Force -Path $data | Out-Null

  function New-Secret([int]$length) {
    -join ((48..57 + 65..90 + 97..122) | Get-Random -Count $length | ForEach-Object { [char]$_ })
  }

  function New-SigningKey {
    $bytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    [Convert]::ToBase64String($bytes)
  }

  # .env values cannot be empty or hold quotes or line breaks, so the answer is checked here, before it is saved.
  function Test-PlainValue([string]$value) {
    return $value.Trim() -ne "" -and $value -notmatch "[`"'\r\n]"
  }

  function Read-PlainValue([string]$prompt) {
    while ($true) {
      $answer = (Read-Host $prompt).Trim()
      if (Test-PlainValue $answer) { return $answer }
      Write-Host "Please type a value without quotes." -ForegroundColor Yellow
    }
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
  # Asked on the first run, and again on a later run if a saved answer is missing or unusable.
  if (-not (Test-PlainValue $secrets.resendApiKey) -or -not (Test-PlainValue $secrets.emailFrom)) {
    Write-Host "Localirs setup. You need a Resend account for sign-in emails (https://resend.com)."
    $secrets.resendApiKey = Read-PlainValue "Resend API key (starts with re_)"
    $secrets.emailFrom = Read-PlainValue "Sender address on a domain you verified in Resend (to test, use Localirs <onboarding@resend.dev>, which only sends to your Resend account's email)"
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
  if ($setupExit -ne 0) { throw "Setup did not finish. Read the messages above." }
  Write-Host "Setup finished. Start Localirs from the Start menu." -ForegroundColor Green
} catch {
  Write-Host "Setup stopped: $_" -ForegroundColor Red
  exit 1
} finally {
  Read-Host "Press Enter to close"
}
