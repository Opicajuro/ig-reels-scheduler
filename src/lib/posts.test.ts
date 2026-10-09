import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { cancelScheduledPost, createScheduledPost } from "./posts";
import type { PublishQueue } from "./queues";

const NOW = new Date("2026-10-10T12:00:00Z");
const FUTURE = new Date(NOW.getTime() + 3 * 60 * 60 * 1000).toISOString();

function fakeDeps(
  options: { media?: { status: string } | null; post?: { status: string; queueJobId: string | null } | null } = {},
) {
  const created: Array<Record<string, unknown>> = [];
  const updated: Array<Record<string, unknown>> = [];
  const queued: string[] = [];
  const removed: string[] = [];
  const media = options.media === undefined ? { status: "ready" } : options.media;
  const post =
    options.post === undefined ? { id: "post-1", status: "scheduled", queueJobId: "job-post-1" } : options.post;
  const db = {
    media: { findFirst: async () => media },
    post: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return { id: "post-1", ...data };
      },
      findFirst: async () => post,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        updated.push(data);
        return {};
      },
    },
  };
  const queue: PublishQueue = {
    send: async (postId) => {
      queued.push(postId);
      return `job-${postId}`;
    },
    cancel: async (jobId) => {
      removed.push(jobId);
    },
  };
  return { db: db as unknown as PrismaClient, queue, created, updated, queued, removed };
}

const INPUT = { accountId: "acc-1", mediaId: "media-1", caption: "Big win!", scheduledAt: FUTURE };

describe("createScheduledPost", () => {
  it("creates the post and enqueues its publish job", async () => {
    const deps = fakeDeps();
    const post = await createScheduledPost({ ...deps, ownerId: "user-1", input: INPUT, now: NOW });

    expect(post.id).toBe("post-1");
    expect(deps.created[0]).toMatchObject({ accountId: "acc-1", mediaId: "media-1", caption: "Big win!" });
    expect(deps.queued).toEqual(["post-1"]);
    expect(deps.updated).toEqual([{ queueJobId: "job-post-1" }]);
  });

  it("rejects a caption that breaks the Instagram limits", async () => {
    const deps = fakeDeps();
    await expect(
      createScheduledPost({ ...deps, ownerId: "user-1", input: { ...INPUT, caption: "a".repeat(2201) }, now: NOW }),
    ).rejects.toThrow("caption must be at most 2200 characters");
    expect(deps.created).toEqual([]);
  });

  it("rejects a publish time that is not in the future", async () => {
    const deps = fakeDeps();
    await expect(
      createScheduledPost({ ...deps, ownerId: "user-1", input: { ...INPUT, scheduledAt: NOW.toISOString() }, now: NOW }),
    ).rejects.toThrow("scheduledAt must be in the future");
  });

  it("rejects media that is not ready or not owned by the user", async () => {
    const deps = fakeDeps({ media: null });
    await expect(createScheduledPost({ ...deps, ownerId: "user-1", input: INPUT, now: NOW })).rejects.toThrow(
      "media is not ready for this account",
    );
  });
});

describe("cancelScheduledPost", () => {
  it("marks a scheduled post canceled and removes the job stored on it", async () => {
    const deps = fakeDeps();
    await cancelScheduledPost({ db: deps.db, queue: deps.queue, ownerId: "user-1", postId: "post-1" });

    expect(deps.updated).toEqual([{ status: "canceled" }]);
    expect(deps.removed).toEqual(["job-post-1"]);
  });

  it("marks the post canceled without touching the queue when it has no job", async () => {
    const deps = fakeDeps({ post: { status: "scheduled", queueJobId: null } });
    await cancelScheduledPost({ db: deps.db, queue: deps.queue, ownerId: "user-1", postId: "post-1" });

    expect(deps.updated).toEqual([{ status: "canceled" }]);
    expect(deps.removed).toEqual([]);
  });

  it("refuses to cancel a post that is not scheduled", async () => {
    const deps = fakeDeps({ post: null });
    await expect(
      cancelScheduledPost({ db: deps.db, queue: deps.queue, ownerId: "user-1", postId: "post-1" }),
    ).rejects.toThrow("post is not scheduled");
  });
});
