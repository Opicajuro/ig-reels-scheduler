import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { cancelScheduledPost } from "./posts";
import type { PublishQueue } from "./queues";

function fakeDeps(options: { post?: { status: string; queueJobId: string | null } | null } = {}) {
  const updated: Array<Record<string, unknown>> = [];
  const removed: string[] = [];
  const post =
    options.post === undefined ? { id: "post-1", status: "scheduled", queueJobId: "job-post-1" } : options.post;
  const db = {
    post: {
      findFirst: async () => post,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        updated.push(data);
        return {};
      },
    },
  };
  const queue: PublishQueue = {
    send: async (postId) => `job-${postId}`,
    cancel: async (jobId) => {
      removed.push(jobId);
    },
  };
  return { db: db as unknown as PrismaClient, queue, updated, removed };
}

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
