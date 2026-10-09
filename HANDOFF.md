# Handoff: Multi-account Instagram Reels Scheduler

Written: 2026-10-09. This is a handoff and loop plan for an AI coding agent that is starting from scratch.
Everything below comes from three research passes on Meta's docs, run in the session that wrote this file.
**This project is not part of `ev-sim`** (that repo is a Roblox game). Build it in a new, empty repository.

---

## 1. Goal

Build a web app that lets an operator connect several Instagram Business or Creator accounts, upload videos,
schedule them as Reels, and have them published automatically through **Meta's official Instagram API**.
It records each attempt, alerts on failures, and pulls basic insights.

**Done means** every milestone in section 8 is checked off and its acceptance check passes against
a real test Instagram account.

## 2. Hard rules (non-negotiable)

1. **Official API only.** Use "Instagram API with Instagram Login" on `graph.instagram.com`.
   - Do not use instagrapi, private endpoints, Selenium, Puppeteer, emulators, or stored Instagram passwords.
   - These break Instagram's Terms of Use and get accounts disabled.
2. **Business and Creator accounts only.** Personal accounts can't publish through any API.
3. **No engagement automation.** Never auto-like, auto-follow or auto-comment, and never create accounts.
4. **One path per job, no fallbacks.** If a precondition fails, throw a clear error and record it; don't silently
   try another method. (User preference: fail fast, simple beats complex, surgical changes.)
5. **Never hard-code the daily publish limit.** Meta's docs say both 50 and 100 posts per 24 h.
   Read the live value from `content_publishing_limit` before each publish.
6. **Secrets.**
   - Tokens are encrypted at rest and never sent to the browser.
   - The app secret lives only in env vars.
   - Never commit `.env`.

## 3. Fixed technical decisions

The previous session made these choices. Don't re-litigate them; just build.

| Concern | Choice |
|---|---|
| Language | TypeScript (strict) everywhere |
| Web + API | Next.js (App Router), route handlers for the API |
| DB | Postgres + Prisma |
| Queue | Redis + BullMQ (delayed jobs), one separate worker process |
| Storage | S3-compatible bucket (Cloudflare R2 or AWS S3), with `raw/` and `reels/` prefixes |
| Transcode | ffmpeg in the worker container |
| Video delivery to Meta | `video_url` = presigned GET URL valid ≥ 2 h. **Don't use resumable upload**: the docs say it may require Facebook Login. |
| Auth for operators | Auth.js (email magic link) |
| Token encryption | AES-256-GCM. The key comes from the `TOKEN_ENC_KEY` env var (32 bytes, base64). |
| Tests | Vitest for unit tests. Mock the Meta HTTP calls in unit tests and use a real test account for the e2e check. |
| Local dev | `docker compose` with postgres, redis, and minio (S3-compatible) |

## 4. Meta API reference (verified 2026-10-09, Graph API v26.0)

Put the version in one constant: `META_API_VERSION = "v26.0"`.

### 4.1 Meta app setup (manual, done by a human)
- Create a Meta app at developers.facebook.com and add the **Instagram** product → "API setup with Instagram login".
- Add the redirect URI, the Deauthorize callback URL, and the Data Deletion callback URL.
- Add test Instagram accounts as **Instagram testers** (Standard Access only covers people with a role on the app).
- Serving other people's accounts needs **App Review + Advanced Access + Business Verification**.
  App Review takes days to weeks.
- Env vars: `IG_APP_ID`, `IG_APP_SECRET`, `IG_REDIRECT_URI`.

