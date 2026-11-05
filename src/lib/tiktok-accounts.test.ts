import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { saveFacebookPages } from "./facebook-accounts";
import { FakeTikTok } from "./fake-tiktok";
import { openSecret, sealSecret } from "./settings";
import { TikTokAuthError } from "./tiktok";
import { saveTikTokAccount, tikTokAccessToken } from "./tiktok-accounts";

const KEY = Buffer.alloc(32, 7);
const NOW = new Date("2026-11-04T12:00:00Z");
const APP = { clientKey: "awkey", clientSecret: "secret" };

type Row = Record<string, unknown> & { id: string };

// One table with findUnique by id or by a unique field, update and upsert.
function table(name: string, rows: Row[], unique: string) {
  const find = (where: Record<string, unknown>) =>
    rows.find((row) => (where.id !== undefined ? row.id === where.id : row[unique] === where[unique])) ?? null;
  return {
    rows,
    model: {
      findUnique: async ({ where }: { where: Record<string, unknown> }) => structuredClone(find(where)),
      update: async ({ where, data }: { where: { id: string }; data: Row }) => Object.assign(find(where) as Row, data),
      upsert: async ({ where, create, update }: { where: Record<string, unknown>; create: Row; update: Row }) => {
        const existing = find(where);
        if (existing) return Object.assign(existing, update);
        const row = { ...create, id: `${name}-${rows.length + 1}` } as Row;
        rows.push(row);
        return row;
      },
    },
  };
}

describe("tikTokAccessToken", () => {
  function setup(account: Partial<Row>) {
    const accounts = table("tt", [{ id: "tt-1", status: "active", refreshToken: sealSecret("rft.0", KEY), ...account }], "openId");
    return { db: { ttAccount: accounts.model } as unknown as PrismaClient, row: () => accounts.rows[0] };
  }

  it("uses the stored access token while it has more than half an hour left", async () => {
    const { db } = setup({ accessToken: sealSecret("act.stored", KEY), accessExpiresAt: new Date(NOW.getTime() + 60 * 60_000) });
    const tiktok = new FakeTikTok();
    expect(await tikTokAccessToken({ db, key: KEY, app: APP, ttAccountId: "tt-1", now: NOW, fetchFn: tiktok.fetch })).toBe("act.stored");
    expect(tiktok.calls).toEqual([]);
  });

  it("refreshes an expiring token once for calls at the same time, and stores TikTok's new refresh token sealed", async () => {
    const { db, row } = setup({ accessToken: sealSecret("act.old", KEY), accessExpiresAt: new Date(NOW.getTime() + 5 * 60_000) });
    const tiktok = new FakeTikTok();
    const tokens = await Promise.all([1, 2].map(() => tikTokAccessToken({ db, key: KEY, app: APP, ttAccountId: "tt-1", now: NOW, fetchFn: tiktok.fetch })));
    expect(tokens).toEqual(["act.1", "act.1"]);
    expect(tiktok.refreshes).toBe(1);
    expect(new URLSearchParams(tiktok.calls[0].body).get("refresh_token")).toBe("rft.0");
    expect(openSecret(row().refreshToken as string, KEY)).toBe("rft.1");
    expect(row().accessExpiresAt).toEqual(new Date(NOW.getTime() + 86400_000));
  });

  it("marks the account as needing reconnecting when TikTok refuses the refresh token", async () => {
    const { db, row } = setup({});
    const tiktok = new FakeTikTok();
    tiktok.failures.set("POST open.tiktokapis.com/v2/oauth/token/", new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }));
    await expect(tikTokAccessToken({ db, key: KEY, app: APP, ttAccountId: "tt-1", now: NOW, fetchFn: tiktok.fetch })).rejects.toThrow(
      TikTokAuthError,
    );
    expect(row().status).toBe("reauth_required");
  });
});

describe("saving connections", () => {
  it("stores a TikTok account's tokens sealed and reconnects it in place", async () => {
    const accounts = table("tt", [], "openId");
    const db = { ttAccount: accounts.model } as unknown as PrismaClient;
    const tokens = { accessToken: "act.0", refreshToken: "rft.0", openId: "open-1", accessExpiresAt: NOW };
    await saveTikTokAccount(db, KEY, { ownerId: "user-1", displayName: "Baker Bea", tokens });
    await saveTikTokAccount(db, KEY, { ownerId: "user-1", displayName: "Bea", tokens: { ...tokens, refreshToken: "rft.9" } });
    expect(accounts.rows).toHaveLength(1);
    expect(accounts.rows[0]).toMatchObject({ displayName: "Bea", status: "active" });
    expect(accounts.rows[0].refreshToken).not.toContain("rft");
    expect(openSecret(accounts.rows[0].refreshToken as string, KEY)).toBe("rft.9");
  });

  it("stores only the picked Facebook Pages, with their tokens sealed", async () => {
    const pages = table("fb", [], "pageId");
    const db = { fbPage: pages.model } as unknown as PrismaClient;
    const managed = [
      { pageId: "page-1", name: "Bakery", accessToken: "page-token-1" },
      { pageId: "page-3", name: "Third", accessToken: "page-token-3" },
    ];
    await saveFacebookPages(db, KEY, { ownerId: "user-1", pages: managed, pageIds: ["page-3", "page-404"] });
    expect(pages.rows.map((row) => row.pageId)).toEqual(["page-3"]);
    expect(openSecret(pages.rows[0].pageToken as string, KEY)).toBe("page-token-3");
    await expect(saveFacebookPages(db, KEY, { ownerId: "user-1", pages: managed, pageIds: [] })).rejects.toThrow("pick at least one Page");
  });
});
