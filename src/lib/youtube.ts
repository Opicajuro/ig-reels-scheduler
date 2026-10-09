const UPLOAD_SCOPE = "https://www.googleapis.com/auth/youtube.upload";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const UPLOAD_URL = "https://www.googleapis.com/upload/youtube/v3/videos";
const SHORTS_CATEGORY_ID = "22";

export type YouTubeOAuthConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetchFn?: typeof fetch;
};

export function buildYouTubeAuthorizeUrl({
  clientId,
  redirectUri,
  state,
}: Pick<YouTubeOAuthConfig, "clientId" | "redirectUri"> & { state: string }): string {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", UPLOAD_SCOPE);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", state);
  return url.toString();
}

async function postToken(body: URLSearchParams, fetchFn: typeof fetch) {
  const response = await fetchFn(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!response.ok) {
    throw new Error(json.error_description ?? json.error ?? `Google token request failed with ${response.status}`);
  }
  return json;
}

export async function exchangeYouTubeCode({
  clientId,
  clientSecret,
  redirectUri,
  code,
  fetchFn = fetch,
}: YouTubeOAuthConfig & { code: string }) {
  const json = await postToken(
    new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      code,
    }),
    fetchFn,
  );
  return {
    accessToken: json.access_token as string,
    refreshToken: json.refresh_token as string,
    expiresInSeconds: json.expires_in as number,
  };
}

export async function refreshYouTubeAccessToken({
  clientId,
  clientSecret,
  refreshToken,
  fetchFn = fetch,
}: Pick<YouTubeOAuthConfig, "clientId" | "clientSecret" | "fetchFn"> & { refreshToken: string }) {
  const json = await postToken(
    new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
    fetchFn,
  );
  return { accessToken: json.access_token as string, expiresInSeconds: json.expires_in as number };
}

export async function uploadShort({
  accessToken,
  title,
  description,
  publishAt,
  video,
  fetchFn = fetch,
}: {
  accessToken: string;
  title: string;
  description: string;
  publishAt: string;
  video: Uint8Array<ArrayBuffer>;
  fetchFn?: typeof fetch;
}): Promise<{ videoId: string }> {
  const start = await fetchFn(`${UPLOAD_URL}?uploadType=resumable&part=snippet,status`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Length": String(video.byteLength),
      "X-Upload-Content-Type": "video/mp4",
    },
    body: JSON.stringify({
      snippet: { title, description, categoryId: SHORTS_CATEGORY_ID },
      status: { privacyStatus: "private", publishAt, selfDeclaredMadeForKids: false },
    }),
  });
  if (!start.ok) throw new Error(`YouTube upload start failed with ${start.status}`);
  const sessionUrl = start.headers.get("Location");
  if (!sessionUrl) throw new Error("YouTube returned no upload session");

  const finish = await fetchFn(sessionUrl, {
    method: "PUT",
    headers: { "Content-Type": "video/mp4" },
    body: new Blob([video], { type: "video/mp4" }),
  });
  const json = (await finish.json()) as { id?: string; error?: { message?: string } };
  if (!finish.ok || !json.id) {
    throw new Error(json.error?.message ?? `YouTube upload failed with ${finish.status}`);
  }
  return { videoId: json.id };
}
