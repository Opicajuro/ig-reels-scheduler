import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { requireEnv } from "@/lib/env";
import { buildAuthorizeUrl, metaAppConfigured } from "@/lib/ig-connect";

export async function GET() {
  // The accounts page explains this instead of linking here; this answers anyone who opens the address directly.
  if (!metaAppConfigured(process.env)) {
    return new Response(
      "Connecting Instagram needs a Meta app. Set IG_APP_ID, IG_APP_SECRET and IG_REDIRECT_URI, then restart Localirs.",
      { status: 400 },
    );
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

  redirect(
    buildAuthorizeUrl({
      appId: requireEnv("IG_APP_ID"),
      redirectUri: requireEnv("IG_REDIRECT_URI"),
      state,
    }),
  );
}
