import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { requireEnv } from "@/lib/env";
import { buildAuthorizeUrl } from "@/lib/ig-connect";

export async function GET() {
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
