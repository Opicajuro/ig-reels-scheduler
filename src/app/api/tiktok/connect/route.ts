import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getSettings } from "@/lib/settings";
import {
  buildTikTokAuthorizeUrl,
  createTikTokPkce,
  createTikTokState,
  tikTokAppConfig,
  TIKTOK_CALLBACK_PATH,
  TIKTOK_OAUTH_COOKIE,
} from "@/lib/tiktok";

export async function GET(request: Request) {
  const app = tikTokAppConfig(await getSettings(prisma), process.env.APP_URL);
  // The accounts page explains this instead of linking here; this answers anyone who opens the address directly.
  if (!app) {
    return new Response("Connecting TikTok needs your TikTok app. Add its client key and secret on the Settings page.", { status: 400 });
  }

  // The cookie must be set on the host TikTok sends the browser back to, such as localhost rather than 127.0.0.1.
  const callbackOrigin = new URL(app.redirectUri).origin;
  if (new URL(request.url).origin !== callbackOrigin) redirect(new URL("/api/tiktok/connect", callbackOrigin).toString());

  const state = createTikTokState();
  const pkce = createTikTokPkce();
  const store = await cookies();
  store.set(TIKTOK_OAUTH_COOKIE, `${state}.${pkce.verifier}`, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production" && callbackOrigin.startsWith("https:"),
    path: TIKTOK_CALLBACK_PATH,
    maxAge: 600,
  });

  redirect(buildTikTokAuthorizeUrl({ clientKey: app.clientKey, redirectUri: app.redirectUri, state, codeChallenge: pkce.challenge }));
}
