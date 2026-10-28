import { randomUUID } from "node:crypto";
import { requireEnv } from "@/lib/env";
import { purgeUserData } from "@/lib/meta-callbacks";
import { deleteObject } from "@/lib/storage";
import { getPublishQueue } from "@/lib/queues";
import { prisma } from "@/lib/prisma";
import { getSettings } from "@/lib/settings";
import { parseSignedRequest } from "@/lib/signed-request";

export async function POST(request: Request) {
  const form = await request.formData();
  const { metaAppSecret } = await getSettings(prisma);
  if (!metaAppSecret) return new Response("no Meta app is set up", { status: 400 });
  let payload: Record<string, unknown>;
  try {
    payload = parseSignedRequest(String(form.get("signed_request") ?? ""), metaAppSecret);
  } catch (err) {
    const message = err instanceof Error ? err.message : "invalid request";
    return new Response(message, { status: 400 });
  }

  const confirmationCode = randomUUID();
  await purgeUserData(prisma, getPublishQueue(), deleteObject, String(payload.user_id));

  return Response.json({
    url: `${requireEnv("APP_URL")}/privacy`,
    confirmation_code: confirmationCode,
  });
}
