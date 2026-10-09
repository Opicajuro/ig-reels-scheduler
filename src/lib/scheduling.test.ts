import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import type { PublishQueue } from "./queues";
import { schedulePost } from "./scheduling";

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
