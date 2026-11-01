import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Settings } from "./settings";

export const YOUTUBE_SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly",
];
export const YOUTUBE_CALLBACK_PATH = "/api/youtube/callback";
// Holds "<state>.<PKCE verifier>" between Connect and Google's redirect back.
export const YOUTUBE_OAUTH_COOKIE = "yt_oauth";
const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API_URL = "https://www.googleapis.com/youtube/v3";
const UPLOAD_URL = "https://www.googleapis.com/upload/youtube/v3/videos";
// "People & Blogs", the category YouTube gives an upload by default.
const CATEGORY_ID = "22";
// Chunks must be a multiple of 256 KiB, except the last one.
export const CHUNK_UNIT = 256 * 1024;
const CHUNK_BYTES = 32 * CHUNK_UNIT;
const MAX_CHUNK_RETRIES = 5;

export type GoogleClient = { clientId: string; clientSecret: string; redirectUri: string };

// Connecting YouTube needs the owner's Google OAuth client from /settings; the callback is on APP_URL. Null until all
// three are there.
export function youTubeAppConfig(
  settings: Pick<Settings, "googleClientId" | "googleClientSecret">,
  appUrl: string | undefined,
): GoogleClient | null {
  if (!settings.googleClientId || !settings.googleClientSecret || !appUrl) return null;
  return { clientId: settings.googleClientId, clientSecret: settings.googleClientSecret, redirectUri: youTubeRedirectUri(appUrl) };
}

export function youTubeRedirectUri(appUrl: string): string {
  return new URL(YOUTUBE_CALLBACK_PATH, appUrl).toString();
}

// PKCE (RFC 7636): the verifier stays in a cookie, Google gets its SHA-256 and checks the verifier at the token exchange.
export function createPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString("base64url");
  return { verifier, challenge: pkceChallenge(verifier) };
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function createOAuthState(): string {
  return randomBytes(32).toString("base64url");
}

export function buildYouTubeAuthorizeUrl({
  clientId,
  redirectUri,
  state,
  codeChallenge,
}: Pick<GoogleClient, "clientId" | "redirectUri"> & { state: string; codeChallenge: string }): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", YOUTUBE_SCOPES.join(" "));
  // A refresh token, so posts can be uploaded while nobody is signed in; consent every time, so Google sends one again.
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

// The code from Google's redirect, once the state matches the one this browser was sent off with.
export function checkCallback({
  params,
  expectedState,
}: {
  params: URLSearchParams;
  expectedState: string;
}): string {
  const error = params.get("error");
  if (error) throw new Error(error === "access_denied" ? "Google sign-in was canceled" : `Google returned ${error}`);
  const state = Buffer.from(params.get("state") ?? "");
  const expected = Buffer.from(expectedState);
  if (expected.length === 0 || state.length !== expected.length || !timingSafeEqual(state, expected)) {
    throw new Error("the sign-in link expired or did not start here; connect again");
  }
  const code = params.get("code");
  if (!code) throw new Error("Google returned no code");
  return code;
}

export class YouTubeApiError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string | null,
    message: string,
  ) {
    super(message);
  }
}

// Google no longer accepts the stored refresh token: the access was removed, or the 7 days a consent screen in
// Testing allows have passed.
export class YouTubeAuthError extends Error {}

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
};

