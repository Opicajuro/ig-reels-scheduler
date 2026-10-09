const SCOPES = [
  "instagram_business_basic",
  "instagram_business_content_publish",
  "instagram_business_manage_insights",
];
const PUBLISHING_ACCOUNT_TYPES = ["BUSINESS", "MEDIA_CREATOR"];

export type OAuthConfig = {
  appId: string;
  appSecret: string;
  redirectUri: string;
  fetchFn?: typeof fetch;
};

export type ConnectedAccount = {
  igUserId: string;
  username: string;
  accountType: string;
  accessToken: string;
  expiresInSeconds: number;
};

export function buildAuthorizeUrl({
  appId,
  redirectUri,
  state,
}: Pick<OAuthConfig, "appId" | "redirectUri"> & { state: string }): string {
  const url = new URL("https://www.instagram.com/oauth/authorize");
  url.searchParams.set("client_id", appId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPES.join(","));
  url.searchParams.set("state", state);
  return url.toString();
}

async function callMeta(
  input: string,
  init: RequestInit,
  fetchFn: typeof fetch,
): Promise<Record<string, unknown>> {
  const response = await fetchFn(input, init);
  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(String(body.error_message ?? `Meta request failed with ${response.status}`));
  }
  return body;
}

async function exchangeCode(config: OAuthConfig, code: string) {
  const form = new URLSearchParams({
    client_id: config.appId,
    client_secret: config.appSecret,
    grant_type: "authorization_code",
    redirect_uri: config.redirectUri,
    code,
  });
  return (await callMeta(
    "https://api.instagram.com/oauth/access_token",
    { method: "POST", body: form },
    config.fetchFn ?? fetch,
  )) as { access_token: string };
}

async function exchangeForLongLivedToken(config: OAuthConfig, shortToken: string) {
  const url = new URL("https://graph.instagram.com/access_token");
  url.searchParams.set("grant_type", "ig_exchange_token");
  url.searchParams.set("client_secret", config.appSecret);
  url.searchParams.set("access_token", shortToken);
  return (await callMeta(url.toString(), {}, config.fetchFn ?? fetch)) as {
    access_token: string;
    expires_in: number;
  };
}

async function fetchProfile(config: OAuthConfig, token: string) {
  const url = "https://graph.instagram.com/me?fields=user_id,username,account_type";
  return (await callMeta(
    url,
    { headers: { Authorization: `Bearer ${token}` } },
    config.fetchFn ?? fetch,
  )) as { user_id: string; username: string; account_type: string };
}

export async function connectAccount(
  config: OAuthConfig & { code: string; state: string; expectedState: string },
): Promise<ConnectedAccount> {
  if (!config.expectedState || config.state !== config.expectedState) {
    throw new Error("state does not match");
  }

  const shortLived = await exchangeCode(config, config.code);
  const longLived = await exchangeForLongLivedToken(config, shortLived.access_token);
  const profile = await fetchProfile(config, longLived.access_token);

  if (!PUBLISHING_ACCOUNT_TYPES.includes(profile.account_type)) {
    throw new Error("only Business or Creator accounts can be connected");
  }

  return {
    igUserId: profile.user_id,
    username: profile.username,
    accountType: profile.account_type,
    accessToken: longLived.access_token,
    expiresInSeconds: longLived.expires_in,
  };
}
