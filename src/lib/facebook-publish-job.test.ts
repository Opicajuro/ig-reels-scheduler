import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { FakeGraph, graphError } from "./fake-meta-graph";
import { publishFacebookPost, ReelStillPublishing } from "./facebook-publish-job";

type Row = Record<string, unknown> & { id: string };

const NOW = new Date("2026-11-04T12:00:00Z");

function fakeDb(post: Partial<Row> = {}, page: Partial<Row> = {}) {
  const tables = {
    fbPage: [{ id: "fb-1", pageId: "page-1", status: "active", ...page }] as Row[],
    fbPost: [
      {
        id: "post-1",
        fbPageId: "fb-1",
        videoKey: "facebook/post-1.mp4",
        description: "Watch to the end",
        aiGenerated: true,
        scheduledAt: NOW,
        status: "scheduled",
        videoId: null,
        fbPostId: null,
        permalink: null,
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
    fbPost: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const row = tables.fbPost.find((item) => item.id === where.id);
        return row ? { ...structuredClone(row), fbPage: structuredClone(tables.fbPage.find((item) => item.id === row.fbPageId)) } : null;
      },
      update: async ({ where, data }: { where: { id: string }; data: Row }) => {
        const row = tables.fbPost.find((item) => item.id === where.id) as Row;
        apply(row, data);
        return row;
      },
      updateMany: async ({ where, data }: { where: { id: string; status?: unknown }; data: Row }) => {
        const rows = tables.fbPost.filter((item) => item.id === where.id && statusMatches(item, where.status));
        for (const row of rows) apply(row, data);
        return { count: rows.length };
      },
    },
    fbPage: {
      update: async ({ where, data }: { where: { id: string }; data: Row }) => {
        const row = tables.fbPage.find((item) => item.id === where.id) as Row;
        apply(row, data);
        return row;
      },
    },
  };
  return { db: db as unknown as PrismaClient, post: () => tables.fbPost[0], page: () => tables.fbPage[0] };
}

class Deferred extends Error {}

function run(db: PrismaClient, graph: FakeGraph, { r2 = true, maxPolls = 3 }: { r2?: boolean; maxPolls?: number } = {}) {
  const staged: string[] = [];
  const discarded: string[] = [];
  const sleeps: number[] = [];
  const result = publishFacebookPost({
    db,
    postId: "post-1",
    now: NOW,
    getPageToken: async () => "page-token",
    stageVideo: async (postId) => (staged.push(postId), r2 ? `https://r2.test/fb-posts/${postId}.mp4?sig=1` : null),
    discardVideo: async (postId) => void discarded.push(postId),
    openVideo: async () => ({ size: 2048, read: async (start, end) => new Uint8Array(end - start + 1) }),
    fetchFn: graph.fetch,
    sleep: async (ms) => void sleeps.push(ms),
    pollIntervalMs: 10,
    maxPolls,
    deferUntil: async (at) => {
      throw new Deferred(at.toISOString());
    },
  });
  return { result, staged, discarded, sleeps };
}

const routes = (graph: FakeGraph) => graph.calls.map((call) => `${call.method} ${call.url.host}${call.url.pathname}`);

