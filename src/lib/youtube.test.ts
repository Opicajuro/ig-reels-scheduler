import { describe, expect, it } from "vitest";
import {
  buildYouTubeAuthorizeUrl,
  exchangeYouTubeCode,
  refreshYouTubeAccessToken,
  uploadShort,
} from "./youtube";

const CONFIG = {
  clientId: "client-id.apps.googleusercontent.com",
  clientSecret: "client-secret",
  redirectUri: "http://localhost:3000/api/youtube/callback",
};

type Route = { status?: number; body?: unknown; headers?: Record<string, string> };

function fakeFetch(routes: Record<string, Route>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchFn = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const key = Object.keys(routes).find((prefix) => url.startsWith(prefix));
    if (!key) throw new Error(`unexpected request: ${url}`);
    const route = routes[key];
    return new Response(route.body === undefined ? null : JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: route.headers,
    });
  };
  return { fetchFn, calls };
}

describe("buildYouTubeAuthorizeUrl", () => {
  it("asks for upload access with offline refresh and the given state", () => {
    const url = new URL(buildYouTubeAuthorizeUrl({ ...CONFIG, state: "csrf-1" }));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe(CONFIG.clientId);
    expect(url.searchParams.get("redirect_uri")).toBe(CONFIG.redirectUri);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/youtube.upload");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("state")).toBe("csrf-1");
  });
});

describe("exchangeYouTubeCode", () => {
  it("returns the access token, refresh token, and lifetime", async () => {
    const { fetchFn, calls } = fakeFetch({
      "https://oauth2.googleapis.com/token": {
        body: { access_token: "ya29-access", refresh_token: "1//refresh", expires_in: 3599 },
      },
    });
    const tokens = await exchangeYouTubeCode({ ...CONFIG, code: "code-1", fetchFn });
    expect(tokens).toEqual({ accessToken: "ya29-access", refreshToken: "1//refresh", expiresInSeconds: 3599 });
    expect(String(calls[0].init?.body)).toContain("grant_type=authorization_code");
  });

  it("throws the Google error message when the code is rejected", async () => {
    const { fetchFn } = fakeFetch({
      "https://oauth2.googleapis.com/token": {
        status: 400,
        body: { error: "invalid_grant", error_description: "Bad Request" },
      },
    });
    await expect(exchangeYouTubeCode({ ...CONFIG, code: "stale", fetchFn })).rejects.toThrow("Bad Request");
  });
});

describe("refreshYouTubeAccessToken", () => {
  it("trades a refresh token for a new access token", async () => {
    const { fetchFn, calls } = fakeFetch({
      "https://oauth2.googleapis.com/token": { body: { access_token: "ya29-new", expires_in: 3599 } },
    });
    const result = await refreshYouTubeAccessToken({ ...CONFIG, refreshToken: "1//refresh", fetchFn });
    expect(result).toEqual({ accessToken: "ya29-new", expiresInSeconds: 3599 });
    expect(String(calls[0].init?.body)).toContain("grant_type=refresh_token");
  });
});

describe("uploadShort", () => {
  const video = new Uint8Array([0, 1, 2, 3]);
  const publishAt = "2026-10-12T18:00:00Z";

  it("starts a resumable upload with a scheduled private video, then sends the bytes", async () => {
    const { fetchFn, calls } = fakeFetch({
      "https://www.googleapis.com/upload/youtube/v3/videos": {
        body: null,
        headers: { Location: "https://upload.example/session-1" },
      },
      "https://upload.example/session-1": { body: { id: "yt-video-1" } },
    });

    const result = await uploadShort({
      accessToken: "ya29-access",
      title: "Best clutch #Shorts",
      description: "Clip from last night's stream",
      publishAt,
      video,
      fetchFn,
    });

    expect(result).toEqual({ videoId: "yt-video-1" });
    const init = calls[0].init as RequestInit;
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer ya29-access");
    expect(calls[0].url).toContain("uploadType=resumable");
    const metadata = JSON.parse(String(init.body));
    expect(metadata.snippet.title).toBe("Best clutch #Shorts");
    expect(metadata.status.privacyStatus).toBe("private");
    expect(metadata.status.publishAt).toBe(publishAt);
    expect(calls[1].init?.method).toBe("PUT");
    expect((calls[1].init?.body as Blob).size).toBe(video.byteLength);
  });

  it("throws when Google does not return an upload session", async () => {
    const { fetchFn } = fakeFetch({
      "https://www.googleapis.com/upload/youtube/v3/videos": { body: null },
    });
    await expect(
      uploadShort({ accessToken: "t", title: "x", description: "", publishAt, video, fetchFn }),
    ).rejects.toThrow("no upload session");
  });
});
