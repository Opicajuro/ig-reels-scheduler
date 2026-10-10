import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@/generated/prisma/client";
import { encryptToken } from "./token-crypto";

const DAY_MS = 24 * 60 * 60 * 1000;

// Mock accounts are a deliberate opt-in for local UI testing: only under `next dev`, and only with IG_MOCK=true.
// The installed app runs under `next start` (production), so the route never exists there.
export function mockConnectEnabled(env: { NODE_ENV?: string; IG_MOCK?: string }): boolean {
  return env.NODE_ENV === "development" && env.IG_MOCK === "true";
}

// An account with a fake token that decrypts like a real one. It shows up on /accounts and in the schedule forms;
// publishing with it fails at Meta. Its igUserId starts with "mock-" so mock accounts are easy to find and delete.
export async function createMockAccount(
  db: PrismaClient,
  { ownerId, key, username, expired = false }: { ownerId: string; key: Buffer; username?: string; expired?: boolean },
) {
  const sealed = encryptToken(`fake-token-${randomBytes(16).toString("hex")}`, key);
  return db.igAccount.create({
    data: {
      ownerId,
      igUserId: `mock-${randomBytes(8).toString("hex")}`,
      username: username ?? `mock_${randomBytes(3).toString("hex")}`,
      accountType: "BUSINESS",
      status: expired ? "reauth_required" : "active",
      token: {
        create: {
          ciphertext: new Uint8Array(sealed.ciphertext),
          iv: new Uint8Array(sealed.iv),
          authTag: new Uint8Array(sealed.authTag),
          expiresAt: new Date(Date.now() + (expired ? -1 : 60) * DAY_MS),
        },
      },
    },
  });
}
