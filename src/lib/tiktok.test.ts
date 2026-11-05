import { describe, expect, it } from "vitest";
import { FakeTikTok, tikTokError } from "./fake-tiktok";
import {
  awaitInbox,
  buildTikTokAuthorizeUrl,
  checkTikTokCallback,
  chunkRange,
  classifyTikTokError,
  createTikTokPkce,
  describeTikTokError,
  exchangeTikTokCode,
  fetchPublishStatus,
  getTikTokUser,
  initInboxUpload,
  planChunks,
  refreshTikTokTokens,
  TikTokApiError,
  TikTokAuthError,
  tikTokAppConfig,
  tikTokPkceChallenge,
  TikTokPublishFailed,
  TikTokStillProcessing,
  TikTokUploadError,
  uploadChunks,
} from "./tiktok";

const APP = { clientKey: "awkey", clientSecret: "secret", redirectUri: "http://localhost:3000/api/tiktok/callback" };
const NOW = new Date("2026-11-04T12:00:00Z");

describe("tikTokAppConfig", () => {
  it("needs the client key, the secret and APP_URL", () => {
    const settings = { tiktokClientKey: "awkey", tiktokClientSecret: "secret" };
    expect(tikTokAppConfig(settings, "http://localhost:3000")).toEqual(APP);
    expect(tikTokAppConfig({ ...settings, tiktokClientSecret: null }, "http://localhost:3000")).toBeNull();
    expect(tikTokAppConfig(settings, undefined)).toBeNull();
  });
});

describe("Login Kit OAuth", () => {
  it("uses TikTok's PKCE: the hex SHA-256 of the verifier", () => {
    // RFC 7636's example verifier; its SHA-256 in hex rather than base64url.
    expect(tikTokPkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "13d31e961a1ad8ec2f16b10c4c982e0876a878ad6df144566ee1894acb70f9c3",
    );
    const pkce = createTikTokPkce();
    expect(pkce.verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(pkce.challenge).toMatch(/^[0-9a-f]{64}$/);
  });

  it("builds the authorize URL with the client key, comma-separated scopes, state and the S256 challenge", () => {
    const url = new URL(buildTikTokAuthorizeUrl({ ...APP, state: "st-1", codeChallenge: "abc123" }));
    expect(url.origin + url.pathname).toBe("https://www.tiktok.com/v2/auth/authorize/");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_key: "awkey",
      response_type: "code",
      scope: "user.info.basic,video.upload",
      redirect_uri: APP.redirectUri,
      state: "st-1",
      code_challenge: "abc123",
      code_challenge_method: "S256",
    });
  });

  it("checks the state and the error of the redirect back", () => {
    const params = (query: string) => new URLSearchParams(query);
    expect(checkTikTokCallback({ params: params("code=c1&state=st-1"), expectedState: "st-1" })).toBe("c1");
    expect(() => checkTikTokCallback({ params: params("code=c1&state=x"), expectedState: "st-1" })).toThrow(/expired/);
    expect(() => checkTikTokCallback({ params: params("error=access_denied&state=st-1"), expectedState: "st-1" })).toThrow(
      "TikTok login was canceled",
    );
  });

  it("exchanges the code with the verifier and refuses a login without both scopes", async () => {
    const tiktok = new FakeTikTok();
    const tokens = await exchangeTikTokCode({ app: APP, code: "c1", codeVerifier: "ver", now: NOW, fetchFn: tiktok.fetch });
    expect(tokens).toEqual({ accessToken: "act.0", refreshToken: "rft.0", openId: "open-1", accessExpiresAt: new Date(NOW.getTime() + 86400_000) });
    expect(Object.fromEntries(new URLSearchParams(tiktok.calls[0].body))).toEqual({
      client_key: "awkey",
      client_secret: "secret",
      code: "c1",
      grant_type: "authorization_code",
      redirect_uri: APP.redirectUri,
      code_verifier: "ver",
    });

    tiktok.failures.set(
      "POST open.tiktokapis.com/v2/oauth/token/",
      new Response(JSON.stringify({ access_token: "a", refresh_token: "r", open_id: "o", expires_in: 1, scope: "user.info.basic" })),
    );
    await expect(exchangeTikTokCode({ app: APP, code: "c1", codeVerifier: "ver", now: NOW, fetchFn: tiktok.fetch })).rejects.toThrow(
      /did not grant every permission/,
    );
  });

  it("refreshes, returning TikTok's new refresh token, and reports a refused one as a lost login", async () => {
    const tiktok = new FakeTikTok();
    expect(await refreshTikTokTokens({ app: APP, refreshToken: "rft.0", now: NOW, fetchFn: tiktok.fetch })).toMatchObject({
      accessToken: "act.1",
      refreshToken: "rft.1",
    });
    expect(new URLSearchParams(tiktok.calls[0].body).get("grant_type")).toBe("refresh_token");

    tiktok.failures.set(
      "POST open.tiktokapis.com/v2/oauth/token/",
      new Response(JSON.stringify({ error: "invalid_grant", error_description: "Refresh token is invalid or expired." }), { status: 400 }),
    );
    await expect(refreshTikTokTokens({ app: APP, refreshToken: "old", now: NOW, fetchFn: tiktok.fetch })).rejects.toThrow(TikTokAuthError);
  });

  it("reads the account's name", async () => {
    const tiktok = new FakeTikTok();
    expect(await getTikTokUser({ accessToken: "act.0", fetchFn: tiktok.fetch })).toEqual({ openId: "open-1", displayName: "Baker Bea" });
    expect(tiktok.calls[0].url.searchParams.get("fields")).toBe("open_id,display_name");
  });
});

