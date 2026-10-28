import { revokeAccount } from "@/lib/meta-callbacks";
import { prisma } from "@/lib/prisma";
import { getPublishQueue } from "@/lib/queues";
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

  await revokeAccount(prisma, getPublishQueue(), String(payload.user_id));
  return new Response(null, { status: 200 });
}