### 4.2 OAuth (Business Login for Instagram)
```
GET  https://www.instagram.com/oauth/authorize
     ?client_id=IG_APP_ID&redirect_uri=...&response_type=code
     &scope=instagram_business_basic,instagram_business_content_publish,instagram_business_manage_insights
     &state=<csrf>
POST https://api.instagram.com/oauth/access_token
     (form) client_id, client_secret, grant_type=authorization_code, redirect_uri, code
     → { access_token (short-lived, 1 h), user_id }
GET  https://graph.instagram.com/access_token
     ?grant_type=ig_exchange_token&client_secret=IG_APP_SECRET&access_token=<short>
     → { access_token (long-lived), token_type, expires_in: 5184000 }   # 60 days
GET  https://graph.instagram.com/me?fields=user_id,username,account_type
```
- The authorization code can be used only once and expires after 1 h. Verify `state`.

### 4.3 Token refresh
```
GET https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=<long>
```
- A token can only be refreshed once it is ≥ 24 h old and still unexpired. Each refresh gives another 60 days.
- Run a daily cron that refreshes tokens expiring within 10 days.
- A token that has already expired can't be refreshed: set the account to `reauth_required`.
- API error code **190** (invalid token) → `reauth_required`.

### 4.4 Publish a Reel (three steps)
```
POST https://graph.instagram.com/v26.0/{ig_user_id}/media
     media_type=REELS, video_url=<presigned>, caption, share_to_feed=true|false,
     cover_url=<jpeg presigned> (optional; overrides thumb_offset)
     → { id: <container_id> }
GET  https://graph.instagram.com/v26.0/{container_id}?fields=status_code
     status_code ∈ IN_PROGRESS | FINISHED | ERROR | EXPIRED | PUBLISHED
POST https://graph.instagram.com/v26.0/{ig_user_id}/media_publish
     creation_id=<container_id>
     → { id: <ig_media_id> }
GET  https://graph.instagram.com/v26.0/{ig_media_id}?fields=permalink,media_product_type
```
- Auth: `Authorization: Bearer <token>` header.
- Poll status **once per minute, for at most 5 minutes**. If it is still `IN_PROGRESS` after that, fail the step and retry the job later.
- Containers expire **24 h** after creation. Each account can create at most **400 containers per rolling 24 h**.
- Caption: ≤ 2,200 chars, ≤ 30 hashtags, ≤ 20 @-mentions. Validate these when a post is scheduled.
- A published Reel shows `media_type=VIDEO`; check `media_product_type=REELS` to confirm it's a Reel.

### 4.5 Limits
```
GET https://graph.instagram.com/v26.0/{ig_user_id}/content_publishing_limit?fields=quota_usage,config
    → { data: [{ quota_usage, config: { quota_total, quota_duration } }] }
```
- If `quota_usage >= quota_total`, don't publish. Reschedule for later and record why.
- Call rate is limited by Business Use Case rate limiting: 4800 × the account's impressions per rolling 24 h.
  - Read the `X-Business-Use-Case-Usage` response header.
  - If any percentage is ≥ 80, pause that account's queue for the `estimated_time_to_regain_access` it reports.

### 4.6 Reels video specs (validate with ffprobe before scheduling)
- Container: MP4 or MOV, moov atom at the front (`+faststart`), no edit lists.
- Video: H.264 or HEVC, progressive, closed GOP, 4:2:0.
- Frame rate: 23–60 fps.
- Width: ≤ 1920 px. Aspect ratio: 9:16 recommended.
- Bitrate: VBR, ≤ 25 Mbps.
- Audio: AAC, ≤ 48 kHz, mono or stereo, 128 kbps.
- Duration: 3 s to 15 min. File size: ≤ 300 MB.
- Cover image: JPEG, ≤ 8 MB, 9:16.

Transcode every upload with this exact command, so publishing has one code path:
```
ffmpeg -i in -vf "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,fps=30,format=yuv420p" \
  -c:v libx264 -profile:v high -preset medium -crf 20 -maxrate 8M -bufsize 16M -g 60 -keyint_min 60 -sc_threshold 0 \
  -c:a aac -b:a 128k -ar 48000 -ac 2 -movflags +faststart out.mp4
```
Then run ffprobe on the output and assert the specs. If the input has no audio stream, fail the media with
the error "no audio stream" rather than inventing silence. Ask the user if they want silence added.

