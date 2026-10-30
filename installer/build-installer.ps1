# Builds Localirs-Setup.exe on a Windows PC. Needs: Inno Setup 6 (iscc.exe), git, and Go (to build SeaweedFS, once per version).
# Downloads the pinned tools into installer\downloads, unpacks them into installer\payload\tools, compiles node_modules for Windows,
# and packs everything with Inno Setup. Downloads are checked against tools.json; a null hash is
# filled in on the first build and checked on every build after that.
$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$payload = Join-Path $PSScriptRoot "payload"
$tools = Join-Path $payload "tools"
# Downloads stay outside the payload, so the installer ships only the unpacked tools, not their zips.
$downloads = Join-Path $PSScriptRoot "downloads"
$manifestPath = Join-Path $PSScriptRoot "tools.json"
$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
# The pnpm store and the Next.js build cache stay outside the payload too, so they survive a rebuild and are not shipped.
$pnpmStore = Join-Path $PSScriptRoot "pnpm-store"
$nextCache = Join-Path $PSScriptRoot "next-cache"

# Prints how long each phase took, to see where the build's time goes.
$clock = [System.Diagnostics.Stopwatch]::StartNew()
function Write-PhaseTime($phase) {
  Write-Host "[time] ${phase}: $($clock.Elapsed.ToString('mm\:ss'))"
  $clock.Restart()
}

# Start from an empty tools folder, so a second build does not move folders into the ones the first build left.
if (Test-Path $tools) { Remove-Item -Recurse -Force $tools }
New-Item -ItemType Directory -Force -Path $tools, $downloads | Out-Null

