import { randomUUID } from "node:crypto";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { buildRawKey, presignUpload } from "@/lib/storage";

const CONTENT_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
};

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return new Response("sign in required", { status: 401 });

  const body = (await request.json()) as { accountId?: string; extension?: string };
  if (!body.accountId) return new Response("accountId is required", { status: 400 });

  const extension = (body.extension ?? "").toLowerCase();
  const contentType = CONTENT_TYPES[extension];
  if (!contentType) return new Response(`unsupported video type "${extension}"`, { status: 400 });

  const account = await prisma.igAccount.findFirst({
    where: { id: body.accountId, ownerId: session.user.id },
  });
  if (!account) return new Response("account not found", { status: 404 });

  const id = randomUUID();
  const rawKey = buildRawKey(id, extension);
  await prisma.media.create({ data: { id, accountId: account.id, rawKey } });

  return Response.json({ mediaId: id, uploadUrl: await presignUpload(rawKey, contentType) }, { status: 201 });
}
