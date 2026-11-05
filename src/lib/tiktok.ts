import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Settings } from "./settings";

// user.info.basic for the account's name, video.upload to send drafts to its inbox.
export const TIKTOK_SCOPES = ["user.info.basic", "video.upload"];
export const TIKTOK_CALLBACK_PATH = "/api/tiktok/callback";
// Holds "<state>.<PKCE verifier>" between Connect and TikTok's redirect back.
export const TIKTOK_OAUTH_COOKIE = "tt_oauth";
const AUTHORIZE_URL = "https://www.tiktok.com/v2/auth/authorize/";
export const TIKTOK_API_URL = "https://open.tiktokapis.com";
// TikTok's Media Transfer Guide: chunks of 5 MB to 64 MB, uploaded in order; the last one takes the remaining bytes and
// may be up to 128 MB; a video under 5 MB is one chunk of its whole size; 1 to 1000 chunks; total_chunk_count is the
// size divided by chunk_size, rounded down. 10,000,000 bytes is over 5 MB however MB is counted.
export const TIKTOK_CHUNK_BYTES = 10_000_000;
const MAX_CHUNKS = 1000;
const MAX_CHUNK_RETRIES = 5;
const POLL_INTERVAL_MS = 5_000;
const MAX_POLLS = 60;

// What a TikTok post shows once TikTok has put the draft in the inbox.
export const TIKTOK_SENT = "Sent to TikTok drafts";
export const TIKTOK_SENT_LONG = "Sent to TikTok drafts — finish it in the TikTok app.";

export type TikTokApp = { clientKey: string; clientSecret: string; redirectUri: string };

// Connecting TikTok needs the owner's TikTok developer app from /settings; the callback is on APP_URL. Null until all
// three are there.
export function tikTokAppConfig(
  settings: Pick<Settings, "tiktokClientKey" | "tiktokClientSecret">,
  appUrl: string | undefined,
): TikTokApp | null {
  if (!settings.tiktokClientKey || !settings.tiktokClientSecret || !appUrl) return null;
  return { clientKey: settings.tiktokClientKey, clientSecret: settings.tiktokClientSecret, redirectUri: tikTokRedirectUri(appUrl) };
}

export function tikTokRedirectUri(appUrl: string): string {
  return new URL(TIKTOK_CALLBACK_PATH, appUrl).toString();
}

// PKCE as TikTok's Login Kit does it: the challenge is the hex SHA-256 of the verifier, not base64url.
export function createTikTokPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString("base64url");
  return { verifier, challenge: tikTokPkceChallenge(verifier) };
}

export function tikTokPkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("hex");
}

export function createTikTokState(): string {
  return randomBytes(32).toString("base64url");
}

export function buildTikTokAuthorizeUrl({
  clientKey,
  redirectUri,
  state,
  codeChallenge,
}: Pick<TikTokApp, "clientKey" | "redirectUri"> & { state: string; codeChallenge: string }): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_key", clientKey);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", TIKTOK_SCOPES.join(","));
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

// The code from TikTok's redirect, once the state matches the one this browser was sent off with.
export function checkTikTokCallback({ params, expectedState }: { params: URLSearchParams; expectedState: string }): string {
  const error = params.get("error");
  if (error) {
    throw new Error(error === "access_denied" ? "TikTok login was canceled" : `TikTok returned ${params.get("error_description") ?? error}`);
  }
  const state = Buffer.from(params.get("state") ?? "");
  const expected = Buffer.from(expectedState);
  if (expected.length === 0 || state.length !== expected.length || !timingSafeEqual(state, expected)) {
    throw new Error("the login link expired or did not start here; connect again");
  }
  const code = params.get("code");
  if (!code) throw new Error("TikTok returned no code");
  return code;
}

export class TikTokApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

// TikTok no longer accepts the stored refresh token: the access was removed in the TikTok app, or a year has passed.
export class TikTokAuthError extends Error {}

// A chunk PUT TikTok answered with an error status (its upload host sends no JSON).
export class TikTokUploadError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// TikTok's processing ended in FAILED, with its fail_reason.
export class TikTokPublishFailed extends Error {
  constructor(readonly reason: string) {
    super(`TikTok could not take the video: ${reason}`);
  }
}

