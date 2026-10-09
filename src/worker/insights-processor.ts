import type { Job } from "pg-boss";
import { prisma } from "@/lib/prisma";
import { getInsights, pullInsights } from "@/lib/insights";
import { accessTokenFor } from "./publish-processor";

export async function processInsightsJob([job]: Job<{ postId: string }>[]) {
  const post = await prisma.post.findUnique({ where: { id: job.data.postId } });
  if (!post?.igMediaId) throw new Error(`post ${job.data.postId} has no published media`);

  const metrics = await getInsights({
    igMediaId: post.igMediaId,
    token: await accessTokenFor(post.accountId),
  });
  await pullInsights({ db: prisma, postId: post.id, metrics, now: new Date() });
}
