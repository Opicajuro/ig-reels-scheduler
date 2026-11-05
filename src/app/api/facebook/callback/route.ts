import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  checkFacebookCallback,
  checkFacebookPermissions,
  exchangeFacebookCode,
  facebookAppConfig,
  FACEBOOK_OAUTH_COOKIE,
  FACEBOOK_PICK_COOKIE,
} from "@/lib/facebook";
import { prisma } from "@/lib/prisma";
import { getSettings, sealSecret } from "@/lib/settings";
import { loadTokenKey } from "@/lib/token-crypto";

// After Facebook's login: the long-lived user token is kept, sealed, in a cookie for ten minutes while the person picks
// the Pages on /accounts/facebook. Only the Page tokens are stored.
export async function GET(request: Request) {
  const store = await cookies();
  const expectedState = store.get(FACEBOOK_OAUTH_COOKIE)?.value ?? "";
  store.delete(FACEBOOK_OAUTH_COOKIE);

  const app = facebookAppConfig(await getSettings(prisma), process.env.APP_URL);
  if (!app) return new Response("No Facebook Login for Business configuration is set up. Add it on the Settings page.", { status: 400 });

  try {
    const code = checkFacebookCallback({ params: new URL(request.url).searchParams, expectedState });
    const userToken = await exchangeFacebookCode({ app, code });
    await checkFacebookPermissions({ userToken });
    store.set(FACEBOOK_PICK_COOKIE, sealSecret(userToken, loadTokenKey()), {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production" && app.redirectUri.startsWith("https:"),
      path: "/accounts/facebook",
      maxAge: 600,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "connection failed";
    return new Response(message, { status: 400 });
  }

  redirect("/accounts/facebook");
}
