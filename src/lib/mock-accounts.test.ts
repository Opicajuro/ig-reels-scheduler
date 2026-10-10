import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { createMockAccount, mockConnectEnabled } from "./mock-accounts";
import { decryptToken } from "./token-crypto";

const KEY = Buffer.alloc(32, 3);

describe("mockConnectEnabled", () => {
  it("is on only under next dev with IG_MOCK=true", () => {
    expect(mockConnectEnabled({ NODE_ENV: "development", IG_MOCK: "true" })).toBe(true);
    expect(mockConnectEnabled({ NODE_ENV: "production", IG_MOCK: "true" })).toBe(false);
    expect(mockConnectEnabled({ NODE_ENV: "development" })).toBe(false);
    expect(mockConnectEnabled({ NODE_ENV: "development", IG_MOCK: "1" })).toBe(false);
  });
});

describe("createMockAccount", () => {
  function fakeDb() {
    const created: Array<Record<string, unknown>> = [];
    const db = {
      igAccount: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          created.push(data);
          return { id: "acc-1", ...data };
        },
      },
    };
    return { db: db as unknown as PrismaClient, created };
  }

  it("creates an active account with a fake token that decrypts with the app's key", async () => {
    const { db, created } = fakeDb();
    await createMockAccount(db, { ownerId: "user-1", key: KEY, username: "clips_daily" });

    const data = created[0] as {
      ownerId: string;
      igUserId: string;
      username: string;
      status: string;
      token: { create: { ciphertext: Uint8Array; iv: Uint8Array; authTag: Uint8Array; expiresAt: Date } };
    };
    expect(data).toMatchObject({ ownerId: "user-1", username: "clips_daily", status: "active" });
    expect(data.igUserId).toMatch(/^mock-/);
    const token = data.token.create;
    const plain = decryptToken(
      { ciphertext: Buffer.from(token.ciphertext), iv: Buffer.from(token.iv), authTag: Buffer.from(token.authTag) },
      KEY,
    );
    expect(plain).toMatch(/^fake-token-/);
    expect(token.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("creates a reauth_required account with an expired token when asked", async () => {
    const { db, created } = fakeDb();
    await createMockAccount(db, { ownerId: "user-1", key: KEY, expired: true });

    const data = created[0] as { username: string; status: string; token: { create: { expiresAt: Date } } };
    expect(data.status).toBe("reauth_required");
    expect(data.username).toMatch(/^mock_/);
    expect(data.token.create.expiresAt.getTime()).toBeLessThan(Date.now());
  });
});