describe("planChunks", () => {
  it.each([
    [1, 1, 1],
    [4_999_999, 4_999_999, 1],
    [10_000_000, 10_000_000, 1],
    [10_000_001, 10_000_000, 1],
    [19_999_999, 10_000_000, 1],
    [50_000_123, 10_000_000, 5],
    [64_000_000, 10_000_000, 6],
    [4_294_967_296, 10_000_000, 429],
  ])("cuts %i bytes into chunks of %i, %i of them", (size, chunkSize, totalChunks) => {
    const plan = planChunks(size);
    expect(plan).toEqual({ chunkSize, totalChunks });
    const last = chunkRange(plan, size, totalChunks - 1);
    expect(last.end).toBe(size - 1);
    // The last chunk takes the rest: under two chunks, so never over 128 MB.
    expect(last.end - last.start + 1).toBeLessThan(2 * chunkSize);
  });

  it("matches TikTok's worked example: 50,000,123 bytes in 5 chunks, the last one 10,000,123 bytes", () => {
    const plan = planChunks(50_000_123);
    expect([0, 1, 2, 3, 4].map((index) => chunkRange(plan, 50_000_123, index))).toEqual([
      { start: 0, end: 9_999_999 },
      { start: 10_000_000, end: 19_999_999 },
      { start: 20_000_000, end: 29_999_999 },
      { start: 30_000_000, end: 39_999_999 },
      { start: 40_000_000, end: 50_000_122 },
    ]);
  });

  it("refuses an empty video and one over 1000 chunks", () => {
    expect(() => planChunks(0)).toThrow(/empty/);
    expect(() => planChunks(10_010_000_000)).toThrow(/too large/);
  });
});

