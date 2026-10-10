import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import type { PublishQueue } from "./queues";
import { requeueUnqueuedPosts, schedulePost } from "./scheduling";

const MINUTE = 60 * 1000;
const NOW = new Date("2026-10-10T12:00:00Z");

function fakeDeps() {
  const sent: Array<{ postId: string; runAt: Date }> = [];
  const updates: Array<{ id: string; data: Record<string, unknown> }> = [];
  const queue: PublishQueue = {
    send: async (postId, runAt) => {
      sent.push({ postId, runAt });
      return `job-${postId}`;
    },
    cancel: async () => {},
  };
  const db = {
    post: {
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        updates.push({ id: where.id, data });
        return {};
      },
    },
  };
  return { db: db as unknown as PrismaClient, queue, sent, updates };
}

describe("schedulePost", () => {
  it("queues the publish job to start 45 minutes before publish time and stores its id on the post", async () => {
    const deps = fakeDeps();
    await schedulePost(deps.db, deps.queue, { id: "post-1", scheduledAt: new Date(NOW.getTime() + 120 * MINUTE) }, NOW);

    expect(deps.sent).toEqual([{ postId: "post-1", runAt: new Date(NOW.getTime() + 75 * MINUTE) }]);
    expect(deps.updates).toEqual([{ id: "post-1", data: { queueJobId: "job-post-1" } }]);
  });

  it("runs immediately when the 45-minute lead time has already passed", async () => {
    const deps = fakeDeps();
    await schedulePost(deps.db, deps.queue, { id: "post-2", scheduledAt: new Date(NOW.getTime() + 10 * MINUTE) }, NOW);

    expect(deps.sent[0].runAt).toEqual(NOW);
  });
});

describe("requeueUnqueuedPosts", () => {
  it("queues only scheduled posts that have no job, and returns how many", async () => {
    const sent: string[] = [];
    const updates: Array<{ id: string; queueJobId: unknown }> = [];
    const db = {
      post: {
        findMany: async ({ where }: { where: { status: string; queueJobId: null } }) => {
          expect(where).toEqual({ status: "scheduled", queueJobId: null });
          return [{ id: "old-1", scheduledAt: new Date(NOW.getTime() + 5 * MINUTE) }];
        },
        update: async ({ where, data }: { where: { id: string }; data: { queueJobId: unknown } }) => {
          updates.push({ id: where.id, queueJobId: data.queueJobId });
          return {};
        },
      },
    };
    const queue: PublishQueue = {
      send: async (postId) => {
        sent.push(postId);
        return `job-${postId}`;
      },
      cancel: async () => {},
    };

    const count = await requeueUnqueuedPosts(db as unknown as PrismaClient, queue, NOW);

    expect(count).toBe(1);
    expect(sent).toEqual(["old-1"]);
    expect(updates).toEqual([{ id: "old-1", queueJobId: "job-old-1" }]);
  });
});
