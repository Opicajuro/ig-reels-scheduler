import type { PrismaClient } from "@/generated/prisma/client";
import {
  classifyFacebookError,
  describeFacebookError,
  finishReel,
  getReelPermalink,
  getReelStatus,
  startReel,
  uploadReelBytes,
  uploadReelFromUrl,
  type ReelStatus,
} from "./facebook";

const POLL_INTERVAL_MS = 10_000;
const MAX_POLLS = 60;

export type FacebookPublishDeps = {
  db: PrismaClient;
  postId: string;
  now: Date;
  getPageToken: (fbPageId: string) => Promise<string>;
  // A link to the post's copy in R2 for Facebook to download (file_url), or null without R2: then the video is uploaded
  // from this PC.
  stageVideo: (postId: string, videoKey: string) => Promise<string | null>;
  // Removes that copy once the post is published or failed for good.
  discardVideo: (postId: string) => Promise<void>;
  openVideo: (key: string) => Promise<{ size: number; read(start: number, end: number): Promise<Uint8Array> }>;
  fetchFn?: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  maxPolls?: number;
  // Ends this run and asks for the job to run again at the given time.
  deferUntil: (at: Date) => Promise<never>;
};

// Facebook is still publishing after the polls: thrown so the job runs again and goes on with the same video.
export class ReelStillPublishing extends Error {}

// Facebook reported an error on the Reel's upload, processing or publishing.
export class ReelFailed extends Error {}

// Publishes one Facebook Reel with the Reels Publishing API: start an upload session, upload the video (file_url from R2
// or the bytes from this PC), finish with video_state PUBLISHED, then poll the status until it is published. The video id
// is stored at the start, so a job that runs again goes on with it: an upload Facebook has is not sent again, and a
// finish Facebook has is not repeated. Rate limits, 5xx and dropped connections are thrown for pg-boss's retries with
// backoff; a login Facebook refuses marks the Page; anything else marks the post failed. Returns whether the post was
// published by this run.
export async function publishFacebookPost(deps: FacebookPublishDeps): Promise<boolean> {
  const { db, postId } = deps;
  const fetchFn = deps.fetchFn ?? fetch;
  const post = await db.fbPost.findUnique({ where: { id: postId }, include: { fbPage: true } });
  if (!post) throw new Error(`Facebook post ${postId} not found`);
  if (!["scheduled", "container_created"].includes(post.status)) return false;
  if (post.scheduledAt.getTime() > deps.now.getTime()) await deps.deferUntil(post.scheduledAt);

  const fail = async (message: string) => {
    await db.fbPost.update({ where: { id: postId }, data: { status: "failed", lastError: message, attempts: { increment: 1 } } });
    await deps.discardVideo(postId);
    return false;
  };
  if (post.fbPage.status !== "active") return fail("the Facebook Page is not connected; reconnect it on the Accounts page");

  // Conditional, so a cancel that lands now wins and nothing is uploaded.
  const { count } = await db.fbPost.updateMany({
    where: { id: postId, status: { in: ["scheduled", "container_created"] } },
    data: { status: "container_created" },
  });
  if (count === 0) return false;

  try {
    const pageToken = await deps.getPageToken(post.fbPageId);
    const pageId = post.fbPage.pageId;
    let videoId = post.videoId;
    let status: ReelStatus | null = null;
    if (videoId) {
      status = await getReelStatus({ videoId, pageToken, fetchFn });
      if (status.error) throw new ReelFailed(status.error);
    } else {
      videoId = await startReel({ pageId, pageToken, fetchFn });
      await db.fbPost.update({ where: { id: postId }, data: { videoId } });
    }

    if (status?.uploading !== "complete") {
      const fileUrl = await deps.stageVideo(postId, post.videoKey).catch((err: unknown) => {
        throw new Error(`copying the video to Cloudflare R2 failed: ${err instanceof Error ? err.message : String(err)}`);
      });
      if (fileUrl) await uploadReelFromUrl({ videoId, pageToken, fileUrl, fetchFn });
      else {
        const source = await deps.openVideo(post.videoKey);
        await uploadReelBytes({ videoId, pageToken, source, offset: status?.uploadedBytes ?? 0, fetchFn });
      }
    }

    let fbPostId = post.fbPostId;
    if (!status || status.publishing === "not_started") {
      fbPostId = await finishReel({ pageId, pageToken, videoId, description: post.description, aiGenerated: post.aiGenerated, fetchFn });
      if (fbPostId) await db.fbPost.update({ where: { id: postId }, data: { fbPostId } });
    }

    const maxPolls = deps.maxPolls ?? MAX_POLLS;
    for (let poll = 1; ; poll++) {
      const current = await getReelStatus({ videoId, pageToken, fetchFn });
      if (current.error) throw new ReelFailed(current.error);
      if (current.publishing === "complete") break;
      if (poll >= maxPolls) throw new ReelStillPublishing("Facebook is still publishing the Reel; Localirs checks again");
      await deps.sleep(deps.pollIntervalMs ?? POLL_INTERVAL_MS);
    }

    await db.fbPost.update({ where: { id: postId }, data: { status: "published", fbPostId, lastError: null } });
    await deps.discardVideo(postId);
    // The link is only for display. The Reel is already live, so a failed lookup must not fail the post.
    try {
      const permalink = await getReelPermalink({ videoId, pageToken, fetchFn });
      await db.fbPost.update({ where: { id: postId }, data: { permalink } });
    } catch (err) {
      console.warn(`Facebook link lookup failed for post ${postId}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return true;
  } catch (err) {
    if (err instanceof ReelStillPublishing) throw err;
    const kind = classifyFacebookError(err);
    if (kind === "retry") throw err;
    if (kind === "reauth") await db.fbPage.update({ where: { id: post.fbPageId }, data: { status: "reauth_required" } });
    return fail(describeFacebookError(err));
  }
}
