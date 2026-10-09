import { randomUUID } from "node:crypto";
import { requireEnv } from "@/lib/env";
import { purgeUserData } from "@/lib/meta-callbacks";
import { prisma } from "@/lib/prisma";
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

  const confirmationCode = randomUUID();
  await purgeUserData(prisma, String(payload.user_id));

  return Response.json({
    url: `${requireEnv("APP_URL")}/privacy`,
    confirmation_code: confirmationCode,
  });
}
