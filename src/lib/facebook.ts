import { randomBytes, timingSafeEqual } from "node:crypto";
import { META_API_VERSION } from "./meta";
import type { Settings } from "./settings";

// Facebook Login for Business on the same Meta app as Instagram. Its configuration (made in the app dashboard) holds
// these permissions; the Reels Publishing API needs all three.
export const FACEBOOK_PERMISSIONS = ["pages_show_list", "pages_read_engagement", "pages_manage_posts"];
export const FACEBOOK_CALLBACK_PATH = "/api/facebook/callback";
// Holds the state between Connect and Facebook's redirect back.
export const FACEBOOK_OAUTH_COOKIE = "fb_oauth";
// Holds the sealed long-lived user token while the person picks Pages on /accounts/facebook.
export const FACEBOOK_PICK_COOKIE = "fb_pick";
const DIALOG_URL = `https://www.facebook.com/${META_API_VERSION}/dialog/oauth`;
export const GRAPH_URL = `https://graph.facebook.com/${META_API_VERSION}`;
// A Page task that allows publishing, which the Reels Publishing API asks for.
const CREATE_CONTENT = "CREATE_CONTENT";
const MAX_PAGE_LISTS = 20;

export type FacebookApp = { appId: string; appSecret: string; configId: string; redirectUri: string };

// Connecting Pages needs the Meta app from /settings and its Facebook Login for Business configuration; the callback is
// on APP_URL. Null until all are there.
export function facebookAppConfig(
  settings: Pick<Settings, "metaAppId" | "metaAppSecret" | "fbLoginConfigId">,
  appUrl: string | undefined,
): FacebookApp | null {
  if (!settings.metaAppId || !settings.metaAppSecret || !settings.fbLoginConfigId || !appUrl) return null;
  return {
    appId: settings.metaAppId,
    appSecret: settings.metaAppSecret,
    configId: settings.fbLoginConfigId,
    redirectUri: facebookRedirectUri(appUrl),
  };
}

export function facebookRedirectUri(appUrl: string): string {
  return new URL(FACEBOOK_CALLBACK_PATH, appUrl).toString();
}

export function createFacebookState(): string {
  return randomBytes(32).toString("base64url");
}

// The manual login flow with a configuration ID in place of a scope list, as Facebook Login for Business asks.
export function buildFacebookAuthorizeUrl({
  appId,
  configId,
  redirectUri,
  state,
}: Pick<FacebookApp, "appId" | "configId" | "redirectUri"> & { state: string }): string {
  const url = new URL(DIALOG_URL);
  url.searchParams.set("client_id", appId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("config_id", configId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  return url.toString();
}

// The code from Facebook's redirect, once the state matches the one this browser was sent off with.
export function checkFacebookCallback({ params, expectedState }: { params: URLSearchParams; expectedState: string }): string {
  const error = params.get("error");
  if (error) {
    throw new Error(
      params.get("error_reason") === "user_denied" ? "Facebook login was canceled" : `Facebook returned ${params.get("error_description") ?? error}`,
    );
  }
  const state = Buffer.from(params.get("state") ?? "");
  const expected = Buffer.from(expectedState);
  if (expected.length === 0 || state.length !== expected.length || !timingSafeEqual(state, expected)) {
    throw new Error("the login link expired or did not start here; connect again");
  }
  const code = params.get("code");
  if (!code) throw new Error("Facebook returned no code");
  return code;
}

export class FacebookApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: number | undefined,
    readonly subcode: number | undefined,
    readonly transient: boolean,
    message: string,
  ) {
    super(message);
  }
}

type GraphBody = Record<string, unknown> & {
  error?: { message?: string; code?: number; error_subcode?: number; is_transient?: boolean };
};

async function readGraph(response: Response): Promise<GraphBody> {
  const text = await response.text();
  let body: GraphBody;
  try {
    body = JSON.parse(text) as GraphBody;
  } catch {
    // A gateway error page is not JSON; the status says enough for the retry rules.
    if (!response.ok) throw new FacebookApiError(response.status, undefined, undefined, false, `Facebook returned HTTP ${response.status}`);
    throw new Error("Facebook returned a non-JSON response");
  }
  if (!response.ok || body.error) {
    const error = body.error ?? {};
    throw new FacebookApiError(
      response.status,
      error.code,
      error.error_subcode,
      error.is_transient === true,
      error.message ?? `Facebook request failed with ${response.status}`,
    );
  }
  return body;
}

async function graphGet(path: string, params: Record<string, string>, fetchFn: typeof fetch): Promise<GraphBody> {
  const url = new URL(path.startsWith("https://") ? path : `${GRAPH_URL}/${path}`);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  return readGraph(await fetchFn(url.toString()));
}

