import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getOwnerId } from "@/lib/owner";
import { prisma } from "@/lib/prisma";
import { getSettings } from "@/lib/settings";
import { loadTokenKey } from "@/lib/token-crypto";
import { checkCallback, exchangeYouTubeCode, getMyChannel, youTubeAppConfig, YOUTUBE_OAUTH_COOKIE } from "@/lib/youtube";
import { saveYouTubeChannel } from "@/lib/youtube-accounts";

export async function GET(request: Request) {
  const ownerId = await getOwnerId();
  const store = await cookies();
  const [expectedState = "", verifier = ""] = (store.get(YOUTUBE_OAUTH_COOKIE)?.value ?? "").split(".");
  store.delete(YOUTUBE_OAUTH_COOKIE);

  const client = youTubeAppConfig(await getSettings(prisma), process.env.APP_URL);
  if (!client) return new Response("No Google OAuth client is set up. Add it on the Settings page.", { status: 400 });

  try {
    const code = checkCallback({ params: new URL(request.url).searchParams, expectedState });
    const tokens = await exchangeYouTubeCode({ client, code, codeVerifier: verifier });
    const channel = await getMyChannel({ accessToken: tokens.accessToken });
    await saveYouTubeChannel(prisma, loadTokenKey(), {
      ownerId,
      channelId: channel.channelId,
      title: channel.title,
      refreshToken: tokens.refreshToken,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "connection failed";
    return new Response(message, { status: 400 });
  }

  redirect("/accounts");
}
