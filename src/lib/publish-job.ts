import type { PrismaClient } from "@/generated/prisma/client";
import { classifyMetaError, MetaApiError } from "./meta-errors";

const MAX_CONTAINER_CHECKS = 5;
const CONTAINER_CHECK_INTERVAL_MS = 60_000;

export type PublishMeta = {
  createContainer(args: {
    igUserId: string;
    token: string;
    videoUrl: string;
    caption: string;
    shareToFeed: boolean;
  }): Promise<string>;
  getContainerStatus(args: { containerId: string; token: string }): Promise<string>;
  publishContainer(args: { igUserId: string; containerId: string; token: string }): Promise<string>;
  getPermalink(args: { igMediaId: string; token: string }): Promise<string>;
  getPublishingLimit(args: { igUserId: string; token: string }): Promise<{ quotaUsage: number; quotaTotal: number }>;
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
};

type Post = {
  id: string;
  accountId: string;
  caption: string;
  shareToFeed: boolean;
  containerId: string | null;
  igMediaId: string | null;
  account: { igUserId: string; status: string; pausedUntil: Date | null };
  media: { reelKey: string | null };
};

// Thrown after a post has been marked failed, so the job stops without retrying.
class PostFailed extends Error {}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function record(
  deps: PublishDeps,
  post: Post,
  step: "create" | "poll" | "publish" | "quota",
  httpStatus: number | null,
  errorCode: number | null,
  response: object,
) {
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

// Runs one Meta call with the retry rules from section 7. The call is logged when a step name is given.
async function callMeta<T>(
  deps: PublishDeps,
  post: Post,
  step: "create" | "poll" | "publish" | "quota" | null,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    const result = await fn();
    if (step) await record(deps, post, step, 200, null, {});
    return result;
  } catch (err) {
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
}

type ContainerState = "ready" | "error" | "expired" | "published";

async function awaitContainer(deps: PublishDeps, post: Post, containerId: string, token: string): Promise<ContainerState> {
  for (let check = 1; check <= MAX_CONTAINER_CHECKS; check++) {
    const status = await callMeta(deps, post, null, () => deps.meta.getContainerStatus({ containerId, token }));
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
  const containerId = await callMeta(deps, post, "create", () =>
    deps.meta.createContainer({
      igUserId: post.account.igUserId,
      token,
      videoUrl,
      caption: post.caption,
      shareToFeed: post.shareToFeed,
    }),
  );
  await deps.db.post.update({ where: { id: post.id }, data: { containerId, status: "container_created" } });
  return containerId;
}

async function publishLocked(deps: PublishDeps, post: Post) {
  const token = await deps.getToken(post.accountId);
  const igUserId = post.account.igUserId;

  let state: ContainerState | "missing" = "missing";
  if (post.containerId) state = await awaitContainer(deps, post, post.containerId, token);

  let containerId = post.containerId;
  if (state === "missing" || state === "expired") {
    if (containerId) await deps.db.post.update({ where: { id: post.id }, data: { containerId: null } });
    containerId = await createContainer(deps, post, token);
    state = await awaitContainer(deps, post, containerId, token);
  }
  if (state === "published") return failAndStop(deps, post, "container already published; media id unknown");
  if (state !== "ready") return failAndStop(deps, post, `container ${state}`);
  await record(deps, post, "poll", 200, null, {});

  const limit = await callMeta(deps, post, "quota", () => deps.meta.getPublishingLimit({ igUserId, token }));
  if (limit.quotaUsage >= limit.quotaTotal) throw new Error("publishing quota is used up; retry later");

  const igMediaId = await callMeta(deps, post, "publish", () =>
    deps.meta.publishContainer({ igUserId, containerId: containerId as string, token }),
  );
  const permalink = await callMeta(deps, post, null, () => deps.meta.getPermalink({ igMediaId, token }));

  await deps.db.post.update({
    where: { id: post.id },
    data: { igMediaId, permalink, status: "published" },
  });
}

export async function publishPost(deps: PublishDeps) {
  const post = (await deps.db.post.findUnique({
    where: { id: deps.postId },
    include: { account: true, media: true },
  })) as Post | null;
  if (!post) throw new Error(`post ${deps.postId} not found`);
  if (post.igMediaId) return;

  if (post.account.status !== "active") throw new Error("account is not active");
  if (post.account.pausedUntil && post.account.pausedUntil.getTime() > deps.now.getTime()) {
    throw new Error("account is paused");
  }
  if (!(await deps.lock.acquire(post.accountId))) throw new Error("account is busy");

  try {
    await publishLocked(deps, post);
  } catch (err) {
    if (!(err instanceof PostFailed)) throw err;
  } finally {
    await deps.lock.release(post.accountId);
  }
}
