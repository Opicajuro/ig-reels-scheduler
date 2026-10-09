import type { PrismaClient } from "@/generated/prisma/client";
import { decryptToken, encryptToken } from "./token-crypto";
import { decideRefresh, refreshToken, TokenInvalidError } from "./token-refresh";

const REFRESH_WINDOW_MS = 10 * 24 * 60 * 60 * 1000;

export async function refreshDueTokens(
  db: PrismaClient,
  { now, key, fetchFn = fetch }: { now: Date; key: Buffer; fetchFn?: typeof fetch },
) {
  const rows = await db.igToken.findMany({
    where: { expiresAt: { lte: new Date(now.getTime() + REFRESH_WINDOW_MS) } },
  });

  for (const row of rows) {
    const decision = decideRefresh({ expiresAt: row.expiresAt, lastRefreshedAt: row.lastRefreshedAt, now });
    if (decision === "skip") continue;
    if (decision === "reauth") {
      await markReauthRequired(db, row.accountId);
      continue;
    }

    try {
      const current = decryptToken(
        {
          ciphertext: Buffer.from(row.ciphertext),
          iv: Buffer.from(row.iv),
          authTag: Buffer.from(row.authTag),
        },
        key,
      );
      const fresh = await refreshToken(current, fetchFn);
      const sealed = encryptToken(fresh.accessToken, key);
      await db.igToken.update({
        where: { accountId: row.accountId },
        data: {
          ciphertext: new Uint8Array(sealed.ciphertext),
          iv: new Uint8Array(sealed.iv),
          authTag: new Uint8Array(sealed.authTag),
          expiresAt: new Date(now.getTime() + fresh.expiresInSeconds * 1000),
          lastRefreshedAt: now,
        },
      });
    } catch (err) {
      if (!(err instanceof TokenInvalidError)) throw err;
      await markReauthRequired(db, row.accountId);
    }
  }
}

async function markReauthRequired(db: PrismaClient, accountId: string) {
  await db.igAccount.update({
    where: { id: accountId },
    data: { status: "reauth_required" },
  });
}
