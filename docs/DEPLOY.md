# Deploy guide

This guide deploys the scheduler to Render. It needs four services:

| Service | What it is | Notes |
| --- | --- | --- |
| Web | Next.js app (`pnpm start`) | Serves the operator UI and the Meta callbacks. |
| Worker | Background jobs (`pnpm worker`) | Needs ffmpeg, so deploy it from `Dockerfile.worker`. |
| Postgres | Database | Managed Postgres 16. |
| Redis | Queues and account locks | Managed Redis 7. |

Storage is Cloudflare R2, which speaks the S3 API. Create one bucket, for example `ig-reels`.

## 1. Before you start

- Create the Meta app and add its redirect and callback URLs (handoff section 4.1). Note the app ID and secret.
- Create a Resend account and an API key. Verify a sending domain, and note the sender address.
- Create an R2 bucket and an access key pair with read and write rights on it.
- Generate two secrets locally:
  - `openssl rand -base64 32` for `AUTH_SECRET`
  - `openssl rand -base64 32` for `TOKEN_ENC_KEY`. It must decode to exactly 32 bytes, so do not change its length.

Keep `TOKEN_ENC_KEY` safe. If it is lost, every stored Instagram token becomes unreadable.

## 2. Create the database and Redis

1. Create a Postgres 16 instance. Copy its internal connection string into `DATABASE_URL`.
2. Create a Redis 7 instance. Copy its internal URL into `REDIS_URL`.

## 3. Set the environment variables

Set these on both the web and the worker service, unless noted.

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | Postgres connection string |
| `REDIS_URL` | Redis URL |
| `S3_ENDPOINT` | `https://<account-id>.r2.cloudflarestorage.com` |
| `S3_BUCKET` | `ig-reels` (or your bucket name) |
| `S3_ACCESS_KEY` | R2 access key ID |
| `S3_SECRET_KEY` | R2 secret access key |
| `TOKEN_ENC_KEY` | 32-byte base64 key from section 1 |
| `AUTH_SECRET` | Random secret from section 1 (web only) |
| `RESEND_API_KEY` | Resend API key |
| `EMAIL_FROM` | Sender address, for example `Scheduler <alerts@your-domain.com>` |
| `IG_APP_ID` | Meta app ID |
| `IG_APP_SECRET` | Meta app secret (keep it out of logs and screenshots) |
| `IG_REDIRECT_URI` | `https://<your-domain>/api/ig/callback` |
| `APP_URL` | `https://<your-domain>` |

Never commit `.env`. The repository's `.gitignore` already excludes it.

## 4. Deploy the web service

- Build command: `pnpm install --frozen-lockfile && pnpm build`
- Start command: `pnpm start`
- Node version: 22 (the repo's `engines` field requires 20 or newer)

Before the first start, run the database migrations once from a Render shell or a local machine with the production `DATABASE_URL`:

```bash
pnpm prisma migrate deploy
```

Open `https://<your-domain>/login` and check that it loads. Then open `https://<your-domain>/privacy` and check that the page is no longer the draft.

## 5. Deploy the worker

Create a Background Worker service from the same repository, using Docker with `Dockerfile.worker` as the build file. It has ffmpeg installed and runs:

```bash
pnpm worker
```

The worker starts with these scheduled jobs:

- Token refresh, daily at 03:00 UTC
- Owner alert emails, daily at 08:00 UTC

Check the worker logs. A healthy start prints `worker running: token refresh at 0 3 * * * UTC, media and publishing enabled`.

## 6. Connect your domain and the Meta app

1. Point your domain at the web service and let Render issue the certificate.
2. In the Meta app, set the OAuth redirect URI to `https://<your-domain>/api/ig/callback`. Set the deauthorize callback to `https://<your-domain>/api/meta/deauthorize`, and the data deletion callback to `https://<your-domain>/api/meta/data-deletion`.
3. Add your test accounts as Instagram testers.

## 7. Smoke test

Run these in order and fix anything that fails before you move on.

1. Sign in with your email from the sign-in link.
2. Connect a test Business or Creator account on the Accounts page.
3. Upload a short video and wait for "ready" on the Dashboard.
4. Schedule the video for about 50 minutes ahead. Check that its job appears in Redis and runs at the scheduled time.
5. After publishing, open the post page and check the permalink. Wait for the 1-hour insights.

## 8. Operations

- **Logs:** check the web and worker logs in Render. Failed posts show their error on the Dashboard as well.
- **Token expiry:** the daily job refreshes tokens within 10 days of expiry. Accounts whose token has expired or was revoked are marked "needs to be reconnected", and the owner gets an email.
- **Rotating secrets:** rotating `AUTH_SECRET` signs everyone out. Rotating `TOKEN_ENC_KEY` makes stored tokens unreadable, so do not rotate it without re-encrypting every token first.
- **Backups:** back up Postgres daily, and keep the `TOKEN_ENC_KEY` in a password manager.
