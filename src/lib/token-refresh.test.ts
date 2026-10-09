import { describe, expect, it } from "vitest";
import { decideRefresh, refreshToken, TokenInvalidError } from "./token-refresh";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-09T12:00:00Z");

describe("decideRefresh", () => {
  it("skips a token that is not close to expiring", () => {
    expect(
      decideRefresh({ expiresAt: new Date(NOW.getTime() + 30 * DAY), lastRefreshedAt: new Date(NOW.getTime() - 2 * DAY), now: NOW }),
    ).toBe("skip");
  });

  it("refreshes a token expiring within 10 days that is at least 24 hours old", () => {
    expect(
      decideRefresh({ expiresAt: new Date(NOW.getTime() + 5 * DAY), lastRefreshedAt: new Date(NOW.getTime() - 2 * DAY), now: NOW }),
    ).toBe("refresh");
  });

  it("skips a token refreshed less than 24 hours ago, because Meta refuses it", () => {
    expect(
      decideRefresh({ expiresAt: new Date(NOW.getTime() + 5 * DAY), lastRefreshedAt: new Date(NOW.getTime() - 3600_000), now: NOW }),
    ).toBe("skip");
  });

  it("marks an already expired token for reauthorization", () => {
    expect(
      decideRefresh({ expiresAt: new Date(NOW.getTime() - 1000), lastRefreshedAt: new Date(NOW.getTime() - 61 * DAY), now: NOW }),
    ).toBe("reauth");
  });
});

function fakeFetch(status: number, body: unknown) {
  const calls: string[] = [];
  const fetchFn = async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response(JSON.stringify(body), { status });
  };
  return { fetchFn, calls };
}

describe("refreshToken", () => {
  it("returns the new token and its lifetime", async () => {
    const { fetchFn, calls } = fakeFetch(200, { access_token: "new", expires_in: 5184000 });
    const result = await refreshToken("old", fetchFn);
    expect(result).toEqual({ accessToken: "new", expiresInSeconds: 5184000 });
    expect(calls[0]).toContain("https://graph.instagram.com/refresh_access_token?");
    expect(calls[0]).toContain("grant_type=ig_refresh_token");
  });

  it("throws TokenInvalidError on Meta error 190", async () => {
    const { fetchFn } = fakeFetch(400, { error: { code: 190, message: "Session has expired" } });
    await expect(refreshToken("old", fetchFn)).rejects.toBeInstanceOf(TokenInvalidError);
  });

  it("throws the Meta message for any other error", async () => {
    const { fetchFn } = fakeFetch(500, { error: { code: 1, message: "try again" } });
    await expect(refreshToken("old", fetchFn)).rejects.toThrow("try again");
  });
});
