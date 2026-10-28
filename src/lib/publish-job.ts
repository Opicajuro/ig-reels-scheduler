import type { PrismaClient } from "@/generated/prisma/client";
import { classifyMetaError, MetaApiError } from "./meta-errors";

const MAX_CONTAINER_CHECKS = 5;
const CONTAINER_CHECK_INTERVAL_MS = 60_000;
const LOCK_RETRY_MS = 60_000;
const QUOTA_RETRY_MS = 60 * 60 * 1000;

export type BucPauseHandler = (seconds: number) => void;

export type PublishMeta = {
  createContainer(args: {
    igUserId: string;
    token: string;
    videoUrl: string;
    caption: string;
    shareToFeed: boolean;
    onBucPause?: BucPauseHandler;
  }): Promise<string>;
  getContainerStatus(args: { containerId: string; token: string; onBucPause?: BucPauseHandler }): Promise<string>;
  publishContainer(args: {
    igUserId: string;
    containerId: string;
    token: string;
    onBucPause?: BucPauseHandler;
  }): Promise<string>;
  getPermalink(args: { igMediaId: string; token: string; onBucPause?: BucPauseHandler }): Promise<string>;
  getPublishingLimit(args: {
    igUserId: string;
    token: string;
    onBucPause?: BucPauseHandler;
  }): Promise<{ quotaUsage: number; quotaTotal: number }>;
};

export type PublishLock = {
  acquire(key: string): Promise<boolean>;
  release(key: string): Promise<void>;
};

export type PublishDeps = {
  db: PrismaClient;
  postId: string;
  now: Date;
  meta: PublishMeta;
  getReelUrl: (key: string) => Promise<string>;
  getToken: (accountId: string) => Promise<string>;
  lock: PublishLock;
  sleep: (ms: number) => Promise<void>;
  // Ends this run and asks for the job to run again at the given time. The processor implements it with a delayed re-enqueue.
  deferUntil: (at: Date) => Promise<never>;
};

// Thrown by the test double for deferUntil, so tests can tell a deferral from a failure.
export class Deferred extends Error {}

type Post = {
  id: string;
  accountId: string;
  status: string;
  caption: string;
  shareToFeed: boolean;
  scheduledAt: Date;
  containerId: string | null;
  igMediaId: string | null;
  account: { igUserId: string; status: string; pausedUntil: Date | null; rateLimitedUntil: Date | null };
  media: { reelKey: string | null };
};

type Step = "create" | "poll" | "publish" | "quota";

// Thrown after a post has been marked failed, so the job stops without retrying.
class PostFailed extends Error {}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function record(deps: PublishDeps, post: Post, step: Step, httpStatus: number | null, errorCode: number | null, response: object) {
  await deps.db.publishAttempt.create({
    data: { postId: post.id, step, httpStatus, errorCode, response },
  });
}

async function failAndStop(deps: PublishDeps, post: Post, message: string): Promise<never> {
  await deps.db.post.update({
    where: { id: post.id },
    data: { status: "failed", lastError: message, attempts: { increment: 1 } },
  });
  throw new PostFailed(message);
}

// Stores a Business Use Case pause on the account so later steps of this run and later runs wait.
async function applyPause(deps: PublishDeps, post: Post, seconds: number) {
  if (seconds <= 0) return;
  const rateLimitedUntil = new Date(deps.now.getTime() + seconds * 1000);
  post.account.rateLimitedUntil = rateLimitedUntil;
  await deps.db.igAccount.update({ where: { id: post.accountId }, data: { rateLimitedUntil } });
}

// Runs one Meta call with the retry rules from section 7. The call is logged when a step name is given.
async function callMeta<T>(
  deps: PublishDeps,
  post: Post,
  step: Step | null,
  fn: (onBucPause: BucPauseHandler) => Promise<T>,
): Promise<T> {
  let pauseSeconds = 0;
  const onBucPause: BucPauseHandler = (seconds) => {
    pauseSeconds = Math.max(pauseSeconds, seconds);
  };
  let result: T;
  try {
    result = await fn(onBucPause);
  } catch (err) {
    await applyPause(deps, post, pauseSeconds);
    if (step) {
      const status = err instanceof MetaApiError ? err.status : null;
      const code = err instanceof MetaApiError ? (err.code ?? null) : null;
      await record(deps, post, step, status, code, { message: messageOf(err) });
    }
    const kind = classifyMetaError(err);
    if (kind === "retry") throw err;
    if (kind === "reauth") {
      await deps.db.igAccount.update({ where: { id: post.accountId }, data: { status: "reauth_required" } });
    }
    return failAndStop(deps, post, messageOf(err));
  }
  if (step) await record(deps, post, step, 200, null, {});
  await applyPause(deps, post, pauseSeconds);
  return result;
}

// Ends the run while the account is paused, by its owner or by Meta's rate limit, until the later pause ends.
async function guardPause(deps: PublishDeps, post: Post) {
  const until = Math.max(post.account.pausedUntil?.getTime() ?? 0, post.account.rateLimitedUntil?.getTime() ?? 0);
  if (until > deps.now.getTime()) await deps.deferUntil(new Date(until));
}