function Get-Tool($name, $entry, $target) {
  $file = Join-Path $downloads $target
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
$whisperModel = Get-Tool "Whisper model" $manifest.whisperModel "ggml-large-v3-turbo-q5_0.bin"
$sevenZip = Get-Tool "7-Zip (7zr)" $manifest.sevenZip "7zr.exe"
$chromeZip = Get-Tool "Chrome headless shell" $manifest.chromeHeadlessShell "chrome-headless-shell.zip"
$pgZip = Get-Tool "PostgreSQL" $manifest.postgres "postgres.zip"

Expand-Archive -Force $nodeZip (Join-Path $tools "node-unzip")
Move-Item -Force (Get-ChildItem (Join-Path $tools "node-unzip") -Directory | Select-Object -First 1).FullName (Join-Path $tools "node")
Remove-Item -Recurse -Force (Join-Path $tools "node-unzip")

Expand-Archive -Force $ffmpegZip (Join-Path $tools "ffmpeg-unzip")
Copy-Item -Force (Get-ChildItem (Join-Path $tools "ffmpeg-unzip") -Recurse -Filter ffmpeg.exe | Select-Object -First 1).FullName (Join-Path $tools "ffmpeg.exe")
Copy-Item -Force (Get-ChildItem (Join-Path $tools "ffmpeg-unzip") -Recurse -Filter ffprobe.exe | Select-Object -First 1).FullName (Join-Path $tools "ffprobe.exe")
Remove-Item -Recurse -Force (Join-Path $tools "ffmpeg-unzip")
Copy-Item -Force $ytDlp (Join-Path $tools "yt-dlp.exe")
# The AI video engine (ComfyUI) comes as a .7z, which Windows cannot unpack; the worker uses this.
Copy-Item -Force $sevenZip (Join-Path $tools "7zr.exe")

Expand-Archive -Force $whisperZip (Join-Path $tools "whisper")
Copy-Item -Force $whisperModel (Join-Path $tools "whisper\ggml-large-v3-turbo-q5_0.bin")

Expand-Archive -Force $chromeZip (Join-Path $tools "chrome-unzip")
Move-Item -Force (Join-Path $tools "chrome-unzip\chrome-headless-shell-win64") (Join-Path $tools "chrome")
Remove-Item -Recurse -Force (Join-Path $tools "chrome-unzip")

Expand-Archive -Force $pgZip (Join-Path $tools "postgres-unzip")
# The server needs none of these, and pgAdmin alone is hundreds of MB.
foreach ($extra in @("pgAdmin 4", "StackBuilder", "doc", "symbols")) {
  $extraPath = Join-Path $tools "postgres-unzip\pgsql\$extra"
  if (Test-Path $extraPath) { Remove-Item -Recurse -Force $extraPath }
}
Move-Item -Force (Join-Path $tools "postgres-unzip\pgsql") (Join-Path $tools "postgres")
Remove-Item -Recurse -Force (Join-Path $tools "postgres-unzip")

# whisper.cpp and the PostgreSQL binaries zip need the Visual C++ runtime, which a clean PC may not have. The build
# machine has it, so its DLLs go next to the programs that load them.
$vcRuntime = @("msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll", "vcomp140.dll")
foreach ($target in @((Join-Path $tools "whisper\Release"), (Join-Path $tools "postgres\bin"))) {
  foreach ($dll in $vcRuntime) {
    $source = Join-Path $env:SystemRoot "System32\$dll"
    if (-not (Test-Path $source)) { throw "$dll is missing on the build machine; install the Visual C++ 2015-2022 x64 runtime" }
    Copy-Item -Force $source $target
  }
}
Write-PhaseTime "tools"

# SeaweedFS is built from the pinned Go module, because its Windows release downloads are not a stable source.
# The build is kept with the downloads, named by its version, so later builds (and the CI tools cache) skip Go.
$weedExe = Join-Path $downloads "weed-$($manifest.seaweedfs.version).exe"
if (-not (Test-Path $weedExe)) {
  $seaweedZip = Get-Tool "SeaweedFS source" $manifest.seaweedfs "seaweedfs-src.zip"
  # It is unpacked under the temp folder: its deepest paths do not fit in the 260-character limit under the installer folder.
  $seaweedSrc = Join-Path ([System.IO.Path]::GetTempPath()) "localirs-seaweedfs"
  Expand-Archive -Force $seaweedZip $seaweedSrc
  $seaweedDir = (Get-ChildItem $seaweedSrc -Recurse -Filter go.mod | Sort-Object { $_.FullName.Length } | Select-Object -First 1).Directory.FullName
  Push-Location $seaweedDir
  # The FUSE mount in SeaweedFS needs WinFsp headers, which the build machine does not have, so build without cgo.
  $env:CGO_ENABLED = "0"
  go build -ldflags "-s -w" -o $weedExe ./weed
  if ($LASTEXITCODE -ne 0) { throw "go build of SeaweedFS failed" }
  Pop-Location
  Remove-Item -Recurse -Force $seaweedSrc
}
Copy-Item -Force $weedExe (Join-Path $tools "weed.exe")
Write-PhaseTime "SeaweedFS"

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
# The Next.js build cache from the last build goes back in place, so next build only redoes what changed.
if (Test-Path $nextCache) {
  New-Item -ItemType Directory -Force -Path (Join-Path $app ".next") | Out-Null
  Move-Item $nextCache (Join-Path $app ".next\cache")
}
# pnpm's default node_modules is junctions into .pnpm, which Inno Setup cannot pack into a working install and whose
# paths pass 260 characters. The hoisted layout is plain folders, like npm's.
Set-Content -Path (Join-Path $app ".npmrc") -Value "node-linker=hoisted" -Encoding ascii
Push-Location $app
$env:PATH = "$(Join-Path $tools 'node');$env:PATH"
# Prisma and next build read the app's settings when they load, so give them placeholders first. The real values
# are written on the user's PC by setup-localirs.ps1.
$placeholders = @{
  DATABASE_URL = "postgresql://build:build@127.0.0.1:5432/build"
  S3_ENDPOINT = "http://127.0.0.1:9000"; S3_BUCKET = "build"; S3_ACCESS_KEY = "build"; S3_SECRET_KEY = "build-secret"
  TOKEN_ENC_KEY = [Convert]::ToBase64String((1..32 | ForEach-Object { [byte]$_ }))
  IG_REDIRECT_URI = "http://localhost:3000/api/ig/callback"
  APP_URL = "http://localhost:3000"
}
foreach ($key in $placeholders.Keys) { Set-Item -Path "Env:$key" -Value $placeholders[$key] }
# pnpm prune has no --store-dir option, so both commands get the store from the environment.
$env:npm_config_store_dir = $pnpmStore
corepack enable
pnpm install --frozen-lockfile
if ($LASTEXITCODE -ne 0) { throw "pnpm install failed" }
Write-PhaseTime "app install"
pnpm exec prisma generate
if ($LASTEXITCODE -ne 0) { throw "prisma generate failed" }
pnpm build
if ($LASTEXITCODE -ne 0) { throw "pnpm build failed" }
# The build cache is only for the next build, so it moves out of the payload.
Move-Item (Join-Path $app ".next\cache") $nextCache
Write-PhaseTime "prisma+next build"
# The installed app needs only the dependencies in package.json's dependencies; the dev tools stay out of the installer.
pnpm prune --prod
if ($LASTEXITCODE -ne 0) { throw "pnpm prune failed" }
Pop-Location
Write-PhaseTime "prune"

# Localirs.exe, the tray launcher, built with the C# compiler that ships with .NET Framework 4 (in every Windows).
$csc = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path $csc)) { throw "The .NET Framework 4 C# compiler is missing: $csc" }
$launcher = Join-Path $PSScriptRoot "launcher"
& $csc /nologo /target:winexe /optimize+ "/win32icon:$(Join-Path $launcher 'localirs.ico')" `
  /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Core.dll `
  "/out:$(Join-Path $payload 'Localirs.exe')" (Join-Path $launcher "Localirs.cs")
if ($LASTEXITCODE -ne 0) { throw "Building Localirs.exe failed" }
Write-PhaseTime "launcher"

& "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" (Join-Path $PSScriptRoot "localirs.iss")
if ($LASTEXITCODE -ne 0) { throw "Inno Setup failed" }
Write-PhaseTime "Inno"
Write-Host "Built installer\Output\Localirs-Setup.exe"
