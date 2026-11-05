import type { PrismaClient } from "@/generated/prisma/client";
import {
  awaitInbox,
  classifyTikTokError,
  describeTikTokError,
  fetchPublishStatus,
  initInboxUpload,
  IN_INBOX,
  planChunks,
  TikTokPublishFailed,
  uploadChunks,
  type UploadSource,
} from "./tiktok";

export type TikTokPublishDeps = {
  db: PrismaClient;
  postId: string;
  now: Date;
  getAccessToken: (ttAccountId: string) => Promise<string>;
  openVideo: (key: string) => Promise<UploadSource>;
  fetchFn?: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  chunkBytes?: number;
  pollIntervalMs?: number;
  maxPolls?: number;
  // Ends this run and asks for the job to run again at the given time.
  deferUntil: (at: Date) => Promise<never>;
};

// Sends one clip to a TikTok account's inbox as a draft: init the upload (FILE_UPLOAD), PUT the chunks from local
// storage, then poll the status until TikTok has put it in the inbox, where the person finishes and posts it in the
// TikTok app. The upload's publish id and link are stored, so a job that runs again goes on from the chunks TikTok
// already has instead of starting a second draft. Rate limits, 5xx and dropped connections are thrown for pg-boss's
// retries; a login TikTok refuses marks the account; anything else marks the post failed. Returns whether the draft was
// sent by this run.
export async function publishTikTokPost(deps: TikTokPublishDeps): Promise<boolean> {
  const { db, postId } = deps;
  const fetchFn = deps.fetchFn ?? fetch;
  const post = await db.ttPost.findUnique({ where: { id: postId }, include: { ttAccount: true } });
  if (!post) throw new Error(`TikTok post ${postId} not found`);
  if (!["scheduled", "container_created"].includes(post.status)) return false;
  if (post.scheduledAt.getTime() > deps.now.getTime()) await deps.deferUntil(post.scheduledAt);

  const fail = async (message: string) => {
    await db.ttPost.update({ where: { id: postId }, data: { status: "failed", lastError: message, attempts: { increment: 1 } } });
    return false;
  };
  if (post.ttAccount.status !== "active") return fail("the TikTok account is not connected; reconnect it on the Accounts page");

  // Conditional, so a cancel that lands now wins and nothing is uploaded.
  const { count } = await db.ttPost.updateMany({
    where: { id: postId, status: { in: ["scheduled", "container_created"] } },
    data: { status: "container_created" },
  });
  if (count === 0) return false;

  try {
    const accessToken = await deps.getAccessToken(post.ttAccountId);
    const source = await deps.openVideo(post.videoKey);
    const plan = planChunks(source.size, deps.chunkBytes);
    let { publishId, uploadUrl } = post;
    let fromChunk = 0;
    if (publishId && uploadUrl) {
      const status = await fetchPublishStatus({ accessToken, publishId, fetchFn });
      if (status.status === "FAILED") throw new TikTokPublishFailed(status.failReason ?? "unknown");
      fromChunk = IN_INBOX.has(status.status) || status.uploadedBytes >= source.size
        ? plan.totalChunks
        : Math.min(Math.floor(status.uploadedBytes / plan.chunkSize), plan.totalChunks - 1);
    } else {
      ({ publishId, uploadUrl } = await initInboxUpload({ accessToken, size: source.size, plan, fetchFn }));
      await db.ttPost.update({ where: { id: postId }, data: { publishId, uploadUrl } });
    }

    await uploadChunks({ uploadUrl, source, plan, fromChunk, fetchFn, sleep: deps.sleep });
    await awaitInbox({ accessToken, publishId, fetchFn, sleep: deps.sleep, pollIntervalMs: deps.pollIntervalMs, maxPolls: deps.maxPolls });
    await db.ttPost.update({ where: { id: postId }, data: { status: "published", lastError: null } });
    return true;
  } catch (err) {
    const kind = classifyTikTokError(err);
    // TikTok's "internal" failure is retried with a new upload.
    if (err instanceof TikTokPublishFailed && kind === "retry") {
      await db.ttPost.update({ where: { id: postId }, data: { publishId: null, uploadUrl: null } });
    }
    if (kind === "retry") throw err;
    if (kind === "reauth") await db.ttAccount.update({ where: { id: post.ttAccountId }, data: { status: "reauth_required" } });
    return fail(describeTikTokError(err));
  }
}