describe("the inbox upload", () => {
  const source = (size: number) => ({ size, read: async (start: number, end: number) => new Uint8Array(end - start + 1) });

  it("inits a FILE_UPLOAD, PUTs the chunks in order with their Content-Range, and polls until the draft is in the inbox", async () => {
    const tiktok = new FakeTikTok();
    tiktok.pollsUntilInbox = 2;
    const size = 25_000_000;
    const plan = planChunks(size);
    const { publishId, uploadUrl } = await initInboxUpload({ accessToken: "act", size, plan, fetchFn: tiktok.fetch });
    expect(JSON.parse(tiktok.calls[0].body)).toEqual({
      source_info: { source: "FILE_UPLOAD", video_size: 25_000_000, chunk_size: 10_000_000, total_chunk_count: 2 },
    });
    expect(tiktok.calls[0].headers.get("Authorization")).toBe("Bearer act");

    await uploadChunks({ uploadUrl, source: source(size), plan, fetchFn: tiktok.fetch, sleep: async () => {} });
    const puts = tiktok.calls.filter((call) => call.method === "PUT");
    expect(puts.map((call) => [call.headers.get("Content-Range"), call.headers.get("Content-Length")])).toEqual([
      ["bytes 0-9999999/25000000", "10000000"],
      ["bytes 10000000-24999999/25000000", "15000000"],
    ]);
    expect(puts.every((call) => !call.headers.has("Authorization"))).toBe(true);

    const sleeps: number[] = [];
    await awaitInbox({ accessToken: "act", publishId, fetchFn: tiktok.fetch, sleep: async (ms) => void sleeps.push(ms), pollIntervalMs: 7 });
    expect(sleeps).toEqual([7]);
    expect(await fetchPublishStatus({ accessToken: "act", publishId, fetchFn: tiktok.fetch })).toMatchObject({ status: "SEND_TO_USER_INBOX" });
  });

  it("sends a small video as one chunk of its whole size", async () => {
    const tiktok = new FakeTikTok();
    const plan = planChunks(3_000_000);
    const { uploadUrl } = await initInboxUpload({ accessToken: "act", size: 3_000_000, plan, fetchFn: tiktok.fetch });
    await uploadChunks({ uploadUrl, source: source(3_000_000), plan, fetchFn: tiktok.fetch, sleep: async () => {} });
    expect(tiktok.calls[1].headers.get("Content-Range")).toBe("bytes 0-2999999/3000000");
  });

  it("sends a chunk again after a 5xx or a dropped connection, and stops on an expired link", async () => {
    const tiktok = new FakeTikTok();
    const plan = planChunks(3_000_000);
    const { uploadUrl } = await initInboxUpload({ accessToken: "act", size: 3_000_000, plan, fetchFn: tiktok.fetch });
    tiktok.failures.set("PUT open-upload.tiktokapis.com/video/", new Response(null, { status: 503 }));
    const sleeps: number[] = [];
    await uploadChunks({ uploadUrl, source: source(3_000_000), plan, fetchFn: tiktok.fetch, sleep: async (ms) => void sleeps.push(ms) });
    expect(sleeps).toEqual([1000]);

    const expired = new FakeTikTok();
    const second = await initInboxUpload({ accessToken: "act", size: 3_000_000, plan, fetchFn: expired.fetch });
    expired.failures.set("PUT open-upload.tiktokapis.com/video/", new Response(null, { status: 403 }));
    const err = await uploadChunks({ uploadUrl: second.uploadUrl, source: source(3_000_000), plan, fetchFn: expired.fetch, sleep: async () => {} }).catch(
      (caught: unknown) => caught,
    );
    expect(err).toBeInstanceOf(TikTokUploadError);
    expect(describeTikTokError(err)).toMatch(/upload link expired/);
  });

  it("throws TikTok's fail_reason, and asks for another run while it is still processing", async () => {
    const tiktok = new FakeTikTok();
    tiktok.failures.set(
      "POST open.tiktokapis.com/v2/post/publish/status/fetch/",
      new Response(JSON.stringify({ data: { status: "FAILED", fail_reason: "duration_check_failed" }, error: { code: "ok" } })),
    );
    await expect(awaitInbox({ accessToken: "act", publishId: "p", fetchFn: tiktok.fetch, sleep: async () => {} })).rejects.toThrow(
      "TikTok could not take the video: duration_check_failed",
    );

    const slow = new FakeTikTok();
    const plan = planChunks(1000);
    const { publishId, uploadUrl } = await initInboxUpload({ accessToken: "act", size: 1000, plan, fetchFn: slow.fetch });
    await uploadChunks({ uploadUrl, source: source(1000), plan, fetchFn: slow.fetch, sleep: async () => {} });
    slow.pollsUntilInbox = 10;
    await expect(awaitInbox({ accessToken: "act", publishId, fetchFn: slow.fetch, sleep: async () => {}, maxPolls: 3 })).rejects.toThrow(
      TikTokStillProcessing,
    );
  });

  it("reads TikTok's error envelope", async () => {
    const tiktok = new FakeTikTok();
    tiktok.failures.set("POST open.tiktokapis.com/v2/post/publish/inbox/video/init/", tikTokError(403, "spam_risk_too_many_pending_share"));
    const err = await initInboxUpload({ accessToken: "act", size: 1000, plan: planChunks(1000), fetchFn: tiktok.fetch }).catch(
      (caught: unknown) => caught,
    );
    expect(err).toMatchObject({ status: 403, code: "spam_risk_too_many_pending_share" });
  });
});

describe("classifyTikTokError", () => {
  it.each([
    [new TikTokAuthError("x"), "reauth"],
    [new TikTokApiError(401, "access_token_invalid", "x"), "reauth"],
    [new TikTokApiError(401, "scope_not_authorized", "x"), "reauth"],
    [new TikTokApiError(429, "rate_limit_exceeded", "x"), "retry"],
    [new TikTokApiError(500, "internal_error", "x"), "retry"],
    [new TikTokApiError(403, "spam_risk_too_many_pending_share", "x"), "fail"],
    [new TikTokApiError(403, "unaudited_client_can_only_post_to_private_accounts", "x"), "fail"],
    [new TikTokApiError(403, "reached_active_user_cap", "x"), "fail"],
    [new TikTokPublishFailed("internal"), "retry"],
    [new TikTokPublishFailed("auth_removed"), "reauth"],
    [new TikTokPublishFailed("picture_size_check_failed"), "fail"],
    [new TikTokUploadError(502, "x"), "retry"],
    [new TikTokUploadError(416, "x"), "fail"],
    [new TikTokStillProcessing("x"), "retry"],
    [new TypeError("fetch failed"), "retry"],
  ] as const)("classifies %o as %s", (err, kind) => {
    expect(classifyTikTokError(err)).toBe(kind);
  });

  it("says what to do about the pending drafts limit and an unaudited app", () => {
    expect(describeTikTokError(new TikTokApiError(403, "spam_risk_too_many_pending_share", "x"))).toMatch(/at most 5 drafts/);
    expect(describeTikTokError(new TikTokApiError(403, "unaudited_client_can_only_post_to_private_accounts", "x"))).toMatch(
      /private accounts/,
    );
  });
});
