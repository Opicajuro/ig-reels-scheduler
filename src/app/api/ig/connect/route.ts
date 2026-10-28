import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { buildAuthorizeUrl, metaAppConfig } from "@/lib/ig-connect";
import { prisma } from "@/lib/prisma";
import { getSettings } from "@/lib/settings";

export async function GET() {
  const app = metaAppConfig(await getSettings(prisma), process.env.IG_REDIRECT_URI);
  // The accounts page explains this instead of linking here; this answers anyone who opens the address directly.
  if (!app) {
    return new Response("Connecting Instagram needs a Meta app. Add its app ID and secret on the Settings page.", {
      status: 400,
    });
  }

  const state = randomUUID();
  const store = await cookies();
  store.set("ig_oauth_state", state, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/api/ig/callback",
    maxAge: 600,
  });

  redirect(buildAuthorizeUrl({ appId: app.appId, redirectUri: app.redirectUri, state }));
}
