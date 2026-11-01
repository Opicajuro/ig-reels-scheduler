import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildYouTubeAuthorizeUrl,
  checkCallback,
  checkYouTubePost,
  classifyYouTubeError,
  createPkce,
  exchangeYouTubeCode,
  getVideoStatistics,
  refreshYouTubeAccessToken,
  shortsDescription,
  uploadShort,
  YouTubeApiError,
  YouTubeAuthError,
  youTubeAppConfig,
  type ShortMetadata,
  type UploadSource,
} from "./youtube";

const CLIENT = {
  clientId: "client-id.apps.googleusercontent.com",
  clientSecret: "client-secret",
  redirectUri: "http://localhost:3000/api/youtube/callback",
};

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

function tokenServer(response: Response) {
  const bodies: URLSearchParams[] = [];
  const fetchFn = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(new URLSearchParams(String(init?.body)));
    return response;
  }) as typeof fetch;
  return { fetchFn, bodies };
}

describe("youTubeAppConfig", () => {
  it("needs the client ID, the secret and the app address, and puts the callback on that address", () => {
    const settings = { googleClientId: CLIENT.clientId, googleClientSecret: "s" };
    expect(youTubeAppConfig(settings, "http://localhost:3000")).toEqual({
      clientId: CLIENT.clientId,
      clientSecret: "s",
      redirectUri: "http://localhost:3000/api/youtube/callback",
    });
    expect(youTubeAppConfig({ ...settings, googleClientSecret: null }, "http://localhost:3000")).toBeNull();
    expect(youTubeAppConfig(settings, undefined)).toBeNull();
  });
});

describe("OAuth", () => {
  it("builds the authorize URL with both scopes, offline access, the state and an S256 PKCE challenge", () => {
    const pkce = createPkce();
    expect(pkce.verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(pkce.challenge).toBe(createHash("sha256").update(pkce.verifier).digest("base64url"));

    const url = new URL(buildYouTubeAuthorizeUrl({ ...CLIENT, state: "state-1", codeChallenge: pkce.challenge }));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: CLIENT.clientId,
      redirect_uri: CLIENT.redirectUri,
      response_type: "code",
      scope: "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly",
      access_type: "offline",
      prompt: "consent",
      state: "state-1",
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
    });
  });

  it("makes a new verifier every time", () => {
    expect(createPkce().verifier).not.toBe(createPkce().verifier);
  });

  it("accepts the callback only with the state it was sent off with", () => {
    const params = (query: string) => new URLSearchParams(query);
    expect(checkCallback({ params: params("code=abc&state=s1"), expectedState: "s1" })).toBe("abc");
    expect(() => checkCallback({ params: params("code=abc&state=s2"), expectedState: "s1" })).toThrow(/expired/);
    expect(() => checkCallback({ params: params("code=abc&state="), expectedState: "" })).toThrow(/expired/);
    expect(() => checkCallback({ params: params("error=access_denied&state=s1"), expectedState: "s1" })).toThrow(/canceled/);
    expect(() => checkCallback({ params: params("state=s1"), expectedState: "s1" })).toThrow(/no code/);
  });

  it("exchanges the code with the PKCE verifier and keeps the refresh token", async () => {
    const server = tokenServer(
      json(200, { access_token: "at", refresh_token: "rt", expires_in: 3599, scope: "https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/youtube.upload" }),
    );
    const tokens = await exchangeYouTubeCode({ client: CLIENT, code: "abc", codeVerifier: "verifier", fetchFn: server.fetchFn });

    expect(tokens).toEqual({ accessToken: "at", refreshToken: "rt" });
    expect(Object.fromEntries(server.bodies[0])).toEqual({
      client_id: CLIENT.clientId,
      client_secret: "client-secret",
      redirect_uri: CLIENT.redirectUri,
      grant_type: "authorization_code",
      code: "abc",
      code_verifier: "verifier",
    });
  });

  it("refuses a sign-in where a permission was unticked or no refresh token came back", async () => {
    const upload = "https://www.googleapis.com/auth/youtube.upload";
    const readonly = "https://www.googleapis.com/auth/youtube.readonly";
    const exchange = (body: object) =>
      exchangeYouTubeCode({ client: CLIENT, code: "abc", codeVerifier: "v", fetchFn: tokenServer(json(200, body)).fetchFn });

    await expect(exchange({ access_token: "at", refresh_token: "rt", scope: readonly })).rejects.toThrow(/permission/);
    await expect(exchange({ access_token: "at", scope: `${upload} ${readonly}` })).rejects.toThrow(/refresh token/);
  });
});

