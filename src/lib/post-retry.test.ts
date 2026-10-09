import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { retryFailedPost } from "./post-retry";
import type { PublishQueue } from "./scheduling";

const NOW = new Date("2026-10-12T09:00:00Z");

function fakeDeps(post: { id: string; status: string; scheduledAt: Date } | null) {
  const updates: Array<Record<string, unknown>> = [];
  const queued: Array<{ id: string; delay: number }> = [];
  const db = {
    post: {
      findFirst: async () => post,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        updates.push(data);
        return {};
      },
    },
  };
  const queue: PublishQueue = {
    add: async (_name, data, opts) => {
      queued.push({ id: data.postId, delay: opts.delay });
    },
    remove: async () => 1,
  };
  return { db: db as unknown as PrismaClient, queue, updates, queued };
}

describe("retryFailedPost", () => {
  it("resets a failed post, clears its old container, and queues it again", async () => {
    const deps = fakeDeps({ id: "post-1", status: "failed", scheduledAt: new Date(NOW.getTime() - 60_000) });

    await retryFailedPost({ db: deps.db, queue: deps.queue, ownerId: "user-1", postId: "post-1", now: NOW });

    expect(deps.updates).toEqual([{ status: "scheduled", lastError: null, containerId: null }]);
    expect(deps.queued).toEqual([{ id: "post-1", delay: 0 }]);
  });

  it("refuses to retry a post that is not failed", async () => {
    const deps = fakeDeps({ id: "post-1", status: "published", scheduledAt: NOW });
    await expect(
      retryFailedPost({ db: deps.db, queue: deps.queue, ownerId: "user-1", postId: "post-1", now: NOW }),
    ).rejects.toThrow("only failed posts can be retried");
    expect(deps.updates).toEqual([]);
  });

  it("does not find posts owned by someone else", async () => {
    const deps = fakeDeps(null);
    await expect(
      retryFailedPost({ db: deps.db, queue: deps.queue, ownerId: "user-2", postId: "post-1", now: NOW }),
    ).rejects.toThrow("post not found");
  });
});