async function graphPost(path: string, params: Record<string, string>, fetchFn: typeof fetch): Promise<GraphBody> {
  return readGraph(
    await fetchFn(`${GRAPH_URL}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params),
    }),
  );
}

// The code for a short-lived user token, then that for a long-lived one (about 60 days). Page tokens read with a
// long-lived user token do not expire.
export async function exchangeFacebookCode({
  app,
  code,
  fetchFn = fetch,
}: {
  app: Pick<FacebookApp, "appId" | "appSecret" | "redirectUri">;
  code: string;
  fetchFn?: typeof fetch;
}): Promise<string> {
  const short = await graphGet(
    "oauth/access_token",
    { client_id: app.appId, client_secret: app.appSecret, redirect_uri: app.redirectUri, code },
    fetchFn,
  );
  if (typeof short.access_token !== "string") throw new Error("Facebook returned no access token");
  const long = await graphGet(
    "oauth/access_token",
    { grant_type: "fb_exchange_token", client_id: app.appId, client_secret: app.appSecret, fb_exchange_token: short.access_token },
    fetchFn,
  );
  if (typeof long.access_token !== "string") throw new Error("Facebook returned no long-lived access token");
  return long.access_token;
}

// Facebook's login lets permissions be turned off; the Reels need every one.
export async function checkFacebookPermissions({ userToken, fetchFn = fetch }: { userToken: string; fetchFn?: typeof fetch }) {
  const body = await graphGet("me/permissions", { access_token: userToken }, fetchFn);
  const granted = ((body.data ?? []) as Array<{ permission: string; status: string }>)
    .filter((row) => row.status === "granted")
    .map((row) => row.permission);
  const missing = FACEBOOK_PERMISSIONS.filter((permission) => !granted.includes(permission));
  if (missing.length > 0) {
    throw new Error(`Facebook did not grant ${missing.join(", ")}. Connect again and allow everything Localirs asks for.`);
  }
}

export type ManagedPage = { pageId: string; name: string; accessToken: string };

// The Pages this person can publish to, with their Page tokens.
export async function listManagedPages({ userToken, fetchFn = fetch }: { userToken: string; fetchFn?: typeof fetch }): Promise<ManagedPage[]> {
  const pages: ManagedPage[] = [];
  let next: string | null = `${GRAPH_URL}/me/accounts`;
  let params: Record<string, string> = { fields: "id,name,access_token,tasks", limit: "100", access_token: userToken };
  for (let list = 0; next && list < MAX_PAGE_LISTS; list++) {
    const body = await graphGet(next, params, fetchFn);
    for (const page of (body.data ?? []) as Array<{ id: string; name: string; access_token?: string; tasks?: string[] }>) {
      if (page.access_token && (page.tasks ?? []).includes(CREATE_CONTENT)) {
        pages.push({ pageId: page.id, name: page.name, accessToken: page.access_token });
      }
    }
    // The next link carries every parameter already.
    next = (body.paging as { next?: string } | undefined)?.next ?? null;
    params = {};
  }
  return pages;
}

// Step 1 of the Reels Publishing API: an upload session for one Reel on the Page.
export async function startReel({
  pageId,
  pageToken,
  fetchFn = fetch,
}: {
  pageId: string;
  pageToken: string;
  fetchFn?: typeof fetch;
}): Promise<string> {
  const body = await graphPost(`${pageId}/video_reels`, { upload_phase: "start", access_token: pageToken }, fetchFn);
  if (typeof body.video_id !== "string") throw new Error("Facebook started no Reel upload");
  return body.video_id;
}

// Uploads go to rupload.facebook.com, not the Graph API host.
const UPLOAD_HOST = "https://rupload.facebook.com/video-upload";

export function reelUploadUrl(videoId: string): string {
  return `${UPLOAD_HOST}/${META_API_VERSION}/${videoId}`;
}

async function checkUploaded(response: Response) {
  const body = await readGraph(response);
  if (body.success !== true) throw new Error("Facebook did not accept the Reel's video");
}

// Step 2, from a link Facebook downloads the video from (the presigned R2 copy).
export async function uploadReelFromUrl({
  videoId,
  pageToken,
  fileUrl,
  fetchFn = fetch,
}: {
  videoId: string;
  pageToken: string;
  fileUrl: string;
  fetchFn?: typeof fetch;
}) {
  await checkUploaded(
    await fetchFn(reelUploadUrl(videoId), { method: "POST", headers: { Authorization: `OAuth ${pageToken}`, file_url: fileUrl } }),
  );
}

// Step 2, from this PC: the bytes from offset to the end, so an interrupted upload goes on where Facebook stopped.
export async function uploadReelBytes({
  videoId,
  pageToken,
  source,
  offset,
  fetchFn = fetch,
}: {
  videoId: string;
  pageToken: string;
  source: { size: number; read(start: number, end: number): Promise<Uint8Array> };
  offset: number;
  fetchFn?: typeof fetch;
}) {
  const bytes = await source.read(offset, source.size - 1);
  await checkUploaded(
    await fetchFn(reelUploadUrl(videoId), {
      method: "POST",
      headers: {
        Authorization: `OAuth ${pageToken}`,
        offset: String(offset),
        file_size: String(source.size),
        "Content-Type": "application/octet-stream",
      },
      body: new Blob([bytes as Uint8Array<ArrayBuffer>]),
    }),
  );
}

type Phase = { status?: string; bytes_transfered?: number; error?: { message?: string } };

export type ReelStatus = {
  videoStatus: string;
  uploading: string;
  uploadedBytes: number;
  processing: string;
  publishing: string;
  // The first error Facebook reports on any phase.
  error: string | null;
};

export async function getReelStatus({
  videoId,
  pageToken,
  fetchFn = fetch,
}: {
  videoId: string;
  pageToken: string;
  fetchFn?: typeof fetch;
}): Promise<ReelStatus> {
  const body = await graphGet(videoId, { fields: "status", access_token: pageToken }, fetchFn);
  const status = (body.status ?? {}) as {
    video_status?: string;
    uploading_phase?: Phase;
    processing_phase?: Phase;
    publishing_phase?: Phase;
  };
  const phases = [status.uploading_phase, status.processing_phase, status.publishing_phase];
  const error = phases.find((phase) => phase?.error?.message)?.error?.message ?? (status.video_status === "error" ? "Facebook could not process the video" : null);
  return {
    videoStatus: status.video_status ?? "",
    uploading: status.uploading_phase?.status ?? "not_started",
    uploadedBytes: status.uploading_phase?.bytes_transfered ?? 0,
    processing: status.processing_phase?.status ?? "not_started",
    publishing: status.publishing_phase?.status ?? "not_started",
    error,
  };
}

// Step 3: ends the upload and publishes the Reel now. is_ai_generated is the API's own claim that it was made with AI.
export async function finishReel({
  pageId,
  pageToken,
  videoId,
  description,
  aiGenerated,
  fetchFn = fetch,
}: {
  pageId: string;
  pageToken: string;
  videoId: string;
  description: string;
  aiGenerated: boolean;
  fetchFn?: typeof fetch;
}): Promise<string | null> {
  const body = await graphPost(
    `${pageId}/video_reels`,
    {
      upload_phase: "finish",
      video_id: videoId,
      video_state: "PUBLISHED",
      description,
      is_ai_generated: String(aiGenerated),
      access_token: pageToken,
    },
    fetchFn,
  );
  if (body.success !== true) throw new Error("Facebook did not publish the Reel");
  return typeof body.post_id === "string" ? body.post_id : null;
}

export async function getReelPermalink({
  videoId,
  pageToken,
  fetchFn = fetch,
}: {
  videoId: string;
  pageToken: string;
  fetchFn?: typeof fetch;
}): Promise<string> {
  const body = await graphGet(videoId, { fields: "permalink_url", access_token: pageToken }, fetchFn);
  if (typeof body.permalink_url !== "string") throw new Error("Facebook returned no link to the Reel");
  return new URL(body.permalink_url, "https://www.facebook.com").toString();
}

export type FacebookErrorClass = "retry" | "reauth" | "fail";

const INVALID_TOKEN = 190;
// Rate limits: the app's, the Page's, and the API's (#613, also the 30 Reels a day limit).
const RATE_CODES = new Set([4, 17, 32, 613, 80001]);
// "An unknown error occurred" and "Service temporarily unavailable".
const TRANSIENT_CODES = new Set([1, 2]);
const PERMISSION_CODES = new Set([10, 200]);

export function classifyFacebookError(err: unknown): FacebookErrorClass {
  if (err instanceof FacebookApiError) {
    if (err.code === INVALID_TOKEN) return "reauth";
    if (err.code !== undefined && PERMISSION_CODES.has(err.code)) return "reauth";
    if (err.status >= 500 || err.transient) return "retry";
    if (err.code !== undefined && (RATE_CODES.has(err.code) || TRANSIENT_CODES.has(err.code))) return "retry";
    return "fail";
  }
  if (err instanceof TypeError) return "retry";
  return "fail";
}

// What a failed Facebook post shows, by the class of its error.
export function describeFacebookError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof FacebookApiError && err.code === 613) {
    return `Facebook's limit was reached: a Page can publish 30 Reels through the API in 24 hours. Retry later. (${message})`;
  }
  if (classifyFacebookError(err) === "reauth") {
    return `Facebook no longer lets Localirs publish to this Page. Reconnect it on the Accounts page and allow every permission. (${message})`;
  }
  return message;
}

// Facebook's limits on a Reel (Reels Publishing API, video specifications).
export const REEL_MIN_SECONDS = 3;
export const REEL_MAX_SECONDS = 90;

export function checkFacebookReel({ seconds }: { seconds: number }): string[] {
  const problems: string[] = [];
  if (seconds < REEL_MIN_SECONDS || seconds > REEL_MAX_SECONDS) problems.push("a Facebook Reel is 3 to 90 seconds long");
  return problems;
}