describe("refreshYouTubeAccessToken", () => {
  it("trades the refresh token for an access token", async () => {
    const server = tokenServer(json(200, { access_token: "fresh", expires_in: 3599 }));
    expect(await refreshYouTubeAccessToken({ client: CLIENT, refreshToken: "rt", fetchFn: server.fetchFn })).toBe("fresh");
    expect(Object.fromEntries(server.bodies[0])).toEqual({
      client_id: CLIENT.clientId,
      client_secret: "client-secret",
      grant_type: "refresh_token",
      refresh_token: "rt",
    });
  });

  it("says the login is gone when Google answers invalid_grant, and anything else is an API error", async () => {
    const refresh = (response: Response) =>
      refreshYouTubeAccessToken({ client: CLIENT, refreshToken: "rt", fetchFn: tokenServer(response).fetchFn });

    const expired = await refresh(json(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." })).catch((err) => err);
    expect(expired).toBeInstanceOf(YouTubeAuthError);
    expect(classifyYouTubeError(expired)).toBe("reauth");

    const down = await refresh(json(503, { error: "backend_error" })).catch((err) => err);
    expect(down).toBeInstanceOf(YouTubeApiError);
    expect(classifyYouTubeError(down)).toBe("retry");
  });
});

describe("getVideoStatistics", () => {
  it("names the counts like Instagram's insights", async () => {
    const fetchFn = (async () =>
      json(200, { items: [{ statistics: { viewCount: "1200", likeCount: "80", commentCount: "4", favoriteCount: "0" } }] })) as typeof fetch;
    expect(await getVideoStatistics({ accessToken: "at", videoId: "v1", fetchFn })).toEqual([
      { metric: "views", value: 1200 },
      { metric: "likes", value: 80 },
      { metric: "comments", value: 4 },
    ]);
  });
});

const KIB = 1024;
const META: ShortMetadata = { title: "Wait for it", description: "Watch\n\n#Shorts", privacy: "unlisted", madeForKids: false, aiGenerated: true };

function videoBytes(size: number): Uint8Array {
  return Uint8Array.from({ length: size }, (_, index) => index % 251);
}

function sourceOf(bytes: Uint8Array): UploadSource & { reads: Array<[number, number]> } {
  const reads: Array<[number, number]> = [];
  return {
    size: bytes.byteLength,
    reads,
    read: async (start, end) => {
      reads.push([start, end]);
      return bytes.slice(start, end + 1);
    },
  };
}

type ChunkFault = "ok" | "503" | "drop-after-store" | "partial";

// The resumable upload endpoint: the initial POST opens a session, PUTs with Content-Range add bytes, an empty PUT with
// "bytes */size" asks how many arrived. faults applies to the chunk PUTs in order.
function fakeUploadServer({ faults = [], statusFaults = 0, initial }: { faults?: ChunkFault[]; statusFaults?: number; initial?: Response } = {}) {
  const sessions = new Map<string, Uint8Array[]>();
  const calls: Array<{ method: string; url: string; headers: Record<string, string>; body?: unknown }> = [];
  let received = 0;
  let pendingStatusFaults = statusFaults;
  const store = new Map<string, number>();
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    const method = init?.method ?? "GET";
    if (method === "POST") {
      calls.push({ method, url, headers, body: JSON.parse(String(init?.body)) });
      if (initial) return initial;
      const session = `https://upload.test/session/${sessions.size + 1}`;
      sessions.set(session, []);
      store.set(session, 0);
      return new Response(null, { status: 200, headers: { Location: session } });
    }
    calls.push({ method, url, headers });
    if (!store.has(url)) return json(404, { error: { message: "Not Found" } });
    const range = headers["Content-Range"];
    const total = Number(range.split("/")[1]);
    const done = () => json(201, { id: "video-1", snippet: {} });
    const incomplete = (have: number) => new Response(null, { status: 308, headers: have > 0 ? { Range: `bytes=0-${have - 1}` } : {} });
    if (range.startsWith("bytes */")) {
      if (pendingStatusFaults > 0) {
        pendingStatusFaults--;
        return json(503, { error: { message: "Backend Error" } });
      }
      const have = store.get(url) as number;
      return have === total ? done() : incomplete(have);
    }
    const [start, end] = range.slice("bytes ".length).split("/")[0].split("-").map(Number);
    if (start !== store.get(url)) throw new Error(`chunk starts at ${start}, server has ${store.get(url)}`);
    const body = new Uint8Array(await (init?.body as Blob).arrayBuffer());
    expect(body.byteLength).toBe(end - start + 1);
    const fault = faults.shift() ?? "ok";
    if (fault === "503") return json(503, { error: { message: "Backend Error" } });
    const keep = fault === "partial" ? Math.floor(body.byteLength / 2) : body.byteLength;
    sessions.get(url)?.push(body.slice(0, keep));
    store.set(url, start + keep);
    received += keep;
    if (fault === "drop-after-store") throw new TypeError("fetch failed");
    return store.get(url) === total ? done() : incomplete(start + keep);
  }) as typeof fetch;
  const uploaded = (session: string) => {
    const parts = sessions.get(session) ?? [];
    const all = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
    let at = 0;
    for (const part of parts) {
      all.set(part, at);
      at += part.byteLength;
    }
    return all;
  };
  // A session an earlier run opened, holding the first `have` bytes.
  const open = (session: string, have: number) => {
    store.set(session, have);
    sessions.set(session, []);
  };
  return { fetchFn, calls, uploaded, received: () => received, open };
}

