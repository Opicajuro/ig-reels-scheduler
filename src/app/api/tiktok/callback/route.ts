import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getOwnerId } from "@/lib/owner";
import { prisma } from "@/lib/prisma";
import { getSettings } from "@/lib/settings";
import { checkTikTokCallback, exchangeTikTokCode, getTikTokUser, tikTokAppConfig, TIKTOK_OAUTH_COOKIE } from "@/lib/tiktok";
import { saveTikTokAccount } from "@/lib/tiktok-accounts";
import { loadTokenKey } from "@/lib/token-crypto";

export async function GET(request: Request) {
  const ownerId = await getOwnerId();
  const store = await cookies();
  const [expectedState = "", verifier = ""] = (store.get(TIKTOK_OAUTH_COOKIE)?.value ?? "").split(".");
  store.delete(TIKTOK_OAUTH_COOKIE);

  const app = tikTokAppConfig(await getSettings(prisma), process.env.APP_URL);
  if (!app) return new Response("No TikTok app is set up. Add it on the Settings page.", { status: 400 });

  try {
    const code = checkTikTokCallback({ params: new URL(request.url).searchParams, expectedState });
    const tokens = await exchangeTikTokCode({ app, code, codeVerifier: verifier, now: new Date() });
    const user = await getTikTokUser({ accessToken: tokens.accessToken });
    if (user.openId !== tokens.openId) throw new Error("TikTok returned another account than the one that signed in");
    await saveTikTokAccount(prisma, loadTokenKey(), { ownerId, displayName: user.displayName, tokens });
  } catch (err) {
    const message = err instanceof Error ? err.message : "connection failed";
    return new Response(message, { status: 400 });
  }

  redirect("/accounts");
}
