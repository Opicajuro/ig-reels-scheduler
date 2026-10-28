import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { disconnectAccount, pauseAccount, resumeAccount } from "./account-management";
import type { PublishQueue } from "./queues";

const NOW = new Date("2026-10-10T12:00:00Z");
const ACCOUNT = { id: "acc-1", ownerId: "user-1", igUserId: "17841" };

function fakeDeps() {
  const calls: Array<{ model: string; method: string; args: unknown }> = [];
  const cancelled: string[] = [];
  const record = (model: string, method: string, result: unknown) => async (args: unknown) => {
    calls.push({ model, method, args });
    return result;
  };
  const db = {
    igAccount: {
      findFirst: async ({ where }: { where: { id: string; ownerId: string } }) =>
        where.id === ACCOUNT.id && where.ownerId === ACCOUNT.ownerId ? ACCOUNT : null,
      update: record("igAccount", "update", {}),
      updateMany: record("igAccount", "updateMany", { count: 1 }),
    },
    post: {
      findMany: record("post", "findMany", [{ id: "post-1", queueJobId: "job-1" }]),
      updateMany: record("post", "updateMany", { count: 1 }),
    },
  };
  const queue: PublishQueue = {
    send: async () => "job",
    cancel: async (jobId) => {
      cancelled.push(jobId);
    },
  };
  return { db: db as unknown as PrismaClient, queue, calls, cancelled };
}

describe("pauseAccount", () => {
  it("sets pausedUntil the given minutes from now", async () => {
    const deps = fakeDeps();
    await pauseAccount(deps.db, { ownerId: "user-1", accountId: "acc-1", minutes: 60, now: NOW });
    expect(deps.calls).toEqual([
      {
        model: "igAccount",
        method: "update",
        args: { where: { id: "acc-1" }, data: { pausedUntil: new Date("2026-10-10T13:00:00Z") } },
      },
    ]);
  });

  it("rejects a pause length other than 1 hour, 1 day or 1 week", async () => {
    const deps = fakeDeps();
    for (const minutes of [Number.NaN, 0, -5, 1.5, 30, 7 * 24 * 60 + 1]) {
      await expect(pauseAccount(deps.db, { ownerId: "user-1", accountId: "acc-1", minutes, now: NOW })).rejects.toThrow(
        "pause must be",
      );
    }
    expect(deps.calls).toEqual([]);
  });

  it("refuses another user's account", async () => {
    const deps = fakeDeps();
    await expect(
      pauseAccount(deps.db, { ownerId: "someone-else", accountId: "acc-1", minutes: 60, now: NOW }),
    ).rejects.toThrow("account not found");
    expect(deps.calls).toEqual([]);
  });
});

describe("resumeAccount", () => {
  it("clears pausedUntil", async () => {
    const deps = fakeDeps();
    await resumeAccount(deps.db, { ownerId: "user-1", accountId: "acc-1" });
    expect(deps.calls).toEqual([
      { model: "igAccount", method: "update", args: { where: { id: "acc-1" }, data: { pausedUntil: null } } },
    ]);
  });
});

describe("disconnectAccount", () => {
  it("revokes the account and cancels its scheduled and in-progress posts and their jobs", async () => {
    const deps = fakeDeps();
    await disconnectAccount(deps.db, deps.queue, { ownerId: "user-1", accountId: "acc-1" });

    expect(deps.calls[0]).toEqual({
      model: "igAccount",
      method: "updateMany",
      args: { where: { igUserId: "17841" }, data: { status: "revoked" } },
    });
    expect(deps.calls[1]).toMatchObject({
      model: "post",
      method: "findMany",
      args: { where: { status: { in: ["scheduled", "container_created"] } } },
    });
    expect(deps.cancelled).toEqual(["job-1"]);
  });

  it("refuses another user's account and changes nothing", async () => {
    const deps = fakeDeps();
    await expect(
      disconnectAccount(deps.db, deps.queue, { ownerId: "someone-else", accountId: "acc-1" }),
    ).rejects.toThrow("account not found");
    expect(deps.calls).toEqual([]);
    expect(deps.cancelled).toEqual([]);
  });
});
