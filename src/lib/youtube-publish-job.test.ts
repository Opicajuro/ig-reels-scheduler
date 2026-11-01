import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { YouTubeApiError, YouTubeAuthError, type UploadSource } from "./youtube";
import { publishYouTubePost } from "./youtube-publish-job";

type Row = Record<string, unknown> & { id: string };

const NOW = new Date("2026-11-02T10:00:00Z");

function fakeDb(post: Partial<Row> = {}, account: Partial<Row> = {}) {
  const tables = {
    ytAccount: [{ id: "yt-1", status: "active", ...account }] as Row[],
    ytPost: [
      {
        id: "post-1",
        ytAccountId: "yt-1",
        videoKey: "youtube/post-1.mp4",
        title: "Wait for it",
        description: "Watch\n\n#Shorts",
        privacy: "public",
        madeForKids: false,
        aiGenerated: true,
        scheduledAt: NOW,
        status: "scheduled",
        uploadUrl: null,
        videoId: null,
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
    ytPost: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const row = tables.ytPost.find((item) => item.id === where.id);
        return row ? { ...structuredClone(row), ytAccount: structuredClone(tables.ytAccount.find((item) => item.id === row.ytAccountId)) } : null;
      },
      update: async ({ where, data }: { where: { id: string }; data: Row }) => {
        const row = tables.ytPost.find((item) => item.id === where.id) as Row;
        apply(row, data);
        return row;
      },
      updateMany: async ({ where, data }: { where: { id: string; status?: unknown }; data: Row }) => {
        const rows = tables.ytPost.filter((item) => item.id === where.id && statusMatches(item, where.status));
        for (const row of rows) apply(row, data);
        return { count: rows.length };
      },
    },
    ytAccount: {
      update: async ({ where, data }: { where: { id: string }; data: Row }) => {
        const row = tables.ytAccount.find((item) => item.id === where.id) as Row;
        apply(row, data);
        return row;
      },
    },
  };
  return { db: db as unknown as PrismaClient, post: () => tables.ytPost[0], account: () => tables.ytAccount[0] };
}

const SOURCE: UploadSource = { size: 1024, read: async (start, end) => new Uint8Array(end - start + 1) };

// The upload endpoint: a session, then one chunk that finishes the video, or the given answer to the first request.
function fakeYouTube(first?: Response | Error) {
  const methods: string[] = [];
  const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    methods.push(init?.method ?? "GET");
    if (first && methods.length === 1) {
      if (first instanceof Error) throw first;
      return first;
    }
    if (init?.method === "POST") return new Response(null, { status: 200, headers: { Location: "https://upload.test/s/1" } });
    return new Response(JSON.stringify({ id: "vid-9" }), { status: 201 });
  }) as typeof fetch;
  return { fetchFn, methods };
}

class Deferred extends Error {}

function run(db: PrismaClient, fetchFn: typeof fetch, getAccessToken: (id: string) => Promise<string> = async () => "at") {
  return publishYouTubePost({
    db,
    postId: "post-1",
    now: NOW,
    getAccessToken,
    openVideo: async () => SOURCE,
    fetchFn,
    sleep: async () => {},
    deferUntil: async (at) => {
      throw new Deferred(at.toISOString());
    },
  });
}

const apiError = (status: number, reason: string, message = reason) =>
  new Response(JSON.stringify({ error: { code: status, message, errors: [{ reason }] } }), { status });

describe("publishYouTubePost", () => {
  it("uploads the post and stores the video id and its Shorts link", async () => {
    const { db, post } = fakeDb();
    expect(await run(db, fakeYouTube().fetchFn)).toBe(true);
    expect(post()).toMatchObject({
      status: "published",
      videoId: "vid-9",
      url: "https://www.youtube.com/shorts/vid-9",
      uploadUrl: null,
    });
  });

  it("waits for a publish time that has not come yet", async () => {
    const { db, post } = fakeDb({ scheduledAt: new Date(NOW.getTime() + 60_000) });
    await expect(run(db, fakeYouTube().fetchFn)).rejects.toThrow(Deferred);
    expect(post().status).toBe("scheduled");
  });

  it("does nothing for a canceled or already published post", async () => {
    for (const status of ["canceled", "published"]) {
      const youtube = fakeYouTube();
      const { db } = fakeDb({ status });
      expect(await run(db, youtube.fetchFn)).toBe(false);
      expect(youtube.methods).toEqual([]);
    }
  });

  it("fails a post whose channel is not connected, without uploading", async () => {
    const youtube = fakeYouTube();
    const { db, post } = fakeDb({}, { status: "revoked" });
    expect(await run(db, youtube.fetchFn)).toBe(false);
    expect(post()).toMatchObject({ status: "failed", attempts: 1 });
    expect(youtube.methods).toEqual([]);
  });

  it("marks a quota error clearly and fails the post, leaving the channel alone", async () => {
    const { db, post, account } = fakeDb();
    expect(await run(db, fakeYouTube(apiError(403, "quotaExceeded")).fetchFn)).toBe(false);
    expect(post().status).toBe("failed");
    expect(post().lastError).toMatch(/^YouTube quota: .*midnight Pacific time/);
    expect(account().status).toBe("active");
  });

  it("marks the channel for reconnecting when Google refuses the login", async () => {
    const { db, post, account } = fakeDb();
    const refused = async () => {
      throw new YouTubeAuthError("Token has been expired or revoked.");
    };
    expect(await run(db, fakeYouTube().fetchFn, refused)).toBe(false);
    expect(post().lastError).toMatch(/Reconnect it on the Accounts page/);
    expect(account().status).toBe("reauth_required");
  });

  it("marks the channel for reconnecting on a 401 from the upload", async () => {
    const { db, account } = fakeDb();
    await run(db, fakeYouTube(apiError(401, "authError")).fetchFn);
    expect(account().status).toBe("reauth_required");
  });

  it("fails on a request YouTube turns down, such as a bad title", async () => {
    const { db, post } = fakeDb();
    await run(db, fakeYouTube(apiError(400, "invalidTitle", "The request metadata specifies an invalid video title.")).fetchFn);
    expect(post()).toMatchObject({ status: "failed", lastError: "The request metadata specifies an invalid video title." });
  });

  it("throws a 5xx or a dropped connection so the job runs again, keeping the post in progress", async () => {
    for (const first of [apiError(503, "backendError"), new TypeError("fetch failed")]) {
      const { db, post } = fakeDb();
      await expect(run(db, fakeYouTube(first).fetchFn)).rejects.toSatisfy(
        (err) => err instanceof TypeError || err instanceof YouTubeApiError,
      );
      expect(post().status).toBe("container_created");
    }
  });

  it("goes on from the stored upload session on the next run", async () => {
    const { db, post } = fakeDb({ status: "container_created", uploadUrl: "https://upload.test/s/1" });
    const youtube = fakeYouTube();
    expect(await run(db, youtube.fetchFn)).toBe(true);
    expect(youtube.methods).not.toContain("POST");
    expect(post().videoId).toBe("vid-9");
  });
});