### 4.7 Insights
```
GET https://graph.instagram.com/v26.0/{ig_media_id}/insights?metric=views,reach,likes,comments,shares,saved,total_interactions
```
- Pull insights 1 h, 24 h and 7 d after publishing.
- `plays` and `impressions` are deprecated; use `views`.

### 4.8 Required Meta callbacks
- **Deauthorize** `POST /api/meta/deauthorize`: receives a `signed_request`.
  - Verify it with HMAC-SHA256 using `IG_APP_SECRET`.
  - Set the account to `revoked` and cancel its jobs.
- **Data deletion** `POST /api/meta/data-deletion`: also receives a verified `signed_request`.
  - Purge the user's data.
  - Respond with `{ url: <status page>, confirmation_code }`.
- Publish a **privacy policy** page at `/privacy`. App Review needs it.

## 5. Architecture

```
Browser (Next.js UI) ──OAuth──► instagram.com ──code──► /api/ig/callback
   │ presigned PUT                                        │
   ▼                                                      ▼
bucket raw/ ──► [worker: transcode job] ──► bucket reels/   Postgres
                                                          ▲
[BullMQ delayed jobs on Redis] ──► [worker: publish job] ─┘──► graph.instagram.com
[repeatable jobs: token-refresh daily, insights hourly]
```

Processes:
- `web`: Next.js
- `worker`: a single Node process running BullMQ workers for the queues `transcode`, `publish`, `refresh`, `insights`

## 6. Data model (Prisma)

```
User        id, email, createdAt
IgAccount   id, ownerId→User, igUserId (unique), username, accountType,
            timezone, status: active|reauth_required|revoked, pausedUntil?, createdAt
IgToken     accountId (unique)→IgAccount, ciphertext, iv, authTag, expiresAt, lastRefreshedAt
Media       id, accountId, rawKey, reelKey?, coverKey?, durationMs?, width?, height?,
            status: uploaded|transcoding|ready|failed, error?
Post        id, accountId, mediaId, caption, shareToFeed, scheduledAt,
            status: scheduled|container_created|published|failed|canceled,
            containerId?, igMediaId?, permalink?, attempts, lastError?
PublishAttempt id, postId, step: create|poll|publish|quota, httpStatus?, errorCode?, response Json, at
Insight     id, postId, metric, value, fetchedAt
AuditLog    id, actorId?, action, targetType, targetId, data Json, at
```

## 7. Publish job: exact behavior

Each post gets one BullMQ job: `jobId = post.id`, `delay = scheduledAt - now - 45min`. If that is negative, run it now.

1. Load the post and its account. Throw if the account is not `active`, or if `pausedUntil` is in the future.
2. **Idempotency.** If `post.igMediaId` is set, stop: the post is already published.
   If `post.containerId` is set, GET its status:
   - `PUBLISHED`: find the media id, save it, and stop.
   - `EXPIRED`: clear `containerId` and go to step 3.
   - Otherwise: go to step 4.
3. Create the container (§4.4) with a new presigned `video_url`. Save `containerId` and set the status to `container_created`.
4. Poll `status_code` once a minute for up to 5 minutes until `FINISHED`.
   - `ERROR` → fail the post. This is a non-retryable error.
5. Wait until `scheduledAt`, using a delayed re-enqueue rather than a sleep. Then check the quota (§4.5).
6. Call `media_publish`. Save `igMediaId`, fetch the `permalink`, and set the status to `published`.
7. Log every HTTP call to `PublishAttempt`.

**Retries.**
- Retryable: 5xx responses, network errors, and rate-limit codes 4, 17, 32 and 613. Retry these with exponential backoff and jitter, up to 5 attempts.
- Everything else, other 4xx responses and code 190 included, fails immediately and sends an alert.

