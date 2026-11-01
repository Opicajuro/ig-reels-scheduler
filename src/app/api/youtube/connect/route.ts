import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getSettings } from "@/lib/settings";
import {
  buildYouTubeAuthorizeUrl,
  createOAuthState,
  createPkce,
  youTubeAppConfig,
  YOUTUBE_CALLBACK_PATH,
  YOUTUBE_OAUTH_COOKIE,
} from "@/lib/youtube";

export async function GET(request: Request) {
  const client = youTubeAppConfig(await getSettings(prisma), process.env.APP_URL);
  // The accounts page explains this instead of linking here; this answers anyone who opens the address directly.
  if (!client) {
    return new Response("Connecting YouTube needs a Google OAuth client. Add its client ID and secret on the Settings page.", {
      status: 400,
    });
  }

  // The cookie must be set on the host Google sends the browser back to, such as localhost rather than 127.0.0.1.
  const callbackOrigin = new URL(client.redirectUri).origin;
  if (new URL(request.url).origin !== callbackOrigin) redirect(new URL("/api/youtube/connect", callbackOrigin).toString());

  const state = createOAuthState();
  const pkce = createPkce();
  const store = await cookies();
  store.set(YOUTUBE_OAUTH_COOKIE, `${state}.${pkce.verifier}`, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production" && callbackOrigin.startsWith("https:"),
    path: YOUTUBE_CALLBACK_PATH,
    maxAge: 600,
  });

  redirect(buildYouTubeAuthorizeUrl({ clientId: client.clientId, redirectUri: client.redirectUri, state, codeChallenge: pkce.challenge }));
}
