import { describe, expect, it } from "vitest";
import { cancelPost, schedulePost, type PublishQueue } from "./scheduling";

const MINUTE = 60 * 1000;

function fakeQueue() {
  const added: Array<{ name: string; data: unknown; opts: { jobId: string; delay: number } }> = [];
  const removed: string[] = [];
  const queue: PublishQueue = {
    add: async (name, data, opts) => {
      added.push({ name, data, opts });
    },
    remove: async (jobId) => {
      removed.push(jobId);
      return 1;
    },
  };
  return { queue, added, removed };
}

const NOW = new Date("2026-10-10T12:00:00Z");

describe("schedulePost", () => {
  it("enqueues one job per post, starting 45 minutes before publish time", async () => {
    const { queue, added } = fakeQueue();
    await schedulePost(queue, { id: "post-1", scheduledAt: new Date(NOW.getTime() + 120 * MINUTE) }, NOW);

    expect(added).toEqual([
      { name: "publish", data: { postId: "post-1" }, opts: { jobId: "post-1", delay: 75 * MINUTE } },
    ]);
  });

  it("runs immediately when the 45-minute lead time has already passed", async () => {
    const { queue, added } = fakeQueue();
    await schedulePost(queue, { id: "post-2", scheduledAt: new Date(NOW.getTime() + 10 * MINUTE) }, NOW);

    expect(added[0].opts.delay).toBe(0);
  });
});

describe("cancelPost", () => {
  it("removes the post's job by its id", async () => {
    const { queue, removed } = fakeQueue();
    await cancelPost(queue, "post-1");
    expect(removed).toEqual(["post-1"]);
  });
});
