import type { PrismaClient } from "@/generated/prisma/client";
import { captionStyleOf, latestPull, type StatPost } from "./stats";

// The owner's published posts with their latest insight pull, newest first. A post is published at its publish time:
// the publish job waits for it.
export async function loadPublishedStats(db: PrismaClient, ownerId: string): Promise<StatPost[]> {
  const posts = await db.post.findMany({
    where: { status: "published", account: { ownerId } },
    orderBy: { scheduledAt: "desc" },
    select: {
      id: true,
      accountId: true,
      scheduledAt: true,
      account: { select: { username: true } },
      media: { select: { durationMs: true, sourceProjectId: true } },
      insights: { select: { metric: true, value: true, fetchedAt: true } },
    },
  });
  const projectIds = [...new Set(posts.flatMap((post) => (post.media.sourceProjectId ? [post.media.sourceProjectId] : [])))];
  const projects = await db.clipProject.findMany({
    where: { id: { in: projectIds }, ownerId },
    select: { id: true, withCaptions: true, captionPreset: true },
  });
  const projectById = new Map(projects.map((project) => [project.id, project]));
  return posts.map((post) => {
    // A video is ready, with its length known, before it can be published.
    if (post.media.durationMs === null) throw new Error(`published post ${post.id} has a video of unknown length`);
    return {
      id: post.id,
      accountId: post.accountId,
      username: post.account.username,
      publishedAt: post.scheduledAt,
      seconds: post.media.durationMs / 1000,
      captionStyle: captionStyleOf(
        post.media.sourceProjectId,
        post.media.sourceProjectId ? projectById.get(post.media.sourceProjectId) : undefined,
      ),
      metrics: latestPull(post.insights),
    };
  });
}
