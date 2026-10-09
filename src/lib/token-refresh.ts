const DAY_MS = 24 * 60 * 60 * 1000;
const REFRESH_WINDOW_MS = 10 * DAY_MS;
const MIN_TOKEN_AGE_MS = DAY_MS;
const INVALID_TOKEN_CODE = 190;

export type RefreshDecision = "skip" | "refresh" | "reauth";

export class TokenInvalidError extends Error {}

export function decideRefresh({
  expiresAt,
  lastRefreshedAt,
  now,
}: {
  expiresAt: Date;
  lastRefreshedAt: Date | null;
  now: Date;
}): RefreshDecision {
  if (expiresAt.getTime() <= now.getTime()) return "reauth";
  if (expiresAt.getTime() - now.getTime() > REFRESH_WINDOW_MS) return "skip";
  if (lastRefreshedAt && now.getTime() - lastRefreshedAt.getTime() < MIN_TOKEN_AGE_MS) return "skip";
  return "refresh";
}

export async function refreshToken(
  token: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ accessToken: string; expiresInSeconds: number }> {
  const url = new URL("https://graph.instagram.com/refresh_access_token");
  url.searchParams.set("grant_type", "ig_refresh_token");
  url.searchParams.set("access_token", token);

  const response = await fetchFn(url.toString());
  const body = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
    error?: { code?: number; message?: string };
  };

  if (!response.ok) {
    const message = body.error?.message ?? `token refresh failed with ${response.status}`;
    if (body.error?.code === INVALID_TOKEN_CODE) throw new TokenInvalidError(message);
    throw new Error(message);
  }

  return { accessToken: body.access_token as string, expiresInSeconds: body.expires_in as number };
}
