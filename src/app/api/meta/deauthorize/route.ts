import { revokeAccount } from "@/lib/meta-callbacks";
import { prisma } from "@/lib/prisma";
import { requireEnv } from "@/lib/env";
import { parseSignedRequest } from "@/lib/signed-request";

export async function POST(request: Request) {
  const form = await request.formData();
  let payload: Record<string, unknown>;
  try {
    payload = parseSignedRequest(String(form.get("signed_request") ?? ""), requireEnv("IG_APP_SECRET"));
  } catch (err) {
    const message = err instanceof Error ? err.message : "invalid request";
    return new Response(message, { status: 400 });
  }

  await revokeAccount(prisma, String(payload.user_id));
  return new Response(null, { status: 200 });
}