**Concurrency.** Each account publishes at most one post at a time. Enforce this with a Redis lock keyed by `accountId`.

## 8. Milestones (the loop works through these in order)

Each milestone ends with:
- its acceptance check passing,
- `pnpm typecheck && pnpm lint && pnpm test` green,
- one commit, with a message of the form `feat(mN): ...`.

- [ ] **M1 Scaffold.**
  - Set up Next.js + TS strict, Prisma, docker-compose (postgres, redis, minio), Vitest, ESLint, and `.env.example`.
  - *Accept:* `docker compose up` works, `pnpm dev` serves `/`, `pnpm test` runs one passing test.
- [ ] **M2 Operator auth + schema.**
  - Add Auth.js email login and the full Prisma schema (§6) with a migration.
  - *Accept:* you can log in, and the migration applies cleanly to an empty DB.
- [ ] **M3 Token crypto.**
  - Add `encryptToken` and `decryptToken` (AES-256-GCM).
  - *Accept:* round-trip, tamper-detection, and wrong-key unit tests all pass.
- [ ] **M4 Instagram OAuth connect.**
  - Build the routes `/api/ig/connect` and `/api/ig/callback` per §4.2.
  - Store the long-lived token encrypted and reject accounts that aren't Business or Creator.
  - *Accept:* unit tests with mocked Meta pass, and a manual connect of a test account shows it in the account list.
- [ ] **M5 Meta callbacks + privacy page.**
  - Add signed_request verification, the deauthorize and data-deletion routes, and `/privacy`.
  - *Accept:* the tests cover a valid signature, a bad signature, and the revoke and purge effects.
- [ ] **M6 Token refresh job.**
  - Add a daily repeatable job per §4.3.
  - *Accept:* tests cover refreshed, too-young, expired→`reauth_required`, and error 190.
- [ ] **M7 Upload + transcode.**
  - Add the presigned PUT to `raw/`, then the transcode job (§4.6) writing to `reels/` with a cover frame.
  - Run ffprobe validation on the output.
  - *Accept:* an integration test transcodes a fixture clip, and the ffprobe assertions pass.
- [ ] **M8 Post editor + scheduling.**
  - Build the UI to pick an account, pick ready media, write the caption, and pick a time. Validate captions per §4.4.
  - Enqueue the delayed job. Canceling a post removes its job.
  - *Accept:* tests show caption limits are enforced and the job is created and removed.
- [ ] **M9 Publish job.**
  - Implement §7 exactly: quota check, BUC header pause, per-account lock, and the retry classes.
  - *Accept:* the unit tests cover every branch of §7. **E2E:** a real test account publishes one Reel, and the permalink is stored.
- [ ] **M10 Dashboard + alerts.**
  - Build the calendar or list view, per-account status, and a failed-posts list with a retry button.
  - Send a failure email when a post fails, a token is within 7 days of expiry, or an account needs re-auth.
  - *Accept:* the UI shows the state correctly, and alert tests pass.
- [ ] **M11 Insights.**
  - Schedule pulls at 1 h, 24 h and 7 d (§4.7) and show the metrics on the post page.
  - *Accept:* tests pass with mocked Meta, and the e2e run shows views for the M9 post.
- [ ] **M12 App Review readiness.**
  - Add `docs/APP_REVIEW.md`: permission justifications, the screencast script, the privacy URL, and the test credentials checklist.
  - Add `docs/DEPLOY.md`.
  - *Accept:* a human can follow both documents.

## 9. Open questions for the human (ask, don't guess)
1. Will the app serve only your own accounts (Standard Access is enough), or paying clients
   (that needs App Review, Business Verification and a GDPR data processing agreement per client)?
2. R2 or S3, and where should it deploy (Fly, Render or ECS)?
3. Which email provider should send the alerts?
4. Do you need multiple operators or teams with an approval step before publishing? This isn't in scope now.
5. Before building, compare with self-hosted **Postiz** (AGPL, already supports Instagram).
   If this is only for your own accounts, Postiz may be enough.

