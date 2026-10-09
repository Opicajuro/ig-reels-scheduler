import { auth } from "@/auth";
import { enqueueMediaProcess } from "@/lib/queues";
import { prisma } from "@/lib/prisma";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return new Response("sign in required", { status: 401 });

  const { id } = await params;
  const media = await prisma.media.findFirst({
    where: { id, account: { ownerId: session.user.id } },
  });
  if (!media) return new Response("media not found", { status: 404 });
  if (media.status === "ready") return new Response("media is already ready", { status: 409 });

  await enqueueMediaProcess(media.id);
  return new Response(null, { status: 202 });
}