// TikTok is still processing after the polls: thrown so the job runs again and asks again.
export class TikTokStillProcessing extends Error {}

export type TikTokTokens = {
  accessToken: string;
  accessExpiresAt: Date;
  refreshToken: string;
  openId: string;
};

type TokenResponse = {
  access_token?: string;
  expires_in?: number;
  open_id?: string;
  refresh_token?: string;
  scope?: string;
  error?: string;
  error_description?: string;
};

async function postToken(body: URLSearchParams, now: Date, fetchFn: typeof fetch): Promise<{ tokens: TikTokTokens; scope: string }> {
  const response = await fetchFn(`${TIKTOK_API_URL}/v2/oauth/token/`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = (await response.json()) as TokenResponse;
  if (!response.ok || json.error) {
    const message = json.error_description || json.error || `TikTok token request failed with ${response.status}`;
    if (json.error === "invalid_grant") throw new TikTokAuthError(message);
    throw new TikTokApiError(response.status, json.error ?? "", message);
  }
  if (!json.access_token || !json.refresh_token || !json.open_id) throw new Error("TikTok returned no tokens");
  return {
    tokens: {
      accessToken: json.access_token,
      accessExpiresAt: new Date(now.getTime() + (json.expires_in ?? 0) * 1000),
      refreshToken: json.refresh_token,
      openId: json.open_id,
    },
    scope: json.scope ?? "",
  };
}

export async function exchangeTikTokCode({
  app,
  code,
  codeVerifier,
  now,
  fetchFn = fetch,
}: {
  app: TikTokApp;
  code: string;
  codeVerifier: string;
  now: Date;
  fetchFn?: typeof fetch;
}): Promise<TikTokTokens> {
  const { tokens, scope } = await postToken(
    new URLSearchParams({
      client_key: app.clientKey,
      client_secret: app.clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: app.redirectUri,
      code_verifier: codeVerifier,
    }),
    now,
    fetchFn,
  );
  // TikTok's consent screen lets each permission be unticked.
  const granted = scope.split(",");
  if (TIKTOK_SCOPES.some((wanted) => !granted.includes(wanted))) {
    throw new Error("TikTok did not grant every permission Localirs asks for. Connect again and allow all of them.");
  }
  return tokens;
}

// A new access token; TikTok may also send a new refresh token, which replaces the stored one.
export async function refreshTikTokTokens({
  app,
  refreshToken,
  now,
  fetchFn = fetch,
}: {
  app: Pick<TikTokApp, "clientKey" | "clientSecret">;
  refreshToken: string;
  now: Date;
  fetchFn?: typeof fetch;
}): Promise<TikTokTokens> {
  const { tokens } = await postToken(
    new URLSearchParams({
      client_key: app.clientKey,
      client_secret: app.clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
    now,
    fetchFn,
  );
  return tokens;
}

type Envelope<T> = { data?: T; error?: { code?: string; message?: string; log_id?: string } };

// The Content Posting and Display APIs answer with { data, error }; error.code is "ok" on success.
async function readEnvelope<T>(response: Response): Promise<T> {
  const text = await response.text();
  let body: Envelope<T>;
  try {
    body = JSON.parse(text) as Envelope<T>;
  } catch {
    throw new TikTokApiError(response.status, "", `TikTok returned HTTP ${response.status}`);
  }
  const code = body.error?.code ?? "";
  if (!response.ok || code !== "ok") {
    throw new TikTokApiError(response.status, code, body.error?.message || `TikTok request failed with ${response.status}`);
  }
  if (!body.data) throw new Error("TikTok returned no data");
  return body.data;
}

async function postJson<T>(path: string, accessToken: string, body: object, fetchFn: typeof fetch): Promise<T> {
  return readEnvelope<T>(
    await fetchFn(`${TIKTOK_API_URL}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify(body),
    }),
  );
}

export async function getTikTokUser({
  accessToken,
  fetchFn = fetch,
}: {
  accessToken: string;
  fetchFn?: typeof fetch;
}): Promise<{ openId: string; displayName: string }> {
  const data = await readEnvelope<{ user?: { open_id?: string; display_name?: string } }>(
    await fetchFn(`${TIKTOK_API_URL}/v2/user/info/?fields=open_id,display_name`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    }),
  );
  if (!data.user?.open_id) throw new Error("TikTok returned no account");
  return { openId: data.user.open_id, displayName: data.user.display_name || "TikTok account" };
}

export type ChunkPlan = { chunkSize: number; totalChunks: number };

// How a video of this size is cut, by the Media Transfer Guide's rules. The last chunk takes the bytes left over.
export function planChunks(size: number, chunkBytes = TIKTOK_CHUNK_BYTES): ChunkPlan {
  if (!Number.isInteger(size) || size <= 0) throw new Error("the video is empty");
  if (size <= chunkBytes) return { chunkSize: size, totalChunks: 1 };
  const totalChunks = Math.floor(size / chunkBytes);
  if (totalChunks > MAX_CHUNKS) throw new Error("the video is too large for TikTok");
  return { chunkSize: chunkBytes, totalChunks };
}

// Bytes start to end, inclusive, of chunk index.
export function chunkRange(plan: ChunkPlan, size: number, index: number): { start: number; end: number } {
  const start = index * plan.chunkSize;
  const end = index === plan.totalChunks - 1 ? size - 1 : start + plan.chunkSize - 1;
  return { start, end };
}

// Starts a draft upload to the account's inbox (the Upload flow: no caption, the person posts it in the TikTok app).
export async function initInboxUpload({
  accessToken,
  size,
  plan,
  fetchFn = fetch,
}: {
  accessToken: string;
  size: number;
  plan: ChunkPlan;
  fetchFn?: typeof fetch;
}): Promise<{ publishId: string; uploadUrl: string }> {
  const data = await postJson<{ publish_id?: string; upload_url?: string }>(
    "/v2/post/publish/inbox/video/init/",
    accessToken,
    { source_info: { source: "FILE_UPLOAD", video_size: size, chunk_size: plan.chunkSize, total_chunk_count: plan.totalChunks } },
    fetchFn,
  );
  if (!data.publish_id || !data.upload_url) throw new Error("TikTok started no upload");
  return { publishId: data.publish_id, uploadUrl: data.upload_url };
}

export type UploadSource = { size: number; read(start: number, end: number): Promise<Uint8Array> };

const retryableUpload = (err: unknown) => err instanceof TypeError || (err instanceof TikTokUploadError && err.status >= 500);

// PUTs the chunks from fromChunk on, in order. TikTok answers 206 while chunks are missing and 201 after the last one.
// A 5xx or a dropped connection sends the same chunk again after 1, 2, 4, 8 and 16 seconds.
export async function uploadChunks({
  uploadUrl,
  source,
  plan,
  fromChunk = 0,
  fetchFn = fetch,
  sleep,
}: {
  uploadUrl: string;
  source: UploadSource;
  plan: ChunkPlan;
  fromChunk?: number;
  fetchFn?: typeof fetch;
  sleep: (ms: number) => Promise<void>;
}) {
  for (let index = fromChunk; index < plan.totalChunks; index++) {
    const { start, end } = chunkRange(plan, source.size, index);
    const bytes = await source.read(start, end);
    const last = index === plan.totalChunks - 1;
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await fetchFn(uploadUrl, {
          method: "PUT",
          headers: {
            "Content-Type": "video/mp4",
            "Content-Length": String(bytes.byteLength),
            "Content-Range": `bytes ${start}-${end}/${source.size}`,
          },
          body: new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "video/mp4" }),
        });
        const expected = last ? 201 : 206;
        if (response.status !== expected) {
          throw new TikTokUploadError(response.status, `TikTok answered the upload of bytes ${start}-${end} with HTTP ${response.status}`);
        }
        break;
      } catch (err) {
        if (!retryableUpload(err) || attempt >= MAX_CHUNK_RETRIES - 1) throw err;
        await sleep(2 ** attempt * 1000);
      }
    }
  }
}

export type PublishStatus = { status: string; failReason: string | null; uploadedBytes: number };

export async function fetchPublishStatus({
  accessToken,
  publishId,
  fetchFn = fetch,
}: {
  accessToken: string;
  publishId: string;
  fetchFn?: typeof fetch;
}): Promise<PublishStatus> {
  const data = await postJson<{ status?: string; fail_reason?: string; uploaded_bytes?: number }>(
    "/v2/post/publish/status/fetch/",
    accessToken,
    { publish_id: publishId },
    fetchFn,
  );
  return { status: data.status ?? "", failReason: data.fail_reason ?? null, uploadedBytes: data.uploaded_bytes ?? 0 };
}

// SEND_TO_USER_INBOX is where a draft upload ends: TikTok has notified the person in the app.
export const IN_INBOX = new Set(["SEND_TO_USER_INBOX", "PUBLISH_COMPLETE"]);

// Asks every few seconds until the draft is in the inbox. FAILED throws with TikTok's reason.
export async function awaitInbox({
  accessToken,
  publishId,
  fetchFn = fetch,
  sleep,
  pollIntervalMs = POLL_INTERVAL_MS,
  maxPolls = MAX_POLLS,
}: {
  accessToken: string;
  publishId: string;
  fetchFn?: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  maxPolls?: number;
}) {
  for (let poll = 1; ; poll++) {
    const current = await fetchPublishStatus({ accessToken, publishId, fetchFn });
    if (IN_INBOX.has(current.status)) return;
    if (current.status === "FAILED") throw new TikTokPublishFailed(current.failReason ?? "unknown");
    if (poll >= maxPolls) throw new TikTokStillProcessing("TikTok is still processing the video; Localirs checks again");
    await sleep(pollIntervalMs);
  }
}

export type TikTokErrorClass = "retry" | "reauth" | "fail";

const REAUTH_CODES = new Set(["access_token_invalid", "scope_not_authorized", "scope_permission_missed"]);

export function classifyTikTokError(err: unknown): TikTokErrorClass {
  if (err instanceof TikTokAuthError) return "reauth";
  if (err instanceof TikTokStillProcessing) return "retry";
  if (err instanceof TikTokPublishFailed) {
    if (err.reason === "auth_removed") return "reauth";
    // TikTok's own words: "This is a retryable error."
    return err.reason === "internal" ? "retry" : "fail";
  }
  if (err instanceof TikTokApiError) {
    if (REAUTH_CODES.has(err.code)) return "reauth";
    if (err.status === 429 || err.code === "rate_limit_exceeded" || err.status >= 500 || err.code === "internal_error") return "retry";
    return "fail";
  }
  if (err instanceof TikTokUploadError) return err.status >= 500 ? "retry" : "fail";
  if (err instanceof TypeError) return "retry";
  return "fail";
}

const PLAIN_WORDS: Record<string, string> = {
  spam_risk_too_many_pending_share:
    "TikTok allows at most 5 drafts waiting in an account's inbox within 24 hours. Finish or delete the drafts in the TikTok app, then retry later.",
  spam_risk_too_many_posts: "TikTok's daily limit on posts for this account was reached. Retry tomorrow.",
  spam_risk_user_banned_from_posting: "TikTok does not let this account post right now.",
  reached_active_user_cap:
    "Your TikTok app has reached TikTok's limit on how many accounts can use it in a day while it is unaudited. Retry tomorrow.",
  unaudited_client_can_only_post_to_private_accounts:
    "TikTok only lets an unaudited app post to private accounts. Make the account private in the TikTok app, or have the app audited.",
  file_format_check_failed: "TikTok refused the video's format.",
  duration_check_failed: "TikTok refused the video's length.",
  frame_rate_check_failed: "TikTok refused the video's frame rate.",
  picture_size_check_failed: "TikTok refused the video's picture size.",
  publish_cancelled: "The draft was canceled in the TikTok app.",
};

// What a failed TikTok post shows.
export function describeTikTokError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const code = err instanceof TikTokApiError ? err.code : err instanceof TikTokPublishFailed ? err.reason : "";
  if (classifyTikTokError(err) === "reauth") {
    return `TikTok no longer accepts this account's login. Reconnect it on the Accounts page and allow every permission. (${message})`;
  }
  if (err instanceof TikTokUploadError && (err.status === 403 || err.status === 404)) {
    return `TikTok's upload link expired. Retry starts a new upload. (${message})`;
  }
  return PLAIN_WORDS[code] ? `${PLAIN_WORDS[code]} (${message})` : message;
}