async function postToken(body: URLSearchParams, fetchFn: typeof fetch): Promise<TokenResponse> {
  const response = await fetchFn(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = (await response.json()) as TokenResponse;
  if (!response.ok) {
    const message = json.error_description ?? json.error ?? `Google token request failed with ${response.status}`;
    if (json.error === "invalid_grant") throw new YouTubeAuthError(message);
    throw new YouTubeApiError(response.status, json.error ?? null, message);
  }
  if (!json.access_token) throw new Error("Google returned no access token");
  return json;
}

export async function exchangeYouTubeCode({
  client,
  code,
  codeVerifier,
  fetchFn = fetch,
}: {
  client: GoogleClient;
  code: string;
  codeVerifier: string;
  fetchFn?: typeof fetch;
}): Promise<{ accessToken: string; refreshToken: string }> {
  const json = await postToken(
    new URLSearchParams({
      client_id: client.clientId,
      client_secret: client.clientSecret,
      redirect_uri: client.redirectUri,
      grant_type: "authorization_code",
      code,
      code_verifier: codeVerifier,
    }),
    fetchFn,
  );
  // Google's consent screen lets each permission be unticked.
  const granted = (json.scope ?? "").split(" ");
  const missing = YOUTUBE_SCOPES.filter((scope) => !granted.includes(scope));
  if (missing.length > 0) {
    throw new Error("Google did not grant every permission Localirs asks for. Connect again and tick all of them.");
  }
  if (!json.refresh_token) throw new Error("Google returned no refresh token");
  return { accessToken: json.access_token as string, refreshToken: json.refresh_token };
}

export async function refreshYouTubeAccessToken({
  client,
  refreshToken,
  fetchFn = fetch,
}: {
  client: Pick<GoogleClient, "clientId" | "clientSecret">;
  refreshToken: string;
  fetchFn?: typeof fetch;
}): Promise<string> {
  const json = await postToken(
    new URLSearchParams({
      client_id: client.clientId,
      client_secret: client.clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
    fetchFn,
  );
  return json.access_token as string;
}

async function apiError(response: Response): Promise<YouTubeApiError> {
  const text = await response.text();
  let body: { error?: { message?: string; errors?: Array<{ reason?: string }> } } = {};
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON, such as an HTML error page from a proxy; the status says enough.
  }
  return new YouTubeApiError(
    response.status,
    body.error?.errors?.[0]?.reason ?? null,
    body.error?.message ?? `YouTube request failed with ${response.status}`,
  );
}

async function getJson<T>(url: string, accessToken: string, fetchFn: typeof fetch): Promise<T> {
  const response = await fetchFn(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!response.ok) throw await apiError(response);
  return (await response.json()) as T;
}

export async function getMyChannel({
  accessToken,
  fetchFn = fetch,
}: {
  accessToken: string;
  fetchFn?: typeof fetch;
}): Promise<{ channelId: string; title: string }> {
  const body = await getJson<{ items?: Array<{ id: string; snippet: { title: string } }> }>(
    `${API_URL}/channels?part=snippet&mine=true`,
    accessToken,
    fetchFn,
  );
  const channel = body.items?.[0];
  if (!channel) throw new Error("this Google account has no YouTube channel; create one on YouTube first");
  return { channelId: channel.id, title: channel.snippet.title };
}

// A video's counts, named like Instagram's insights so the post page shows them the same way.
export async function getVideoStatistics({
  accessToken,
  videoId,
  fetchFn = fetch,
}: {
  accessToken: string;
  videoId: string;
  fetchFn?: typeof fetch;
}): Promise<Array<{ metric: string; value: number }>> {
  const body = await getJson<{ items?: Array<{ statistics: Record<string, string | undefined> }> }>(
    `${API_URL}/videos?part=statistics&id=${encodeURIComponent(videoId)}`,
    accessToken,
    fetchFn,
  );
  const statistics = body.items?.[0]?.statistics;
  if (!statistics) throw new Error(`YouTube has no video ${videoId}`);
  const names = { viewCount: "views", likeCount: "likes", commentCount: "comments" } as const;
  return Object.entries(names).flatMap(([field, metric]) =>
    statistics[field] === undefined ? [] : [{ metric, value: Number(statistics[field]) }],
  );
}

export type ShortMetadata = {
  title: string;
  description: string;
  privacy: "public" | "unlisted" | "private";
  madeForKids: boolean;
  aiGenerated: boolean;
};

export function videoResource(metadata: ShortMetadata) {
  return {
    snippet: { title: metadata.title, description: metadata.description, categoryId: CATEGORY_ID },
    status: {
      privacyStatus: metadata.privacy,
      selfDeclaredMadeForKids: metadata.madeForKids,
      containsSyntheticMedia: metadata.aiGenerated,
    },
  };
}

// The video, read a chunk at a time: bytes start to end, inclusive.
export type UploadSource = { size: number; read(start: number, end: number): Promise<Uint8Array> };

type UploadDeps = { accessToken: string; fetchFn: typeof fetch; sleep: (ms: number) => Promise<void>; chunkBytes: number };

type UploadState = { done: true; videoId: string } | { done: false; offset: number };

async function finished(response: Response): Promise<UploadState> {
  const body = (await response.json()) as { id?: string };
  if (!body.id) throw new Error("YouTube finished the upload but returned no video id");
  return { done: true, videoId: body.id };
}

// A 308 says how much YouTube has: "Range: bytes=0-N" means the next byte to send is N + 1; no Range means none.
function nextOffset(response: Response): number {
  const range = response.headers.get("Range");
  if (!range) return 0;
  const match = /^bytes=0-(\d+)$/.exec(range);
  if (!match) throw new Error(`YouTube sent an unexpected Range: ${range}`);
  return Number(match[1]) + 1;
}

export async function startResumableUpload({
  accessToken,
  metadata,
  size,
  fetchFn = fetch,
}: {
  accessToken: string;
  metadata: ShortMetadata;
  size: number;
  fetchFn?: typeof fetch;
}): Promise<string> {
  const response = await fetchFn(`${UPLOAD_URL}?uploadType=resumable&part=snippet,status`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Length": String(size),
      "X-Upload-Content-Type": "video/mp4",
    },
    body: JSON.stringify(videoResource(metadata)),
  });
  if (!response.ok) throw await apiError(response);
  const sessionUrl = response.headers.get("Location");
  if (!sessionUrl) throw new Error("YouTube returned no upload session");
  return sessionUrl;
}

