import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { FakeTikTok, tikTokError } from "./fake-tiktok";
import { TikTokStillProcessing } from "./tiktok";
import { publishTikTokPost } from "./tiktok-publish-job";

type Row = Record<string, unknown> & { id: string };

const NOW = new Date("2026-11-04T12:00:00Z");
const SIZE = 25_000_000;

function fakeDb(post: Partial<Row> = {}, account: Partial<Row> = {}) {
  const tables = {
    ttAccount: [{ id: "tt-1", status: "active", ...account }] as Row[],
    ttPost: [
      {
        id: "post-1",
        ttAccountId: "tt-1",
        videoKey: "tiktok/post-1.mp4",
        caption: "Watch to the end",
        aiGenerated: false,
        scheduledAt: NOW,
        status: "scheduled",
        publishId: null,
        uploadUrl: null,
        attempts: 0,
        ...post,
      },
    ] as Row[],
  };
  const statusMatches = (row: Row, status: unknown) =>
    status === undefined || (typeof status === "object" && status && "in" in status ? (status.in as unknown[]).includes(row.status) : row.status === status);
  const apply = (row: Row, data: Row) => {
    for (const [key, value] of Object.entries(data)) {
      row[key] = value && typeof value === "object" && "increment" in value ? (row[key] as number) + (value.increment as number) : value;
    }
  };
  const db = {
    ttPost: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const row = tables.ttPost.find((item) => item.id === where.id);
        return row ? { ...structuredClone(row), ttAccount: structuredClone(tables.ttAccount.find((item) => item.id === row.ttAccountId)) } : null;
      },
      update: async ({ where, data }: { where: { id: string }; data: Row }) => {
        const row = tables.ttPost.find((item) => item.id === where.id) as Row;
        apply(row, data);
        return row;
      },
      updateMany: async ({ where, data }: { where: { id: string; status?: unknown }; data: Row }) => {
        const rows = tables.ttPost.filter((item) => item.id === where.id && statusMatches(item, where.status));
        for (const row of rows) apply(row, data);
        return { count: rows.length };
      },
    },
    ttAccount: {
      update: async ({ where, data }: { where: { id: string }; data: Row }) => {
        const row = tables.ttAccount.find((item) => item.id === where.id) as Row;
        apply(row, data);
        return row;
      },
    },
  };
  return { db: db as unknown as PrismaClient, post: () => tables.ttPost[0], account: () => tables.ttAccount[0] };
}

class Deferred extends Error {}

function run(db: PrismaClient, tiktok: FakeTikTok, { maxPolls = 3 }: { maxPolls?: number } = {}) {
  return publishTikTokPost({
    db,
    postId: "post-1",
    now: NOW,
    getAccessToken: async () => "act",
    openVideo: async () => ({ size: SIZE, read: async (start, end) => new Uint8Array(end - start + 1) }),
    fetchFn: tiktok.fetch,
    sleep: async () => {},
    pollIntervalMs: 1,
    maxPolls,
    deferUntil: async (at) => {
      throw new Deferred(at.toISOString());
    },
  });
}

const ranges = (tiktok: FakeTikTok) => tiktok.calls.filter((call) => call.method === "PUT").map((call) => call.headers.get("Content-Range"));

