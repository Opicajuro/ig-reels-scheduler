import { describe, expect, it } from "vitest";
import { FakeGraph, graphError } from "./fake-meta-graph";
import {
  buildFacebookAuthorizeUrl,
  checkFacebookCallback,
  checkFacebookPermissions,
  checkFacebookReel,
  classifyFacebookError,
  describeFacebookError,
  exchangeFacebookCode,
  facebookAppConfig,
  FacebookApiError,
  finishReel,
  getReelPermalink,
  getReelStatus,
  listManagedPages,
  startReel,
  uploadReelBytes,
  uploadReelFromUrl,
} from "./facebook";

const SETTINGS = { metaAppId: "1234", metaAppSecret: "app-secret", fbLoginConfigId: "998877" };
const APP = { appId: "1234", appSecret: "app-secret", configId: "998877", redirectUri: "http://localhost:3000/api/facebook/callback" };

describe("facebookAppConfig", () => {
  it("needs the Meta app, the configuration ID and APP_URL", () => {
    expect(facebookAppConfig(SETTINGS, "http://localhost:3000")).toEqual(APP);
    expect(facebookAppConfig({ ...SETTINGS, fbLoginConfigId: null }, "http://localhost:3000")).toBeNull();
    expect(facebookAppConfig({ ...SETTINGS, metaAppSecret: null }, "http://localhost:3000")).toBeNull();
    expect(facebookAppConfig(SETTINGS, undefined)).toBeNull();
  });
});

describe("buildFacebookAuthorizeUrl", () => {
  it("opens Facebook's login dialog with the configuration ID, the state and the code flow, without a scope list", () => {
    const url = new URL(buildFacebookAuthorizeUrl({ ...APP, state: "st-1" }));
    expect(url.origin + url.pathname).toBe("https://www.facebook.com/v26.0/dialog/oauth");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "1234",
      redirect_uri: APP.redirectUri,
      config_id: "998877",
      response_type: "code",
      state: "st-1",
    });
  });
});

describe("checkFacebookCallback", () => {
  const params = (query: string) => new URLSearchParams(query);

  it("returns the code when the state matches", () => {
    expect(checkFacebookCallback({ params: params("code=abc&state=st-1"), expectedState: "st-1" })).toBe("abc");
  });

  it("refuses a state that does not match or is missing, and a canceled login", () => {
    expect(() => checkFacebookCallback({ params: params("code=abc&state=other"), expectedState: "st-1" })).toThrow(/expired/);
    expect(() => checkFacebookCallback({ params: params("code=abc&state="), expectedState: "" })).toThrow(/expired/);
    expect(() =>
      checkFacebookCallback({ params: params("error=access_denied&error_reason=user_denied&state=st-1"), expectedState: "st-1" }),
    ).toThrow("Facebook login was canceled");
  });
});

describe("tokens and Pages", () => {
  it("exchanges the code for a short-lived token, then for a long-lived one", async () => {
    const graph = new FakeGraph();
    expect(await exchangeFacebookCode({ app: APP, code: "abc", fetchFn: graph.fetch })).toBe("long-user-token");
    const [first, second] = graph.calls.map((call) => Object.fromEntries(call.url.searchParams));
    expect(first).toEqual({ client_id: "1234", client_secret: "app-secret", redirect_uri: APP.redirectUri, code: "abc" });
    expect(second).toEqual({
      grant_type: "fb_exchange_token",
      client_id: "1234",
      client_secret: "app-secret",
      fb_exchange_token: "short-user-token",
    });
  });

  it("refuses a login without every permission", async () => {
    const graph = new FakeGraph();
    await expect(checkFacebookPermissions({ userToken: "t", fetchFn: graph.fetch })).resolves.toBeUndefined();
    graph.failures.set(
      "GET graph.facebook.com/v26.0/me/permissions",
      new Response(JSON.stringify({ data: [{ permission: "pages_show_list", status: "granted" }, { permission: "pages_manage_posts", status: "declined" }] })),
    );
    await expect(checkFacebookPermissions({ userToken: "t", fetchFn: graph.fetch })).rejects.toThrow(
      "Facebook did not grant pages_read_engagement, pages_manage_posts",
    );
  });

  it("lists the Pages the person can create content on, following the next page", async () => {
    const graph = new FakeGraph();
    expect(await listManagedPages({ userToken: "long-user-token", fetchFn: graph.fetch })).toEqual([
      { pageId: "page-1", name: "Bakery", accessToken: "page-token-1" },
      { pageId: "page-3", name: "Third", accessToken: "page-token-3" },
    ]);
    expect(graph.calls[0].url.searchParams.get("fields")).toBe("id,name,access_token,tasks");
  });
});

