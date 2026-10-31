# Localirs Windows installer

One `Localirs-Setup.exe` that installs the app with everything it needs on the same PC: Node, ffmpeg,
yt-dlp, whisper.cpp with its speech and voice-detection models, a headless Chrome for captions, the Kokoro voice model for slideshows, PostgreSQL 16, SeaweedFS for file storage, and 7zr.exe (7-Zip)
to unpack the AI video engine, which Settings downloads into `data\ai` when asked (the slideshow engines go into
`data\slideshow` the same way). Nothing else
needs installing by hand. The only things you type are a Resend API key and a sender address for sign-in email.

## Build it (on a Windows PC)

1. Install [Inno Setup 6](https://jrsoftware.org/isdl.php) and [Git for Windows](https://git-scm.com).
2. Install Node 22, pnpm 10.28.0 (`corepack enable`), and Go 1.26.6 on the build PC. Go compiles SeaweedFS.
3. In PowerShell, from the repository root:

       powershell -ExecutionPolicy Bypass -File installer\build-installer.ps1 -Build 0

   `-Build` is the build number the installer records. CI passes its run number; a local build passes 0, so the
   installed app offers every published build as an update.
   The first run downloads the tools and prints their SHA-256 hashes. Copy those hashes into
   `installer\tools.json` (the `sha256` fields), so later builds check every download.
4. The installer is written to `installer\Output\Localirs-Setup.exe`.

## Use it

1. Run `Localirs-Setup.exe`. It copies the app to `%LOCALAPPDATA%\Localirs`.
2. Setup optionally asks where to email you when a post fails (your email, a Resend API key and a sender), then
   starts the database and file storage and writes the app settings.
3. Open Localirs from its desktop or Start menu icon. It starts with no console window, shows a tray icon, and
   opens in its own window (Microsoft Edge app mode). There is no sign-in. Quit it from the tray icon.
4. To connect Instagram, you still need a Meta app (see `docs/APP_REVIEW.md`). Put its ID and secret in
   `%LOCALAPPDATA%\Localirs\app\.env`, then restart Localirs.

## Updating

Localirs checks GitHub for a newer build once it has started, and whenever you choose **Check for updates** in its
tray menu. Each CI build is published as a release `localirs-build-<n>`; the installer writes its own `<n>` to
`%LOCALAPPDATA%\Localirs\version.txt`. When the newest release has a higher number, a tray notification says so and
**Install update** in the tray menu turns on. Installing:

1. asks you to confirm (scheduled Reels are not published while it updates, which takes a minute or two),
2. downloads `Localirs-Setup.exe` to your temp folder, with the progress on the tray icon's tooltip, and checks that
   the whole file arrived (its size matches what GitHub sent; GitHub publishes no hash for release files, so nothing
   more is checked),
3. quits Localirs and runs the installer silently over the same folder. Setup stops the services, keeps `data` and
   your settings (the failure-email page is skipped, which keeps what was saved), and opens Localirs again.

A failed check when Localirs starts says nothing; **Check for updates** shows the error. You can still update by
hand: download `Localirs-Setup.exe` from the latest release and run it over the install.

## What is and is not verified

- Verified here (Linux sandbox): the settings the setup writes, the database role and database creation
  (run twice), the clip pipeline, the upload and render flow in a browser, and scheduling a clip to an account.
  Against SeaweedFS (the same source the installer builds): bucket creation (run twice), browser uploads with
  their CORS preflight, copy, download and delete, through the app's own storage functions.
- Not verified: anything Windows-specific. `build-installer.ps1`, `setup-localirs.ps1`, `start-localirs.ps1`
  and `localirs.iss` have not been run. The download URLs in `tools.json` are not all checked. The whisper.cpp
  zip layout (`Release\whisper-cli.exe`) was checked against the pinned zip.
- The hashes in `tools.json` are empty until the first build fills them in.
- Captions need a Whisper model, which the build downloads from Hugging Face. Links need `yt-dlp`, which the build
  downloads from GitHub.