// Asks the session how far the upload got, with an empty PUT.
export async function uploadStatus({
  sessionUrl,
  size,
  accessToken,
  fetchFn = fetch,
}: {
  sessionUrl: string;
  size: number;
  accessToken: string;
  fetchFn?: typeof fetch;
}): Promise<UploadState> {
  const response = await fetchFn(sessionUrl, {
    method: "PUT",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Length": "0", "Content-Range": `bytes */${size}` },
  });
  if (response.status === 200 || response.status === 201) return finished(response);
  if (response.status === 308) return { done: false, offset: nextOffset(response) };
  throw await apiError(response);
}

const retryable = (err: unknown) => err instanceof TypeError || (err instanceof YouTubeApiError && err.status >= 500);

async function sendChunk(deps: UploadDeps, sessionUrl: string, source: UploadSource, offset: number): Promise<UploadState> {
  const end = Math.min(offset + deps.chunkBytes, source.size) - 1;
  const chunk = await source.read(offset, end);
  const response = await deps.fetchFn(sessionUrl, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${deps.accessToken}`,
      "Content-Length": String(chunk.byteLength),
      "Content-Range": `bytes ${offset}-${end}/${source.size}`,
    },
    body: new Blob([chunk as Uint8Array<ArrayBuffer>], { type: "video/mp4" }),
  });
  if (response.status === 200 || response.status === 201) return finished(response);
  if (response.status === 308) return { done: false, offset: nextOffset(response) };
  throw await apiError(response);
}

// After a 5xx or a dropped connection: wait 1, 2, 4, 8, 16 seconds between tries, and ask the session what arrived.
async function recover(deps: UploadDeps, sessionUrl: string, size: number, first: unknown): Promise<UploadState> {
  let err = first;
  for (let retry = 0; retry < MAX_CHUNK_RETRIES; retry++) {
    if (!retryable(err)) throw err;
    await deps.sleep(2 ** retry * 1000);
    try {
      return await uploadStatus({ sessionUrl, size, accessToken: deps.accessToken, fetchFn: deps.fetchFn });
    } catch (statusErr) {
      err = statusErr;
    }
  }
  throw err;
}

async function sendChunks(deps: UploadDeps, sessionUrl: string, source: UploadSource, from: number): Promise<string> {
  let offset = from;
  // Chunks in a row that failed without YouTube getting a byte more; the run gives up after as many as one recovery tries.
  let stalled = 0;
  for (;;) {
    let state: UploadState;
    try {
      state = await sendChunk(deps, sessionUrl, source, offset);
    } catch (err) {
      if (stalled >= MAX_CHUNK_RETRIES) throw err;
      state = await recover(deps, sessionUrl, source.size, err);
      stalled = !state.done && state.offset <= offset ? stalled + 1 : 0;
    }
    if (state.done) return state.videoId;
    offset = state.offset;
  }
}

// Uploads with YouTube's resumable protocol. With the session of an earlier run, it goes on from what YouTube already
// has; a session YouTube no longer knows (404) is started again. onSession stores a new session before any byte is sent.
export async function uploadShort({
  accessToken,
  metadata,
  source,
  sessionUrl,
  onSession,
  fetchFn = fetch,
  sleep,
  chunkBytes = CHUNK_BYTES,
}: {
  accessToken: string;
  metadata: ShortMetadata;
  source: UploadSource;
  sessionUrl: string | null;
  onSession: (url: string) => Promise<void>;
  fetchFn?: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  chunkBytes?: number;
}): Promise<string> {
  if (chunkBytes <= 0 || chunkBytes % CHUNK_UNIT !== 0) throw new Error("upload chunks must be a multiple of 256 KiB");
  if (source.size === 0) throw new Error("the video is empty");
  const deps = { accessToken, fetchFn, sleep, chunkBytes };
  if (sessionUrl) {
    try {
      const state = await uploadStatus({ sessionUrl, size: source.size, accessToken, fetchFn });
      if (state.done) return state.videoId;
      return await sendChunks(deps, sessionUrl, source, state.offset);
    } catch (err) {
      if (!(err instanceof YouTubeApiError && err.status === 404)) throw err;
    }
  }
  const fresh = await startResumableUpload({ accessToken, metadata, size: source.size, fetchFn });
  await onSession(fresh);
  return sendChunks(deps, fresh, source, 0);
}

export type YouTubeErrorClass = "retry" | "quota" | "reauth" | "fail";

const QUOTA_REASONS = new Set(["quotaExceeded", "dailyLimitExceeded", "uploadLimitExceeded"]);
const RATE_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded"]);

export function classifyYouTubeError(err: unknown): YouTubeErrorClass {
  if (err instanceof YouTubeAuthError) return "reauth";
  if (err instanceof YouTubeApiError) {
    if (err.reason && QUOTA_REASONS.has(err.reason)) return "quota";
    if (err.status >= 500 || err.status === 429 || (err.reason && RATE_REASONS.has(err.reason))) return "retry";
    if (err.status === 401) return "reauth";
    return "fail";
  }
  if (err instanceof TypeError) return "retry";
  return "fail";
}

// What a failed YouTube post shows, by the class of its error.
export function describeYouTubeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  switch (classifyYouTubeError(err)) {
    case "quota":
      return err instanceof YouTubeApiError && err.reason === "uploadLimitExceeded"
        ? `YouTube quota: this channel has uploaded as many videos as YouTube allows for now. Retry later. (${message})`
        : `YouTube quota: your Google Cloud project's daily YouTube API quota is used up. It resets at midnight Pacific time; retry after that. (${message})`;
    case "reauth":
      return `YouTube no longer accepts this channel's login. Reconnect it on the Accounts page. (${message})`;
    default:
      return message;
  }
}

