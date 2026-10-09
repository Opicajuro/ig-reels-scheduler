import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { MetaApiError } from "./meta-errors";
import { publishPost, type PublishMeta } from "./publish-job";

const NOW = new Date("2026-10-12T18:00:00Z");

type PostRow = {
  id: string;
  accountId: string;
  mediaId: string;
  caption: string;
  shareToFeed: boolean;
  scheduledAt: Date;
  status: string;
  containerId: string | null;
  igMediaId: string | null;
  permalink: string | null;
  attempts: number;
  lastError: string | null;
  media: { reelKey: string | null };
  account: { igUserId: string; status: string; pausedUntil: Date | null };
};

function makePost(overrides: Partial<PostRow> = {}): PostRow {
  return {
    id: "post-1",
    accountId: "acc-1",
    mediaId: "media-1",
    caption: "Big win",
    shareToFeed: true,
    scheduledAt: NOW,
    status: "scheduled",
    containerId: null,
    igMediaId: null,
    permalink: null,
    attempts: 0,
    lastError: null,
    media: { reelKey: "reels/media-1.mp4" },
    account: { igUserId: "17841", status: "active", pausedUntil: null },
    ...overrides,
  };
}

function fakeDb(post: PostRow | null) {
  const updates: Array<Record<string, unknown>> = [];
  const accountUpdates: Array<Record<string, unknown>> = [];
  const attempts: Array<Record<string, unknown>> = [];
  const db = {
    post: {
      findUnique: async () => post,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        updates.push(data);
        return {};
      },
    },
    igAccount: {
      update: async ({ data }: { data: Record<string, unknown> }) => {
        accountUpdates.push(data);
        return {};
      },
    },
    publishAttempt: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        attempts.push(data);
        return {};
      },
    },
  };
  return { db: db as unknown as PrismaClient, updates, accountUpdates, attempts };
}

function fakeMeta(overrides: Partial<PublishMeta> = {}): PublishMeta & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    createContainer: async () => {
      calls.push("create");
      return "container-1";
    },
    getContainerStatus: async () => {
      calls.push("status");
      return "FINISHED";
    },
    publishContainer: async () => {
      calls.push("publish");
      return "media-9";
    },
    getPermalink: async () => {
      calls.push("permalink");
      return "https://instagram.com/reel/abc";
    },
    getPublishingLimit: async () => {
      calls.push("quota");
      return { quotaUsage: 1, quotaTotal: 50 };
    },
    ...overrides,
  };
}

const lockOk = { acquire: async () => true, release: async () => {} };
const noSleep = async () => {};

function run(db: PrismaClient, meta: PublishMeta, extra: Partial<Parameters<typeof publishPost>[0]> = {}) {
  return publishPost({
    db,
    postId: "post-1",
    now: NOW,
    meta,
    getReelUrl: async (key) => `https://storage.test/${key}`,
    getToken: async () => "tok",
    lock: lockOk,
    sleep: noSleep,
    ...extra,
  });
}

describe("publishPost (spec section 7)", () => {
  it("stops without calling Meta when the post is already published", async () => {
    const { db } = fakeDb(makePost({ igMediaId: "media-9", status: "published" }));
    const meta = fakeMeta();
    await run(db, meta);
    expect(meta.calls).toEqual([]);
  });

  it("throws when the account is not active", async () => {
    const { db } = fakeDb(makePost({ account: { igUserId: "1", status: "revoked", pausedUntil: null } }));
    await expect(run(db, fakeMeta())).rejects.toThrow("account is not active");
  });

  it("throws when the account is paused into the future", async () => {
    const { db } = fakeDb(
      makePost({ account: { igUserId: "1", status: "active", pausedUntil: new Date(NOW.getTime() + 60_000) } }),
    );
    await expect(run(db, fakeMeta())).rejects.toThrow("account is paused");
  });

  it("creates the container, waits for it, checks quota, publishes, and stores the permalink", async () => {
    const { db, updates, attempts } = fakeDb(makePost());
    const meta = fakeMeta();

    await run(db, meta);

    expect(meta.calls).toEqual(["create", "status", "quota", "publish", "permalink"]);
    expect(updates).toContainEqual({ containerId: "container-1", status: "container_created" });
    expect(updates.at(-1)).toEqual({
      igMediaId: "media-9",
      permalink: "https://instagram.com/reel/abc",
      status: "published",
    });
    expect(attempts.map((a) => a.step)).toEqual(["create", "poll", "quota", "publish"]);
  });

  it("reuses an existing container that is already FINISHED", async () => {
    const { db } = fakeDb(makePost({ containerId: "container-old" }));
    const meta = fakeMeta();
    await run(db, meta);
    expect(meta.calls).not.toContain("create");
  });

  it("replaces an EXPIRED container with a new one", async () => {
    const { db, updates } = fakeDb(makePost({ containerId: "container-old" }));
    const meta = fakeMeta({ getContainerStatus: async () => "EXPIRED" });
    await run(db, meta);
    expect(updates).toContainEqual({ containerId: null });
    expect(meta.calls).toContain("create");
  });

  it("fails the post without retrying when Meta reports the container ERROR", async () => {
    const { db, updates } = fakeDb(makePost({ containerId: "container-old" }));
    const meta = fakeMeta({ getContainerStatus: async () => "ERROR" });
    await run(db, meta);
    expect(updates.at(-1)).toMatchObject({ status: "failed" });
    expect(meta.calls).not.toContain("publish");
  });

  it("throws (so the job retries later) when the container is still IN_PROGRESS after five polls", async () => {
    const { db } = fakeDb(makePost({ containerId: "container-old" }));
    const meta = fakeMeta({
      getContainerStatus: async () => {
        meta.calls.push("status");
        return "IN_PROGRESS";
      },
    });
    await expect(run(db, meta)).rejects.toThrow("still processing");
    expect(meta.calls.filter((c) => c === "status")).toHaveLength(5);
  });

  it("throws (so the job retries later) when the daily quota is used up", async () => {
    const { db } = fakeDb(makePost());
    const meta = fakeMeta({ getPublishingLimit: async () => ({ quotaUsage: 50, quotaTotal: 50 }) });
    await expect(run(db, meta)).rejects.toThrow("publishing quota is used up");
    expect(meta.calls).not.toContain("publish");
  });

  it("marks the account reauth_required on error 190", async () => {
    const { db, accountUpdates, updates } = fakeDb(makePost());
    const meta = fakeMeta({
      createContainer: async () => {
        throw new MetaApiError(400, 190, "expired");
      },
    });
    await run(db, meta);
    expect(accountUpdates).toEqual([{ status: "reauth_required" }]);
    expect(updates.at(-1)).toMatchObject({ status: "failed" });
  });

  it("rethrows a server error so the job retries", async () => {
    const { db } = fakeDb(makePost());
    const meta = fakeMeta({
      createContainer: async () => {
        throw new MetaApiError(503, undefined, "unavailable");
      },
    });
    await expect(run(db, meta)).rejects.toThrow("unavailable");
  });

  it("throws when another job already holds this account's lock", async () => {
    const { db } = fakeDb(makePost());
    await expect(run(db, fakeMeta(), { lock: { acquire: async () => false, release: async () => {} } })).rejects.toThrow(
      "account is busy",
    );
  });
});