function upload(server: ReturnType<typeof fakeUploadServer>, source: UploadSource, sessionUrl: string | null = null) {
  const sessionsStored: string[] = [];
  const sleeps: number[] = [];
  const result = uploadShort({
    accessToken: "at",
    metadata: META,
    source,
    sessionUrl,
    onSession: async (url) => {
      sessionsStored.push(url);
    },
    fetchFn: server.fetchFn,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    chunkBytes: 256 * KIB,
  });
  return { result, sessionsStored, sleeps };
}

describe("uploadShort", () => {
  it("opens a session with the metadata, then sends 256 KiB chunks until YouTube returns the video", async () => {
    const bytes = videoBytes(600 * KIB);
    const server = fakeUploadServer();
    const run = upload(server, sourceOf(bytes));

    expect(await run.result).toBe("video-1");
    const [start, ...puts] = server.calls;
    expect(start.url).toBe("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status");
    expect(start.headers).toMatchObject({ "X-Upload-Content-Length": String(600 * KIB), "X-Upload-Content-Type": "video/mp4" });
    expect(start.body).toEqual({
      snippet: { title: "Wait for it", description: "Watch\n\n#Shorts", categoryId: "22" },
      status: { privacyStatus: "unlisted", selfDeclaredMadeForKids: false, containsSyntheticMedia: true },
    });
    expect(puts.map((call) => call.headers["Content-Range"])).toEqual([
      `bytes 0-${256 * KIB - 1}/${600 * KIB}`,
      `bytes ${256 * KIB}-${512 * KIB - 1}/${600 * KIB}`,
      `bytes ${512 * KIB}-${600 * KIB - 1}/${600 * KIB}`,
    ]);
    expect(run.sessionsStored).toEqual(["https://upload.test/session/1"]);
    expect(server.uploaded("https://upload.test/session/1")).toEqual(bytes);
  });

  it("after a 5xx, waits, asks the session what arrived and sends the chunk again", async () => {
    const bytes = videoBytes(600 * KIB);
    const server = fakeUploadServer({ faults: ["ok", "503"] });
    const run = upload(server, sourceOf(bytes));

    expect(await run.result).toBe("video-1");
    expect(run.sleeps).toEqual([1000]);
    expect(server.calls.map((call) => call.headers["Content-Range"] ?? "POST")).toEqual([
      "POST",
      `bytes 0-${256 * KIB - 1}/${600 * KIB}`,
      `bytes ${256 * KIB}-${512 * KIB - 1}/${600 * KIB}`,
      `bytes */${600 * KIB}`,
      `bytes ${256 * KIB}-${512 * KIB - 1}/${600 * KIB}`,
      `bytes ${512 * KIB}-${600 * KIB - 1}/${600 * KIB}`,
    ]);
    expect(server.uploaded("https://upload.test/session/1")).toEqual(bytes);
  });

  it("after a dropped connection, goes on from what YouTube already has instead of sending it twice", async () => {
    const bytes = videoBytes(600 * KIB);
    const server = fakeUploadServer({ faults: ["drop-after-store"] });
    const source = sourceOf(bytes);
    const run = upload(server, source);

    expect(await run.result).toBe("video-1");
    expect(source.reads).toEqual([
      [0, 256 * KIB - 1],
      [256 * KIB, 512 * KIB - 1],
      [512 * KIB, 600 * KIB - 1],
    ]);
    expect(server.uploaded("https://upload.test/session/1")).toEqual(bytes);
  });

  it("follows the Range of a 308 when YouTube kept only part of a chunk", async () => {
    const bytes = videoBytes(512 * KIB);
    const server = fakeUploadServer({ faults: ["partial"] });
    const source = sourceOf(bytes);

    expect(await upload(server, source).result).toBe("video-1");
    expect(source.reads[1]).toEqual([128 * KIB, 384 * KIB - 1]);
    expect(server.uploaded("https://upload.test/session/1")).toEqual(bytes);
  });

  it("resumes a stored session from its offset without opening a new one", async () => {
    const bytes = videoBytes(600 * KIB);
    const server = fakeUploadServer();
    server.open("https://upload.test/session/old", 0);
    const run = upload(server, sourceOf(bytes), "https://upload.test/session/old");

    expect(await run.result).toBe("video-1");
    expect(server.calls[0].headers["Content-Range"]).toBe(`bytes */${600 * KIB}`);
    expect(server.calls.some((call) => call.method === "POST")).toBe(false);
    expect(run.sessionsStored).toEqual([]);
  });

  it("returns the video of a stored session that had already finished", async () => {
    const server = fakeUploadServer();
    server.open("https://upload.test/session/old", 600 * KIB);
    expect(await upload(server, sourceOf(videoBytes(600 * KIB)), "https://upload.test/session/old").result).toBe("video-1");
    expect(server.calls).toHaveLength(1);
  });

  it("starts again when YouTube no longer knows the stored session", async () => {
    const bytes = videoBytes(300 * KIB);
    const server = fakeUploadServer();
    const run = upload(server, sourceOf(bytes), "https://upload.test/session/expired");

    expect(await run.result).toBe("video-1");
    expect(run.sessionsStored).toEqual(["https://upload.test/session/1"]);
    expect(server.uploaded("https://upload.test/session/1")).toEqual(bytes);
  });

  it("gives up with the 5xx after five tries with backoff, for the job to retry later", async () => {
    const server = fakeUploadServer({ faults: Array(20).fill("503") });
    const run = upload(server, sourceOf(videoBytes(300 * KIB)));

    const err = await run.result.catch((caught) => caught);
    expect(err).toBeInstanceOf(YouTubeApiError);
    expect(classifyYouTubeError(err)).toBe("retry");
    expect(run.sleeps.slice(0, 5)).toEqual([1000, 1000, 1000, 1000, 1000]);
  });

  it("backs off 1, 2, 4, 8 and 16 seconds while the session itself answers 5xx", async () => {
    const server = fakeUploadServer({ faults: ["503"], statusFaults: 10 });
    const run = upload(server, sourceOf(videoBytes(300 * KIB)));

    await expect(run.result).rejects.toBeInstanceOf(YouTubeApiError);
    expect(run.sleeps).toEqual([1000, 2000, 4000, 8000, 16000]);
  });

  it("fails at once on a quota error when opening the session", async () => {
    const server = fakeUploadServer({
      initial: json(403, { error: { code: 403, message: "The request cannot be completed because you have exceeded your quota.", errors: [{ reason: "quotaExceeded" }] } }),
    });
    const run = upload(server, sourceOf(videoBytes(300 * KIB)));

    const err = await run.result.catch((caught) => caught);
    expect(classifyYouTubeError(err)).toBe("quota");
    expect(run.sessionsStored).toEqual([]);
  });
});

