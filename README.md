# Localirs

One app for two jobs. It cuts long videos into vertical 1080×1920 clips, and it schedules Reels to
Instagram accounts through the Meta Graph API.

## What it does

- **Clips.** Upload a video or paste a link. Pick the clip length, how many clips to make, and optionally
  burn in captions with one of three styles. Each clip ends on a quiet moment. You can rename, copy and
  delete projects and clips, and edit each clip's title and description.
- **Upload sheet.** Select clips and download a text sheet with each clip's title and description, to paste
  into YouTube Studio by hand.
- **Scheduling.** Schedule a clip to a connected Instagram account. The post publishes 45 minutes before its
  time, with retries, a per-account lock and Meta's rate-limit pauses.
- **Dashboard.** Scheduled and failed posts, with cancel and retry.

## Stack

Next.js 16 (App Router), Prisma 7 on Postgres 16, Auth.js with email sign-in, pg-boss for background jobs
(render, publish, insights, token refresh), S3 or MinIO for files, ffmpeg for video, Remotion and whisper.cpp
for captions.

## Run it locally

Needs Node 22, pnpm 10.28, Postgres 16, ffmpeg and ffprobe on your PATH, and an S3-compatible store. The
included `docker-compose.yml` starts Postgres and MinIO.

    cp .env.example .env        # fill in the values, see docs/DEPLOY.md section 3
    docker compose up -d        # Postgres and MinIO
    pnpm install
    pnpm exec prisma generate   # needs .env, so it comes after copying it
    pnpm exec prisma migrate deploy
    pnpm dev                    # web app on http://localhost:3000
    pnpm worker                 # in a second terminal: background jobs

Create the storage bucket once: open the MinIO console at http://localhost:9001 (user `minio`,
password `minio12345`), create a bucket named `ig-reels`. Sign-in emails need `RESEND_API_KEY` and
`EMAIL_FROM` in `.env`.

Optional, for links and captions: `yt-dlp` on the worker's PATH for clips made from a link, and
`CHROME_PATH`, `WHISPER_BIN` and `WHISPER_MODEL` for captions.

## Tests and checks

    CHROME_PATH=/path/to/chrome pnpm test   # CHROME_PATH is needed by the caption render test
    pnpm typecheck
    pnpm lint
    pnpm build

## Deploying and installing

- `docs/DEPLOY.md` covers a hosted deployment: web and worker services, Postgres, storage, environment
  variables, the Meta app settings, and a one-time requeue for posts scheduled before the job queue moved.
- `installer/README.md` covers the Windows installer kit. It has not been run on Windows yet.
- `docs/APP_REVIEW.md` lists what Meta's app review needs.
- `HANDOFF.md` is the original specification.