describe("publishTikTokPost", () => {
  it("inits the inbox upload, sends the chunks, polls the status and marks the post as sent to drafts", async () => {
    const { db, post } = fakeDb();
    const tiktok = new FakeTikTok();
    tiktok.pollsUntilInbox = 2;
    expect(await run(db, tiktok)).toBe(true);
    expect(post()).toMatchObject({ status: "published", publishId: "v_inbox_file~v2.1", lastError: null });
    expect(ranges(tiktok)).toEqual(["bytes 0-9999999/25000000", "bytes 10000000-24999999/25000000"]);
    expect(tiktok.calls.filter((call) => call.url.pathname === "/v2/post/publish/status/fetch/")).toHaveLength(2);
  });

  it("goes on from the chunks TikTok already has, with the stored upload, instead of starting a second draft", async () => {
    const tiktok = new FakeTikTok();
    tiktok.uploads.set("v_inbox_file~v2.5", { size: SIZE, chunkSize: 10_000_000, totalChunks: 2, received: 10_000_000, chunks: 1 });
    const { db, post } = fakeDb({
      status: "container_created",
      publishId: "v_inbox_file~v2.5",
      uploadUrl: "https://open-upload.tiktokapis.com/video/?upload_id=v_inbox_file~v2.5&upload_token=tok",
    });
    expect(await run(db, tiktok)).toBe(true);
    expect(tiktok.calls.some((call) => call.url.pathname === "/v2/post/publish/inbox/video/init/")).toBe(false);
    expect(ranges(tiktok)).toEqual(["bytes 10000000-24999999/25000000"]);
    expect(post().status).toBe("published");
  });

  it("is thrown for another run while TikTok is still processing, keeping the upload", async () => {
    const { db, post } = fakeDb();
    const tiktok = new FakeTikTok();
    tiktok.pollsUntilInbox = 10;
    await expect(run(db, tiktok, { maxPolls: 2 })).rejects.toThrow(TikTokStillProcessing);
    expect(post()).toMatchObject({ status: "container_created", publishId: "v_inbox_file~v2.1" });
  });

  it("fails with plain words when the inbox already holds 5 drafts", async () => {
    const { db, post } = fakeDb();
    const tiktok = new FakeTikTok();
    tiktok.failures.set("POST open.tiktokapis.com/v2/post/publish/inbox/video/init/", tikTokError(403, "spam_risk_too_many_pending_share"));
    expect(await run(db, tiktok)).toBe(false);
    expect(post()).toMatchObject({ status: "failed", attempts: 1 });
    expect(post().lastError).toMatch(/at most 5 drafts/);
  });

  it("marks the account as needing reconnecting when its token is refused", async () => {
    const { db, post, account } = fakeDb();
    const tiktok = new FakeTikTok();
    tiktok.failures.set("POST open.tiktokapis.com/v2/post/publish/inbox/video/init/", tikTokError(401, "access_token_invalid"));
    expect(await run(db, tiktok)).toBe(false);
    expect(account().status).toBe("reauth_required");
    expect(post().status).toBe("failed");
  });

  it("throws a rate limit for pg-boss's retries", async () => {
    const { db, post } = fakeDb();
    const tiktok = new FakeTikTok();
    tiktok.failures.set("POST open.tiktokapis.com/v2/post/publish/inbox/video/init/", tikTokError(429, "rate_limit_exceeded"));
    await expect(run(db, tiktok)).rejects.toThrow("rate_limit_exceeded");
    expect(post()).toMatchObject({ status: "container_created", attempts: 0 });
  });

  it("starts a new upload on the next run after TikTok's retryable internal failure", async () => {
    const { db, post } = fakeDb();
    const tiktok = new FakeTikTok();
    tiktok.failures.set(
      "POST open.tiktokapis.com/v2/post/publish/status/fetch/",
      new Response(JSON.stringify({ data: { status: "FAILED", fail_reason: "internal" }, error: { code: "ok" } })),
    );
    await expect(run(db, tiktok)).rejects.toThrow("internal");
    expect(post()).toMatchObject({ status: "container_created", publishId: null, uploadUrl: null });
    expect(await run(db, tiktok)).toBe(true);
    expect(post().publishId).toBe("v_inbox_file~v2.2");
  });

  it("waits for its time, and does nothing for a canceled post or an account that is gone", async () => {
    const tiktok = new FakeTikTok();
    await expect(run(fakeDb({ scheduledAt: new Date(NOW.getTime() + 60_000) }).db, tiktok)).rejects.toThrow(Deferred);
    expect(await run(fakeDb({ status: "canceled" }).db, tiktok)).toBe(false);
    const gone = fakeDb({}, { status: "revoked" });
    expect(await run(gone.db, tiktok)).toBe(false);
    expect(gone.post().status).toBe("failed");
    expect(tiktok.calls).toEqual([]);
  });
});
