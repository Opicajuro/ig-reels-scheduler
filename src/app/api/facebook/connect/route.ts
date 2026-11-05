import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  buildFacebookAuthorizeUrl,
  createFacebookState,
  facebookAppConfig,
  FACEBOOK_CALLBACK_PATH,
  FACEBOOK_OAUTH_COOKIE,
} from "@/lib/facebook";
import { prisma } from "@/lib/prisma";
import { getSettings } from "@/lib/settings";

export async function GET(request: Request) {
  const app = facebookAppConfig(await getSettings(prisma), process.env.APP_URL);
  // The accounts page explains this instead of linking here; this answers anyone who opens the address directly.
  if (!app) {
    return new Response(
      "Connecting a Facebook Page needs the Meta app and its Facebook Login for Business configuration ID. Add them on the Settings page.",
      { status: 400 },
    );
  }

  // The cookie must be set on the host Facebook sends the browser back to, such as localhost rather than 127.0.0.1.
  const callbackOrigin = new URL(app.redirectUri).origin;
  if (new URL(request.url).origin !== callbackOrigin) redirect(new URL("/api/facebook/connect", callbackOrigin).toString());

  const state = createFacebookState();
  const store = await cookies();
  store.set(FACEBOOK_OAUTH_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production" && callbackOrigin.startsWith("https:"),
    path: FACEBOOK_CALLBACK_PATH,
    maxAge: 600,
  });

  redirect(buildFacebookAuthorizeUrl({ appId: app.appId, configId: app.configId, redirectUri: app.redirectUri, state }));
}
