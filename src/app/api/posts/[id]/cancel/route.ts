import { auth } from "@/auth";
import { getPublishQueue } from "@/lib/queues";
import { prisma } from "@/lib/prisma";
import { cancelScheduledPost } from "@/lib/posts";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return new Response("sign in required", { status: 401 });

  const { id } = await params;
  try {
    await cancelScheduledPost({ db: prisma, queue: getPublishQueue(), ownerId: session.user.id, postId: id });
    return new Response(null, { status: 204 });
  } catch (err) {
    return new Response(err instanceof Error ? err.message : "could not cancel post", { status: 400 });
  }
}
