# Localirs Windows installer

One `Localirs-Setup.exe` that installs the app with everything it needs on the same PC: Node, ffmpeg,
yt-dlp, whisper.cpp with its model, a headless Chrome for captions, PostgreSQL 16 and MinIO. Nothing else
needs installing by hand. The only things you type are a Resend API key and a sender address for sign-in email.

## Build it (on a Windows PC)

1. Install [Inno Setup 6](https://jrsoftware.org/isdl.php) and [Git for Windows](https://git-scm.com).
2. Install Node 22 and pnpm 10.28.0 (`corepack enable`) on the build PC.
3. In PowerShell, from the repository root:

       powershell -ExecutionPolicy Bypass -File installer\build-installer.ps1

   The first run downloads the tools and prints their SHA-256 hashes. Copy those hashes into
   `installer\tools.json` (the `sha256` fields), so later builds check every download.
4. The installer is written to `installer\Output\Localirs-Setup.exe`.

## Use it

1. Run `Localirs-Setup.exe`. It copies the app to `%LOCALAPPDATA%\Localirs`.
2. The setup window asks for your Resend API key and sender address, then starts the database and file storage
   and writes the app settings.
3. Start Localirs from the Start menu. It opens http://localhost:3000/clips. Sign in with your email.
4. To connect Instagram, you still need a Meta app (see `docs/APP_REVIEW.md`). Put its ID and secret in
   `%LOCALAPPDATA%\Localirs\app\.env`, then restart Localirs.

## What is and is not verified

- Verified here (Linux sandbox): the settings the setup writes, the database role and database creation
  (run twice), the clip pipeline, the upload and render flow in a browser, and scheduling a clip to an account.
- Not verified: anything Windows-specific. `build-installer.ps1`, `setup-localirs.ps1`, `start-localirs.ps1`
  and `localirs.iss` have not been run. The download URLs in `tools.json` are not all checked. The whisper.cpp
  zip layout and the `whisper-cli.exe` name in particular need a check on a real build.
- The hashes in `tools.json` are empty until the first build fills them in.
- Captions need a Whisper model, which the build downloads from Hugging Face. Links need `yt-dlp`, which the build
  downloads from GitHub.
