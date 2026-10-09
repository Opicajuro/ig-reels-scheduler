import { describe, expect, it } from "vitest";
import { buildAuthorizeUrl, connectAccount } from "./ig-connect";

const CONFIG = {
  appId: "123",
  appSecret: "shh",
  redirectUri: "http://localhost:3000/api/ig/callback",
};

function fakeFetch(routes: Record<string, { status?: number; body: unknown }>) {
  const calls: string[] = [];
  const fetchFn = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    const key = Object.keys(routes).find((prefix) => url.startsWith(prefix));
    if (!key) throw new Error(`unexpected request: ${url}`);
    const route = routes[key];
    return new Response(JSON.stringify(route.body), { status: route.status ?? 200 });
  };
  return { fetchFn, calls };
}

const SHORT_TOKEN = { access_token: "short", user_id: 17841 };
const LONG_TOKEN = { access_token: "long", token_type: "bearer", expires_in: 5184000 };
const BUSINESS_PROFILE = { user_id: "17841", username: "streamer", account_type: "BUSINESS" };

describe("buildAuthorizeUrl", () => {
  it("asks for the three Instagram Login scopes with the given state", () => {
    const url = new URL(buildAuthorizeUrl({ ...CONFIG, state: "csrf-1" }));
    expect(url.origin + url.pathname).toBe("https://www.instagram.com/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("123");
    expect(url.searchParams.get("redirect_uri")).toBe(CONFIG.redirectUri);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBe("csrf-1");
    expect(url.searchParams.get("scope")).toBe(
      "instagram_business_basic,instagram_business_content_publish,instagram_business_manage_insights",
    );
  });
});

describe("connectAccount", () => {
  it("exchanges the code, gets a long-lived token, and returns the profile", async () => {
    const { fetchFn, calls } = fakeFetch({
      "https://api.instagram.com/oauth/access_token": { body: SHORT_TOKEN },
      "https://graph.instagram.com/access_token": { body: LONG_TOKEN },
      "https://graph.instagram.com/me": { body: BUSINESS_PROFILE },
    });

    const account = await connectAccount({
      ...CONFIG,
      code: "code-1",
      state: "csrf-1",
      expectedState: "csrf-1",
      fetchFn,
    });

    expect(account).toEqual({
      igUserId: "17841",
      username: "streamer",
      accountType: "BUSINESS",
      accessToken: "long",
      expiresInSeconds: 5184000,
    });
    expect(calls).toHaveLength(3);
  });

  it("rejects a state that does not match, before calling Meta", async () => {
    const { fetchFn, calls } = fakeFetch({});
    await expect(
      connectAccount({ ...CONFIG, code: "c", state: "forged", expectedState: "csrf-1", fetchFn }),
    ).rejects.toThrow("state does not match");
    expect(calls).toHaveLength(0);
  });

  it("rejects a callback when no state was stored for this browser", async () => {
    const { fetchFn, calls } = fakeFetch({});
    await expect(
      connectAccount({ ...CONFIG, code: "c", state: "", expectedState: "", fetchFn }),
    ).rejects.toThrow("state does not match");
    expect(calls).toHaveLength(0);
  });

  it("rejects personal accounts, which cannot publish", async () => {
    const { fetchFn } = fakeFetch({
      "https://api.instagram.com/oauth/access_token": { body: SHORT_TOKEN },
      "https://graph.instagram.com/access_token": { body: LONG_TOKEN },
      "https://graph.instagram.com/me": { body: { ...BUSINESS_PROFILE, account_type: "PERSONAL" } },
    });
    await expect(
      connectAccount({ ...CONFIG, code: "c", state: "s", expectedState: "s", fetchFn }),
    ).rejects.toThrow("only Business or Creator accounts can be connected");
  });

  it("surfaces a Meta error response instead of continuing", async () => {
    const { fetchFn } = fakeFetch({
      "https://api.instagram.com/oauth/access_token": {
        status: 400,
        body: { error_type: "OAuthException", error_message: "code expired" },
      },
    });
    await expect(
      connectAccount({ ...CONFIG, code: "c", state: "s", expectedState: "s", fetchFn }),
    ).rejects.toThrow("code expired");
  });
});
