import type { PrismaClient } from "@/generated/prisma/client";
import { describe, expect, it } from "vitest";
import type { PublishQueue } from "./queues";
import { purgeUserData, revokeAccount } from "./meta-callbacks";

function fakeDeps(scheduled: Array<{ id: string; queueJobId: string | null }>, media: Array<Record<string, string | null>> = []) {
  const calls: Array<{ model: string; method: string; args: unknown }> = [];
  const record = (model: string, method: string) => async (args: unknown) => {
    calls.push({ model, method, args });
    return { count: 1 };
  };
  const db = {
    igAccount: { updateMany: record("igAccount", "updateMany"), deleteMany: record("igAccount", "deleteMany") },
    post: {
      findMany: async (args: unknown) => {
        calls.push({ model: "post", method: "findMany", args });
        return scheduled;
      },
      updateMany: record("post", "updateMany"),
    },
    media: {
      findMany: async (args: unknown) => {
        calls.push({ model: "media", method: "findMany", args });
        return media;
      },
    },
  };
  const cancelled: string[] = [];
  const queue: PublishQueue = {
    send: async () => "unused",
    cancel: async (jobId) => {
      cancelled.push(jobId);
    },
  };
  return { db: db as unknown as PrismaClient, queue, calls, cancelled };
}

describe("revokeAccount", () => {
  it("marks the account revoked, cancels its scheduled posts, and removes their publish jobs", async () => {
    const deps = fakeDeps([
      { id: "post-1", queueJobId: "job-1" },
      { id: "post-2", queueJobId: null },
    ]);
    await revokeAccount(deps.db, deps.queue, "17841");

    expect(deps.calls).toEqual([
      { model: "igAccount", method: "updateMany", args: { where: { igUserId: "17841" }, data: { status: "revoked" } } },
      {
        model: "post",
        method: "findMany",
        args: {
          where: { account: { igUserId: "17841" }, status: { in: ["scheduled", "container_created"] } },
          select: { id: true, queueJobId: true },
        },
      },
      {
        model: "post",
        method: "updateMany",
        args: { where: { id: { in: ["post-1", "post-2"] } }, data: { status: "canceled" } },
      },
    ]);
    expect(deps.cancelled).toEqual(["job-1"]);
  });
});

describe("purgeUserData", () => {
  it("deletes the stored files, cancels queued jobs, then deletes the account", async () => {
    const deleted: string[] = [];
    const deps = fakeDeps(
      [{ id: "post-1", queueJobId: "job-1" }],
      [
        { rawKey: "raw/a.mp4", reelKey: "reels/a.mp4", coverKey: null },
        { rawKey: "raw/b.mov", reelKey: null, coverKey: "covers/b.jpg" },
      ],
    );
    await purgeUserData(deps.db, deps.queue, async (key) => {
      deleted.push(key);
    }, "17841");

    expect(deleted).toEqual(["raw/a.mp4", "reels/a.mp4", "raw/b.mov", "covers/b.jpg"]);
    expect(deps.cancelled).toEqual(["job-1"]);
    expect(deps.calls.at(-1)).toEqual({
      model: "igAccount",
      method: "deleteMany",
      args: { where: { igUserId: "17841" } },
    });
  });
});