describe("the Reels Publishing API", () => {
  it("starts a session, uploads from a link, finishes as published and reads the status and the link", async () => {
    const graph = new FakeGraph();
    const videoId = await startReel({ pageId: "page-1", pageToken: "pt", fetchFn: graph.fetch });
    expect(videoId).toBe("video-1");
    expect(Object.fromEntries(new URLSearchParams(graph.calls[0].body))).toEqual({ upload_phase: "start", access_token: "pt" });

    await uploadReelFromUrl({ videoId, pageToken: "pt", fileUrl: "https://r2.test/fb-posts/p.mp4?sig=1", fetchFn: graph.fetch });
    const upload = graph.calls[1];
    expect(upload.url.toString()).toBe("https://rupload.facebook.com/video-upload/v26.0/video-1");
    expect(upload.headers.get("Authorization")).toBe("OAuth pt");
    expect(upload.headers.get("file_url")).toBe("https://r2.test/fb-posts/p.mp4?sig=1");

    expect(
      await finishReel({ pageId: "page-1", pageToken: "pt", videoId, description: "Watch #bread", aiGenerated: true, fetchFn: graph.fetch }),
    ).toBe("page-1_video-1");
    expect(Object.fromEntries(new URLSearchParams(graph.calls[2].body))).toEqual({
      upload_phase: "finish",
      video_id: "video-1",
      video_state: "PUBLISHED",
      description: "Watch #bread",
      is_ai_generated: "true",
      access_token: "pt",
    });

    expect(await getReelStatus({ videoId, pageToken: "pt", fetchFn: graph.fetch })).toMatchObject({
      uploading: "complete",
      publishing: "complete",
      error: null,
    });
    expect(await getReelPermalink({ videoId, pageToken: "pt", fetchFn: graph.fetch })).toBe("https://www.facebook.com/reel/video-1");
  });

  it("uploads the bytes from an offset, with the offset and file size headers", async () => {
    const graph = new FakeGraph();
    const videoId = await startReel({ pageId: "page-1", pageToken: "pt", fetchFn: graph.fetch });
    const reads: Array<[number, number]> = [];
    const source = { size: 1000, read: async (start: number, end: number) => (reads.push([start, end]), new Uint8Array(end - start + 1)) };
    await uploadReelBytes({ videoId, pageToken: "pt", source, offset: 400, fetchFn: graph.fetch });
    expect(reads).toEqual([[400, 999]]);
    const upload = graph.calls[1];
    expect([upload.headers.get("offset"), upload.headers.get("file_size"), upload.body]).toEqual(["400", "1000", "<600 bytes>"]);
  });

  it("reports an error Facebook puts on a phase", async () => {
    const graph = new FakeGraph();
    graph.failures.set(
      "GET graph.facebook.com/v26.0/video-9",
      new Response(
        JSON.stringify({
          status: {
            video_status: "processing",
            uploading_phase: { status: "complete" },
            processing_phase: { status: "not_started", error: { message: "Resolution too low." } },
            publishing_phase: { status: "not_started" },
          },
        }),
      ),
    );
    expect((await getReelStatus({ videoId: "video-9", pageToken: "pt", fetchFn: graph.fetch })).error).toBe("Resolution too low.");
  });

  it("turns Graph errors into FacebookApiError with the code", async () => {
    const graph = new FakeGraph();
    graph.failures.set("POST graph.facebook.com/v26.0/page-1/video_reels", graphError(400, 613, "Calls to this api have exceeded the rate limit."));
    const err = await startReel({ pageId: "page-1", pageToken: "pt", fetchFn: graph.fetch }).catch((caught: unknown) => caught);
    expect(err).toBeInstanceOf(FacebookApiError);
    expect(err).toMatchObject({ status: 400, code: 613 });
  });
});

describe("classifyFacebookError", () => {
  const error = (status: number, code?: number, transient = false) => new FacebookApiError(status, code, undefined, transient, "x");

  it.each([
    [error(400, 190), "reauth"],
    [error(403, 200), "reauth"],
    [error(400, 10), "reauth"],
    [error(400, 613), "retry"],
    [error(400, 4), "retry"],
    [error(400, 80001), "retry"],
    [error(500, 1), "retry"],
    [error(503), "retry"],
    [error(400, 100, true), "retry"],
    [error(400, 100), "fail"],
    [error(400, 368), "fail"],
    [new TypeError("fetch failed"), "retry"],
    [new Error("Resolution too low."), "fail"],
  ] as const)("classifies %o as %s", (err, kind) => {
    expect(classifyFacebookError(err)).toBe(kind);
  });

  it("explains the 30 Reels a day limit and a lost login", () => {
    expect(describeFacebookError(error(400, 613))).toMatch(/30 Reels through the API in 24 hours/);
    expect(describeFacebookError(error(400, 190))).toMatch(/Reconnect it on the Accounts page/);
  });
});

describe("checkFacebookReel", () => {
  it("accepts 3 to 90 seconds", () => {
    expect(checkFacebookReel({ seconds: 3 })).toEqual([]);
    expect(checkFacebookReel({ seconds: 90 })).toEqual([]);
    expect(checkFacebookReel({ seconds: 2.5 })).toHaveLength(1);
    expect(checkFacebookReel({ seconds: 91 })).toHaveLength(1);
  });
});