## 10. Compliance items the code must support
- An AI-content toggle on each post. Realistic AI video or audio must be disclosed, and the EU AI Act
  Art. 50 duties apply from 2026-08-02.
  - The API has a parameter for this (`is_ai_generated`), but it rests on a single docs page. Verify it before relying on it.
- A sponsorship-disclosure reminder in the caption.
  - The API has no confirmed paid-partnership flag, so treat that tag as a manual in-app step.
- A warning when the same media is scheduled to more than one account, because the originality rules down-rank duplicate content.
- Hard-delete everything when a user requests data deletion. Keep only the data the app needs.

---

## 11. Autonomous loop runbook (`/loop-start sequential --mode safe`)

**Pattern:** `sequential`. Each iteration completes exactly one unchecked milestone from §8, in order.
**Why:** this is a greenfield build whose milestones depend on each other, so they can't run in parallel.
**Mode:** `safe`. Every iteration has to pass all the quality gates before it can commit.

### Model tier strategy
- **Default model** for building milestones.
- **Strongest model** for M9 (publish job) and any milestone that has failed twice.
- **Cheaper model** for M12 (the docs).

### Preconditions (check before iteration 1)
1. A new empty repo is created and cloned, and this file is copied into it as `HANDOFF.md`.
2. Node 20+, pnpm, Docker and ffmpeg are installed.
3. `ECC_HOOK_PROFILE` is not set to `disabled`. It is unset in the writer's environment, which means the default profile is on.
4. Before M1, the "tests pass" gate is trivially true (no code). From M1 on, every iteration starts with
   `pnpm typecheck && pnpm lint && pnpm test`. If that baseline is red, the iteration's only job is to fix it.

### Iteration contract (give it to the agent verbatim each time)
```
Read HANDOFF.md. Find the first unchecked milestone in §8.
1. Run `pnpm typecheck && pnpm lint && pnpm test` (skip before M1). If red, fix that only, commit, stop.
2. Implement only that milestone, following §2–§7 exactly. No extra features, no fallbacks.
3. Run its acceptance check plus typecheck/lint/test. If anything fails, fix and re-run (max 3 tries).
4. On green: tick the box in HANDOFF.md, commit "feat(mN): <summary>", push.
5. Append one line to LOOP_LOG.md: date, milestone, result, commit sha, notes.
6. If blocked on a human item (Meta app, test account, credentials, §9 question), write it to
   BLOCKED.md and stop without ticking the box.
```

### Stop conditions (the loop must end on any of these)
- All §8 boxes are checked → **success**.
- `BLOCKED.md` is non-empty → **wait for the human**.
- The same milestone fails 3 iterations in a row → **stop and escalate**.
- 30 total iterations → **hard cap**.
- Any step would break a §2 rule → **stop immediately**.

### Start command
```bash
cd ~/ig-reels-scheduler   # the new repo
for i in $(seq 1 30); do
  [ -s BLOCKED.md ] && { echo "Blocked:"; cat BLOCKED.md; break; }
  grep -q '^- \[ \]' HANDOFF.md || { echo "All milestones done"; break; }
  claude -p "$(sed -n '/^### Iteration contract/,/^```$/p' HANDOFF.md | sed '1,2d;$d')" \
    --permission-mode acceptEdits || break
  [ "$(tail -n 3 LOOP_LOG.md 2>/dev/null | grep -c FAILED)" = 3 ] && { echo "3 failures in a row, escalate"; break; }
done
```

### Monitor
- `tail -f LOOP_LOG.md` and `git log --oneline`
- `/loop-status` (ECC) to see progress and failure signals
- `cat BLOCKED.md` when the loop stops

### Checkpoints for the human
- **After M4:** connect a real test account yourself.
- **After M9:** check that the test Reel appears on Instagram.
- **Before M12:** answer the §9 questions.
