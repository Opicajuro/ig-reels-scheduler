import type { PrismaClient } from "@/generated/prisma/client";
import {
  classifyYouTubeError,
  describeYouTubeError,
  uploadShort,
  youTubeVideoUrl,
  type UploadSource,
} from "./youtube";

export type YouTubePublishDeps = {
  db: PrismaClient;
  postId: string;
  now: Date;
  getAccessToken: (ytAccountId: string) => Promise<string>;
  openVideo: (key: string) => Promise<UploadSource>;
  fetchFn?: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  chunkBytes?: number;
  // Ends this run and asks for the job to run again at the given time.
  deferUntil: (at: Date) => Promise<never>;
};

// Uploads one YouTube post. A 5xx or a dropped connection is thrown, so pg-boss runs the job again and the upload goes
// on from its stored session; any other error marks the post failed, and an expired login marks the channel too.
// Returns whether the post was published by this run.
export async function publishYouTubePost(deps: YouTubePublishDeps): Promise<boolean> {
  const { db, postId } = deps;
  const post = await db.ytPost.findUnique({ where: { id: postId }, include: { ytAccount: true } });
  if (!post) throw new Error(`YouTube post ${postId} not found`);
  if (post.videoId || !["scheduled", "container_created"].includes(post.status)) return false;
  if (post.scheduledAt.getTime() > deps.now.getTime()) await deps.deferUntil(post.scheduledAt);

  const fail = async (message: string) => {
    await db.ytPost.update({
      where: { id: postId },
      data: { status: "failed", lastError: message, attempts: { increment: 1 } },
    });
    return false;
  };
  if (post.ytAccount.status !== "active") return fail("the YouTube channel is not connected; reconnect it on the Accounts page");

  // Conditional, so a cancel that lands now wins and nothing is uploaded.
  const { count } = await db.ytPost.updateMany({
    where: { id: postId, status: { in: ["scheduled", "container_created"] } },
    data: { status: "container_created" },
  });
  if (count === 0) return false;

  try {
    const accessToken = await deps.getAccessToken(post.ytAccountId);
    const source = await deps.openVideo(post.videoKey);
    const videoId = await uploadShort({
      accessToken,
      metadata: {
        title: post.title,
        description: post.description,
        privacy: post.privacy,
        madeForKids: post.madeForKids,
        aiGenerated: post.aiGenerated,
      },
      source,
      sessionUrl: post.uploadUrl,
      onSession: async (uploadUrl) => {
        await db.ytPost.update({ where: { id: postId }, data: { uploadUrl } });
      },
      fetchFn: deps.fetchFn,
      sleep: deps.sleep,
      chunkBytes: deps.chunkBytes,
    });
    await db.ytPost.update({
      where: { id: postId },
      data: { videoId, url: youTubeVideoUrl(videoId), status: "published", uploadUrl: null, lastError: null },
    });
    return true;
  } catch (err) {
    const kind = classifyYouTubeError(err);
    if (kind === "retry") throw err;
    if (kind === "reauth") await db.ytAccount.update({ where: { id: post.ytAccountId }, data: { status: "reauth_required" } });
    return fail(describeYouTubeError(err));
  }
}
