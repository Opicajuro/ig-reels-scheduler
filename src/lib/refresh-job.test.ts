import type { PrismaClient } from "@/generated/prisma/client";
import { describe, expect, it } from "vitest";
import { refreshDueTokens } from "./refresh-job";
import { decryptToken, encryptToken } from "./token-crypto";

const KEY = Buffer.alloc(32, 7);
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-09T12:00:00Z");

function sealRow(token: string, expiresAt: Date, lastRefreshedAt: Date | null, accountId = "acc-1") {
  const sealed = encryptToken(token, KEY);
  return {
    accountId,
    ciphertext: sealed.ciphertext,
    iv: sealed.iv,
    authTag: sealed.authTag,
    expiresAt,
    lastRefreshedAt,
    account: { id: accountId },
  };
}

function fakeDb(rows: ReturnType<typeof sealRow>[]) {
  const writes: Array<{ model: string; args: unknown }> = [];
  const queries: unknown[] = [];
  const db = {
    igToken: {
      findMany: async (args: unknown) => {
        queries.push(args);
        return rows;
      },
      update: async (args: unknown) => {
        writes.push({ model: "igToken", args });
        return {};
      },
    },
    igAccount: {
      update: async (args: unknown) => {
        writes.push({ model: "igAccount", args });
        return {};
      },
    },
  };
  return { db: db as unknown as PrismaClient, writes, queries };
}

function fakeMeta(status: number, body: unknown) {
  return async () => new Response(JSON.stringify(body), { status });
}

describe("refreshDueTokens", () => {
  it("refreshes a token that is expiring soon and stores the new one encrypted", async () => {
    const { db, writes } = fakeDb([
      sealRow("old-token", new Date(NOW.getTime() + 5 * DAY), new Date(NOW.getTime() - 2 * DAY)),
    ]);
    const fetchFn = fakeMeta(200, { access_token: "new-token", expires_in: 5184000 });

    await refreshDueTokens(db, { now: NOW, key: KEY, fetchFn });

    expect(writes).toHaveLength(1);
    const update = writes[0].args as { data: Record<string, unknown> };
    expect(writes[0].model).toBe("igToken");
    expect(update.data.lastRefreshedAt).toEqual(NOW);
    expect(update.data.expiresAt).toEqual(new Date(NOW.getTime() + 5184000 * 1000));
    const stored = {
      ciphertext: Buffer.from(update.data.ciphertext as Uint8Array),
      iv: Buffer.from(update.data.iv as Uint8Array),
      authTag: Buffer.from(update.data.authTag as Uint8Array),
    };
    expect(decryptToken(stored, KEY)).toBe("new-token");
  });

  it("leaves a token alone when it was refreshed less than 24 hours ago", async () => {
    const { db, writes } = fakeDb([
      sealRow("old-token", new Date(NOW.getTime() + 5 * DAY), new Date(NOW.getTime() - 3600_000)),
    ]);
    const fetchFn = fakeMeta(200, { access_token: "unused", expires_in: 1 });

    await refreshDueTokens(db, { now: NOW, key: KEY, fetchFn });

    expect(writes).toHaveLength(0);
  });

  it("marks the account for reauthorization when its token has already expired", async () => {
    const { db, writes } = fakeDb([
      sealRow("old-token", new Date(NOW.getTime() - 1000), new Date(NOW.getTime() - 61 * DAY)),
    ]);
    const fetchFn = fakeMeta(200, { access_token: "unused", expires_in: 1 });

    await refreshDueTokens(db, { now: NOW, key: KEY, fetchFn });

    expect(writes).toEqual([
      { model: "igAccount", args: { where: { id: "acc-1" }, data: { status: "reauth_required" } } },
    ]);
  });

  it("marks the account for reauthorization when Meta returns error 190", async () => {
    const { db, writes } = fakeDb([
      sealRow("old-token", new Date(NOW.getTime() + 5 * DAY), new Date(NOW.getTime() - 2 * DAY)),
    ]);
    const fetchFn = fakeMeta(400, { error: { code: 190, message: "Session has expired" } });

    await refreshDueTokens(db, { now: NOW, key: KEY, fetchFn });

    expect(writes).toEqual([
      { model: "igAccount", args: { where: { id: "acc-1" }, data: { status: "reauth_required" } } },
    ]);
  });

  it("only looks at active accounts, so a revoked account is never turned into reauth_required", async () => {
    const { db, queries } = fakeDb([]);
    await refreshDueTokens(db, { now: NOW, key: KEY, fetchFn: fakeMeta(200, {}) });
    expect(queries[0]).toMatchObject({ where: { account: { status: "active" } } });
  });

  it("keeps refreshing the other accounts when one fails with a non-JSON error, then reports it", async () => {
    const due = new Date(NOW.getTime() + 5 * DAY);
    const old = new Date(NOW.getTime() - 2 * DAY);
    const { db, writes } = fakeDb([sealRow("token-1", due, old, "acc-1"), sealRow("token-2", due, old, "acc-2")]);
    let call = 0;
    const fetchFn = async () =>
      ++call === 1
        ? new Response("<html>Bad Gateway</html>", { status: 502 })
        : new Response(JSON.stringify({ access_token: "new-2", expires_in: 5184000 }), { status: 200 });

    await expect(refreshDueTokens(db, { now: NOW, key: KEY, fetchFn })).rejects.toThrow(/1 account\(s\): acc-1: token refresh failed with 502/);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ model: "igToken", args: { where: { accountId: "acc-2" } } });
  });
});