describe("publishFacebookPost", () => {
  it("starts, uploads from the R2 link, finishes, polls until published and stores the post id and link", async () => {
    const { db, post } = fakeDb();
    const graph = new FakeGraph();
    graph.pollsUntilPublished = 2;
    const { result, staged, discarded, sleeps } = run(db, graph);
    expect(await result).toBe(true);

    expect(post()).toMatchObject({
      status: "published",
      videoId: "video-1",
      fbPostId: "page-1_video-1",
      permalink: "https://www.facebook.com/reel/video-1",
      lastError: null,
    });
    expect(routes(graph)).toEqual([
      "POST graph.facebook.com/v26.0/page-1/video_reels",
      "POST rupload.facebook.com/video-upload/v26.0/video-1",
      "POST graph.facebook.com/v26.0/page-1/video_reels",
      "GET graph.facebook.com/v26.0/video-1",
      "GET graph.facebook.com/v26.0/video-1",
      "GET graph.facebook.com/v26.0/video-1",
    ]);
    expect(graph.calls[1].headers.get("file_url")).toBe("https://r2.test/fb-posts/post-1.mp4?sig=1");
    expect(new URLSearchParams(graph.calls[2].body).get("is_ai_generated")).toBe("true");
    expect(staged).toEqual(["post-1"]);
    expect(discarded).toEqual(["post-1"]);
    expect(sleeps).toEqual([10]);
  });

  it("uploads the bytes from this PC when R2 is not set up", async () => {
    const { db, post } = fakeDb();
    const graph = new FakeGraph();
    expect(await run(db, graph, { r2: false }).result).toBe(true);
    const upload = graph.calls[1];
    expect([upload.headers.get("offset"), upload.headers.get("file_size"), upload.headers.get("file_url")]).toEqual(["0", "2048", null]);
    expect(post().status).toBe("published");
  });

  it("goes on with the stored video: no new session, no second upload and no second finish", async () => {
    const graph = new FakeGraph();
    graph.reels.set("video-7", {
      uploading: { status: "complete" },
      processing: { status: "in_progress" },
      publishing: { status: "in_progress" },
      pollsUntilPublished: 2,
    });
    const { db, post } = fakeDb({ status: "container_created", videoId: "video-7", fbPostId: "page-1_video-7" });
    expect(await run(db, graph).result).toBe(true);
    expect(routes(graph).every((route) => route === "GET graph.facebook.com/v26.0/video-7")).toBe(true);
    expect(post()).toMatchObject({ status: "published", fbPostId: "page-1_video-7" });
  });

  it("is thrown for another run while Facebook is still publishing, and keeps the video", async () => {
    const { db, post } = fakeDb();
    const graph = new FakeGraph();
    graph.pollsUntilPublished = 10;
    await expect(run(db, graph, { maxPolls: 2 }).result).rejects.toThrow(ReelStillPublishing);
    expect(post()).toMatchObject({ status: "container_created", videoId: "video-1" });
  });

  it("throws a rate limit for pg-boss's retries and leaves the post publishing", async () => {
    const { db, post } = fakeDb();
    const graph = new FakeGraph();
    graph.failures.set("POST graph.facebook.com/v26.0/page-1/video_reels", graphError(400, 613, "rate limit"));
    await expect(run(db, graph).result).rejects.toThrow("rate limit");
    expect(post()).toMatchObject({ status: "container_created", attempts: 0 });
  });

  it("marks the Page as needing reconnecting when its token is refused", async () => {
    const { db, post, page } = fakeDb();
    const graph = new FakeGraph();
    graph.failures.set("POST graph.facebook.com/v26.0/page-1/video_reels", graphError(400, 190, "Error validating access token"));
    const { result, discarded } = run(db, graph);
    expect(await result).toBe(false);
    expect(page().status).toBe("reauth_required");
    expect(post()).toMatchObject({ status: "failed", attempts: 1 });
    expect(post().lastError).toMatch(/Reconnect it on the Accounts page/);
    expect(discarded).toEqual(["post-1"]);
  });

  it("fails the post with Facebook's processing error", async () => {
    const { db, post } = fakeDb();
    const graph = new FakeGraph();
    graph.failures.set(
      "GET graph.facebook.com/v26.0/video-1",
      new Response(JSON.stringify({ status: { video_status: "error", processing_phase: { status: "error", error: { message: "Bad video" } } } })),
    );
    expect(await run(db, graph).result).toBe(false);
    expect(post()).toMatchObject({ status: "failed", lastError: "Bad video" });
  });

  it("waits for a publish time that has not come, and does nothing for a canceled post or a Page that is gone", async () => {
    const graph = new FakeGraph();
    const later = fakeDb({ scheduledAt: new Date(NOW.getTime() + 60_000) });
    await expect(run(later.db, graph).result).rejects.toThrow(Deferred);

    const canceled = fakeDb({ status: "canceled" });
    expect(await run(canceled.db, graph).result).toBe(false);

    const gone = fakeDb({}, { status: "revoked" });
    expect(await run(gone.db, graph).result).toBe(false);
    expect(gone.post()).toMatchObject({ status: "failed" });
    expect(graph.calls).toEqual([]);
  });
});
