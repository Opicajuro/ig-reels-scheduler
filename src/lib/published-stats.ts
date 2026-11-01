import type { PrismaClient } from "@/generated/prisma/client";
import { captionStyleOf, latestPull, sourceOf, type StatPost } from "./stats";

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
      media: { select: { durationMs: true, sourceProjectId: true, sourceClipId: true } },
      insights: { select: { metric: true, value: true, fetchedAt: true } },
    },
  });
  const projectIds = [...new Set(posts.flatMap((post) => (post.media.sourceProjectId ? [post.media.sourceProjectId] : [])))];
  const projects = await db.clipProject.findMany({
    where: { id: { in: projectIds }, ownerId },
    select: { id: true, withCaptions: true, captionPreset: true, aiVideos: true, slideshows: true },
  });
  const projectById = new Map(projects.map((project) => [project.id, project]));
  // A slideshow's caption style is its own, not its project's.
  const clipIds = [...new Set(posts.flatMap((post) => (post.media.sourceClipId ? [post.media.sourceClipId] : [])))];
  const slideshows = await db.slideshowJob.findMany({
    where: { ownerId, clipId: { in: clipIds } },
    select: { clipId: true, captionPreset: true },
  });
  const slideshowPresetByClip = new Map(slideshows.map((job) => [job.clipId, job.captionPreset]));
  return posts.map((post) => {
    // A video is ready, with its length known, before it can be published.
    if (post.media.durationMs === null) throw new Error(`published post ${post.id} has a video of unknown length`);
    const project = post.media.sourceProjectId ? projectById.get(post.media.sourceProjectId) : undefined;
    return {
      id: post.id,
      accountId: post.accountId,
      username: post.account.username,
      publishedAt: post.scheduledAt,
      seconds: post.media.durationMs / 1000,
      captionStyle: captionStyleOf(
        post.media.sourceProjectId,
        project,
        post.media.sourceClipId ? slideshowPresetByClip.get(post.media.sourceClipId) : undefined,
      ),
      source: sourceOf(post.media.sourceProjectId, project),
      metrics: latestPull(post.insights),
    };
  });
}