type ContainerState = "ready" | "error" | "expired" | "published";

async function awaitContainer(deps: PublishDeps, post: Post, containerId: string, token: string): Promise<ContainerState> {
  for (let check = 1; check <= MAX_CONTAINER_CHECKS; check++) {
    const status = await callMeta(deps, post, null, (onBucPause) =>
      deps.meta.getContainerStatus({ containerId, token, onBucPause }),
    );
    if (status === "FINISHED") return "ready";
    if (status === "ERROR") return "error";
    if (status === "EXPIRED") return "expired";
    if (status === "PUBLISHED") return "published";
    if (check < MAX_CONTAINER_CHECKS) await deps.sleep(CONTAINER_CHECK_INTERVAL_MS);
  }
  throw new Error("container still processing after 5 minutes");
}

async function createContainer(deps: PublishDeps, post: Post, token: string): Promise<string> {
  if (!post.media.reelKey) return failAndStop(deps, post, "media has no reel");
  const videoUrl = await deps.getReelUrl(post.media.reelKey);
  const containerId = await callMeta(deps, post, "create", (onBucPause) =>
    deps.meta.createContainer({
      igUserId: post.account.igUserId,
      token,
      videoUrl,
      caption: post.caption,
      shareToFeed: post.shareToFeed,
      onBucPause,
    }),
  );
  // Conditional, so a cancel that lands while the container is created is not overwritten.
  await deps.db.post.updateMany({
    where: { id: post.id, status: { in: ["scheduled", "container_created"] } },
    data: { containerId, status: "container_created" },
  });
  return containerId;
}

async function publishLocked(deps: PublishDeps, post: Post) {
  const token = await deps.getToken(post.accountId);
  const igUserId = post.account.igUserId;

  let state: ContainerState | "missing" = "missing";
  if (post.containerId) {
    await guardPause(deps, post);
    state = await awaitContainer(deps, post, post.containerId, token);
  }

  let containerId = post.containerId;
  if (state === "missing" || state === "expired") {
    await guardPause(deps, post);
    if (containerId) await deps.db.post.update({ where: { id: post.id }, data: { containerId: null } });
    containerId = await createContainer(deps, post, token);
    state = await awaitContainer(deps, post, containerId, token);
  }
  // The Reel is already live (an earlier publish call succeeded but its response was lost). Marking the post failed
  // would let Retry post it a second time, so it is recorded as published.
  if (state === "published") {
    await deps.db.post.update({
      where: { id: post.id },
      data: { status: "published", lastError: "published; Meta did not return the media id" },
    });
    return;
  }
  if (state !== "ready") return failAndStop(deps, post, `container ${state}`);
  await record(deps, post, "poll", 200, null, {});

  // Section 7 step 5: wait for the publish time, then check the quota.
  if (post.scheduledAt.getTime() > deps.now.getTime()) await deps.deferUntil(post.scheduledAt);

  await guardPause(deps, post);
  const limit = await callMeta(deps, post, "quota", (onBucPause) =>
    deps.meta.getPublishingLimit({ igUserId, token, onBucPause }),
  );
  if (limit.quotaUsage >= limit.quotaTotal) await deps.deferUntil(new Date(deps.now.getTime() + QUOTA_RETRY_MS));

  await guardPause(deps, post);
  const current = await deps.db.post.findUnique({ where: { id: post.id }, select: { status: true } });
  if (current?.status === "canceled") return;
  const igMediaId = await callMeta(deps, post, "publish", (onBucPause) =>
    deps.meta.publishContainer({ igUserId, containerId: containerId as string, token, onBucPause }),
  );
  // Save the media id before anything else can fail, so a retry never publishes the Reel twice.
  await deps.db.post.update({ where: { id: post.id }, data: { igMediaId, status: "published" } });

  // The permalink is only for display. The Reel is already live, so a failed lookup must not fail the post.
  try {
    const permalink = await deps.meta.getPermalink({ igMediaId, token });
    await deps.db.post.update({ where: { id: post.id }, data: { permalink } });
  } catch (err) {
    console.warn(`permalink lookup failed for post ${post.id}: ${messageOf(err)}`);
  }
}

export async function publishPost(deps: PublishDeps) {
  const post = (await deps.db.post.findUnique({
    where: { id: deps.postId },
    include: { account: true, media: true },
  })) as Post | null;
  if (!post) throw new Error(`post ${deps.postId} not found`);
  if (post.igMediaId || post.status === "canceled" || post.status === "published") return;

  if (post.account.status !== "active") throw new Error("account is not active");
  await guardPause(deps, post);
  if (!(await deps.lock.acquire(post.accountId))) await deps.deferUntil(new Date(deps.now.getTime() + LOCK_RETRY_MS));

  try {
    await publishLocked(deps, post);
  } catch (err) {
    if (!(err instanceof PostFailed)) throw err;
  } finally {
    await deps.lock.release(post.accountId);
  }
}
