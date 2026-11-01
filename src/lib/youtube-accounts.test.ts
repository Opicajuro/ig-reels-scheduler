import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { openSecret, sealSecret } from "./settings";
import { YouTubeAuthError } from "./youtube";
import { disconnectYouTubeChannel, saveYouTubeChannel, youTubeAccessToken } from "./youtube-accounts";

const KEY = Buffer.alloc(32, 3);
const CLIENT = { clientId: "id.apps.googleusercontent.com", clientSecret: "secret", redirectUri: "http://localhost:3000/api/youtube/callback" };

type Row = Record<string, unknown> & { id: string };

function fakeDb(accounts: Row[] = [], posts: Row[] = []) {
  const tables = { ytAccount: accounts, ytPost: posts };
  const matches = (row: Row, where: Record<string, unknown>) => Object.entries(where).every(([key, value]) => row[key] === value);
  const db = {
    ytAccount: {
      findUnique: async ({ where }: { where: Record<string, unknown> }) => tables.ytAccount.find((row) => matches(row, where)) ?? null,
      findFirst: async ({ where }: { where: Record<string, unknown> }) => tables.ytAccount.find((row) => matches(row, where)) ?? null,
      upsert: async ({ where, create, update }: { where: { channelId: string }; create: Row; update: Row }) => {
        const row = tables.ytAccount.find((item) => item.channelId === where.channelId);
        if (row) return Object.assign(row, update);
        const created = { ...create, id: `yt-${tables.ytAccount.length + 1}` };
        tables.ytAccount.push(created);
        return created;
      },
      update: async ({ where, data }: { where: { id: string }; data: Row }) =>
        Object.assign(tables.ytAccount.find((row) => row.id === where.id) as Row, data),
    },
    ytPost: {
      findMany: async ({ where }: { where: Record<string, unknown> }) => tables.ytPost.filter((row) => matches(row, where)),
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Row }) => {
        const rows = tables.ytPost.filter((row) => matches(row, where));
        for (const row of rows) Object.assign(row, data);
        return { count: rows.length };
      },
    },
  };
  return { db: db as unknown as PrismaClient, tables };
}

describe("saveYouTubeChannel", () => {
  it("stores the refresh token sealed, and a reconnect replaces it and makes the channel active", async () => {
    const { db, tables } = fakeDb();
    await saveYouTubeChannel(db, KEY, { ownerId: "u1", channelId: "UC1", title: "Mine", refreshToken: "rt-1" });
    tables.ytAccount[0].status = "reauth_required";
    await saveYouTubeChannel(db, KEY, { ownerId: "u1", channelId: "UC1", title: "Renamed", refreshToken: "rt-2" });

    expect(tables.ytAccount).toHaveLength(1);
    expect(tables.ytAccount[0]).toMatchObject({ channelTitle: "Renamed", status: "active" });
    expect(tables.ytAccount[0].refreshToken).not.toContain("rt-2");
    expect(openSecret(tables.ytAccount[0].refreshToken as string, KEY)).toBe("rt-2");
  });

  it("refuses a channel connected by someone else", async () => {
    const { db } = fakeDb([{ id: "yt-1", ownerId: "u2", channelId: "UC1" }]);
    await expect(saveYouTubeChannel(db, KEY, { ownerId: "u1", channelId: "UC1", title: "x", refreshToken: "rt" })).rejects.toThrow(
      /another user/,
    );
  });
});

describe("youTubeAccessToken", () => {
  it("refreshes with the stored refresh token", async () => {
    const { db } = fakeDb([{ id: "yt-1", status: "active", refreshToken: sealSecret("rt-1", KEY) }]);
    let sent: URLSearchParams | null = null;
    const fetchFn = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      sent = new URLSearchParams(String(init?.body));
      return new Response(JSON.stringify({ access_token: "at-1", expires_in: 3599 }), { status: 200 });
    }) as typeof fetch;

    expect(await youTubeAccessToken({ db, key: KEY, client: CLIENT, ytAccountId: "yt-1", fetchFn })).toBe("at-1");
    expect(sent!.get("refresh_token")).toBe("rt-1");
  });

  it("marks the channel for reconnecting when Google turns the refresh token down", async () => {
    const { db, tables } = fakeDb([{ id: "yt-1", status: "active", refreshToken: sealSecret("rt-1", KEY) }]);
    const fetchFn = (async () =>
      new Response(JSON.stringify({ error: "invalid_grant", error_description: "Token has been expired or revoked." }), {
        status: 400,
      })) as typeof fetch;

    await expect(youTubeAccessToken({ db, key: KEY, client: CLIENT, ytAccountId: "yt-1", fetchFn })).rejects.toBeInstanceOf(
      YouTubeAuthError,
    );
    expect(tables.ytAccount[0].status).toBe("reauth_required");
  });

  it("has no token to refresh after a disconnect", async () => {
    const { db } = fakeDb([{ id: "yt-1", status: "revoked", refreshToken: null }]);
    await expect(youTubeAccessToken({ db, key: KEY, client: CLIENT, ytAccountId: "yt-1" })).rejects.toBeInstanceOf(YouTubeAuthError);
  });
});

describe("disconnectYouTubeChannel", () => {
  it("forgets the login and cancels the scheduled posts with their jobs, but not an upload under way", async () => {
    const { db, tables } = fakeDb(
      [{ id: "yt-1", ownerId: "u1", status: "active", refreshToken: "sealed" }],
      [
        { id: "p1", ytAccountId: "yt-1", status: "scheduled", queueJobId: "job-1" },
        { id: "p2", ytAccountId: "yt-1", status: "container_created", queueJobId: "job-2" },
      ],
    );
    const canceled: string[] = [];
    await disconnectYouTubeChannel(db, { send: async () => "x", cancel: async (id) => void canceled.push(id) }, { ownerId: "u1", ytAccountId: "yt-1" });

    expect(tables.ytAccount[0]).toMatchObject({ status: "revoked", refreshToken: null });
    expect(tables.ytPost.map((post) => post.status)).toEqual(["canceled", "container_created"]);
    expect(canceled).toEqual(["job-1"]);
  });
});
