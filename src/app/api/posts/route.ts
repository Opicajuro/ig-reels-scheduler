import { auth } from "@/auth";
import { getPublishQueue } from "@/lib/queues";
import { prisma } from "@/lib/prisma";
import { createScheduledPost, type PostInput } from "@/lib/posts";

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return new Response("sign in required", { status: 401 });

  try {
    const post = await createScheduledPost({
      db: prisma,
      queue: getPublishQueue(),
      ownerId: session.user.id,
      input: (await request.json()) as PostInput,
      now: new Date(),
    });
    return Response.json(post, { status: 201 });
  } catch (err) {
    return new Response(err instanceof Error ? err.message : "could not schedule post", { status: 400 });
  }
}