const SHORTS_MAX_SECONDS = 180;

export type YouTubePostProblem = string;

// YouTube's limits on a title and a description (snippet.title, snippet.description), and what makes a video a Short:
// vertical (or square) and at most 3 minutes.
export function checkYouTubePost({
  title,
  description,
  seconds,
  width,
  height,
}: {
  title: string;
  description: string;
  seconds: number;
  width: number;
  height: number;
}): YouTubePostProblem[] {
  const problems: YouTubePostProblem[] = [];
  if (title.trim() === "") problems.push("the YouTube title is empty");
  if ([...title].length > 100) problems.push("the YouTube title is over 100 characters");
  if (/[<>]/.test(title)) problems.push("the YouTube title cannot contain < or >");
  if (Buffer.byteLength(description, "utf8") > 5000) problems.push("the YouTube description is over 5,000 bytes");
  if (/[<>]/.test(description)) problems.push("the YouTube description cannot contain < or >");
  if (seconds > SHORTS_MAX_SECONDS) problems.push("a YouTube Short is at most 3 minutes long");
  if (width > height) problems.push("a YouTube Short must be vertical or square");
  return problems;
}

// The caption as the description, with #Shorts added unless it is there already.
export function shortsDescription(caption: string): string {
  const trimmed = caption.trim();
  if (/(^|\s)#shorts\b/i.test(trimmed)) return trimmed;
  return trimmed === "" ? "#Shorts" : `${trimmed}\n\n#Shorts`;
}

export function youTubeVideoUrl(videoId: string): string {
  return `https://www.youtube.com/shorts/${videoId}`;
}