describe("classifyYouTubeError", () => {
  it.each([
    [new YouTubeApiError(403, "quotaExceeded", "quota"), "quota"],
    [new YouTubeApiError(400, "uploadLimitExceeded", "limit"), "quota"],
    [new YouTubeApiError(403, "rateLimitExceeded", "slow down"), "retry"],
    [new YouTubeApiError(429, null, "too many"), "retry"],
    [new YouTubeApiError(500, "backendError", "oops"), "retry"],
    [new YouTubeApiError(401, "authError", "bad token"), "reauth"],
    [new YouTubeAuthError("Token has been expired or revoked."), "reauth"],
    [new YouTubeApiError(400, "invalidTitle", "bad title"), "fail"],
    [new YouTubeApiError(403, "forbidden", "no"), "fail"],
    [new TypeError("fetch failed"), "retry"],
    [new Error("YouTube is not set up"), "fail"],
  ])("%s is %s", (err, kind) => {
    expect(classifyYouTubeError(err)).toBe(kind);
  });
});

describe("checkYouTubePost", () => {
  const ok = { title: "Wait for it", description: "Watch\n\n#Shorts", seconds: 30, width: 1080, height: 1920 };

  it("accepts a vertical clip up to 3 minutes with a title of up to 100 characters", () => {
    expect(checkYouTubePost(ok)).toEqual([]);
    expect(checkYouTubePost({ ...ok, seconds: 180, title: "é".repeat(100) })).toEqual([]);
  });

  it("names every limit a post breaks", () => {
    expect(checkYouTubePost({ ...ok, title: " " })).toEqual(["the YouTube title is empty"]);
    expect(checkYouTubePost({ ...ok, title: "x".repeat(101) })).toEqual(["the YouTube title is over 100 characters"]);
    expect(checkYouTubePost({ ...ok, title: "a <b>" })).toEqual(["the YouTube title cannot contain < or >"]);
    expect(checkYouTubePost({ ...ok, description: "é".repeat(2501) })).toEqual(["the YouTube description is over 5,000 bytes"]);
    expect(checkYouTubePost({ ...ok, seconds: 181 })).toEqual(["a YouTube Short is at most 3 minutes long"]);
    expect(checkYouTubePost({ ...ok, width: 1920, height: 1080 })).toEqual(["a YouTube Short must be vertical or square"]);
  });
});

describe("shortsDescription", () => {
  it("adds #Shorts once", () => {
    expect(shortsDescription("Watch to the end ")).toBe("Watch to the end\n\n#Shorts");
    expect(shortsDescription("Wild #shorts")).toBe("Wild #shorts");
    expect(shortsDescription("")).toBe("#Shorts");
  });
});
