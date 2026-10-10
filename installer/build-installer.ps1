# Builds Localirs-Setup.exe on a Windows PC. Needs: Inno Setup 6 (iscc.exe), git, and Go (to build SeaweedFS).
# Downloads the pinned tools into installer\payload\tools, compiles node_modules for Windows,
# and packs everything with Inno Setup. Downloads are checked against tools.json; a null hash is
# filled in on the first build and checked on every build after that.
$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$payload = Join-Path $PSScriptRoot "payload"
$tools = Join-Path $payload "tools"
$manifestPath = Join-Path $PSScriptRoot "tools.json"
$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json

New-Item -ItemType Directory -Force -Path $tools | Out-Null

function Get-Tool($name, $entry, $target) {
  $file = Join-Path $tools $target
  if (-not (Test-Path $file)) {
    Write-Host "Downloading $name $($entry.version)"
    try {
      Invoke-WebRequest -Uri $entry.url -OutFile $file -UseBasicParsing
    } catch {
      # A failed download must not stay behind, or the tools cache would keep it for the next build.
      Remove-Item -Force $file -ErrorAction SilentlyContinue
      throw
    }
  }
  $hash = (Get-FileHash $file -Algorithm SHA256).Hash.ToLower()
  if ($entry.sha256) {
    if ($hash -ne $entry.sha256.ToLower()) { throw "$name hash $hash does not match tools.json" }
  } else {
    Write-Host "$name sha256 $hash - add it to tools.json to pin this download"
  }
  return $file
}

$nodeZip = Get-Tool "Node" $manifest.node "node.zip"
$ffmpegZip = Get-Tool "ffmpeg" $manifest.ffmpeg "ffmpeg.zip"
$ytDlp = Get-Tool "yt-dlp" $manifest.ytDlp "yt-dlp.exe"
$whisperZip = Get-Tool "whisper.cpp" $manifest.whisperCpp "whisper.zip"
$whisperModel = Get-Tool "Whisper model" $manifest.whisperModel "ggml-base.bin"
$chromeZip = Get-Tool "Chrome headless shell" $manifest.chromeHeadlessShell "chrome-headless-shell.zip"
$pgZip = Get-Tool "PostgreSQL" $manifest.postgres "postgres.zip"
$seaweedZip = Get-Tool "SeaweedFS source" $manifest.seaweedfs "seaweedfs-src.zip"

Expand-Archive -Force $nodeZip (Join-Path $tools "node-unzip")
Move-Item -Force (Get-ChildItem (Join-Path $tools "node-unzip") -Directory | Select-Object -First 1).FullName (Join-Path $tools "node")
Remove-Item -Recurse -Force (Join-Path $tools "node-unzip")

Expand-Archive -Force $ffmpegZip (Join-Path $tools "ffmpeg-unzip")
Copy-Item -Force (Get-ChildItem (Join-Path $tools "ffmpeg-unzip") -Recurse -Filter ffmpeg.exe | Select-Object -First 1).FullName (Join-Path $tools "ffmpeg.exe")
Copy-Item -Force (Get-ChildItem (Join-Path $tools "ffmpeg-unzip") -Recurse -Filter ffprobe.exe | Select-Object -First 1).FullName (Join-Path $tools "ffprobe.exe")
Remove-Item -Recurse -Force (Join-Path $tools "ffmpeg-unzip")

# SeaweedFS is built from the pinned Go module, because its Windows release downloads are not a stable source.
# It is unpacked under the temp folder: its deepest paths do not fit in the 260-character limit under the installer folder.
$seaweedSrc = Join-Path ([System.IO.Path]::GetTempPath()) "localirs-seaweedfs"
Expand-Archive -Force $seaweedZip $seaweedSrc
$seaweedDir = (Get-ChildItem $seaweedSrc -Recurse -Filter go.mod | Sort-Object { $_.FullName.Length } | Select-Object -First 1).Directory.FullName
Push-Location $seaweedDir
# The FUSE mount in SeaweedFS needs WinFsp headers, which the build machine does not have, so build without cgo.
$env:CGO_ENABLED = "0"
go build -ldflags "-s -w" -o (Join-Path $tools "weed.exe") ./weed
if ($LASTEXITCODE -ne 0) { throw "go build of SeaweedFS failed" }
Pop-Location
Remove-Item -Recurse -Force $seaweedSrc

Expand-Archive -Force $whisperZip (Join-Path $tools "whisper")
Copy-Item -Force $whisperModel (Join-Path $tools "whisper\ggml-base.bin")

Expand-Archive -Force $chromeZip (Join-Path $tools "chrome-unzip")
Move-Item -Force (Join-Path $tools "chrome-unzip\chrome-headless-shell-win64") (Join-Path $tools "chrome")
Remove-Item -Recurse -Force (Join-Path $tools "chrome-unzip")

Expand-Archive -Force $pgZip (Join-Path $tools "postgres-unzip")
Move-Item -Force (Join-Path $tools "postgres-unzip\pgsql") (Join-Path $tools "postgres")
Remove-Item -Recurse -Force (Join-Path $tools "postgres-unzip")

# The app itself: tracked files only, then Windows-native dependencies.
$app = Join-Path $payload "app"
if (Test-Path $app) { Remove-Item -Recurse -Force $app }
New-Item -ItemType Directory -Force -Path $app | Out-Null
# The archive goes to a file first: piping git's binary tar output through PowerShell corrupts it.
$appTar = Join-Path $payload "app.tar"
git -C $root archive --format=tar --output=$appTar HEAD
if ($LASTEXITCODE -ne 0) { throw "git archive failed" }
tar -xf $appTar -C $app
if ($LASTEXITCODE -ne 0) { throw "extracting the app archive failed" }
Remove-Item $appTar
Push-Location $app
$env:PATH = "$(Join-Path $tools 'node');$env:PATH"
# Prisma and next build read the app's settings when they load, so give them placeholders first. The real values
# are written on the user's PC by setup-localirs.ps1.
$placeholders = @{
  DATABASE_URL = "postgresql://build:build@127.0.0.1:5432/build"
  S3_ENDPOINT = "http://127.0.0.1:9000"; S3_BUCKET = "build"; S3_ACCESS_KEY = "build"; S3_SECRET_KEY = "build-secret"
  TOKEN_ENC_KEY = [Convert]::ToBase64String((1..32 | ForEach-Object { [byte]$_ }))
  IG_APP_ID = "0"; IG_APP_SECRET = "build"; IG_REDIRECT_URI = "http://localhost:3000/api/ig/callback"
  AUTH_SECRET = "build-secret"; RESEND_API_KEY = "re_build"; EMAIL_FROM = "build@example.test"; APP_URL = "http://localhost:3000"
}
foreach ($key in $placeholders.Keys) { Set-Item -Path "Env:$key" -Value $placeholders[$key] }
corepack enable
pnpm install --frozen-lockfile
if ($LASTEXITCODE -ne 0) { throw "pnpm install failed" }
pnpm exec prisma generate
if ($LASTEXITCODE -ne 0) { throw "prisma generate failed" }
pnpm build
if ($LASTEXITCODE -ne 0) { throw "pnpm build failed" }
Pop-Location

& "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" (Join-Path $PSScriptRoot "localirs.iss")
if ($LASTEXITCODE -ne 0) { throw "Inno Setup failed" }
Write-Host "Built installer\Output\Localirs-Setup.exe"
