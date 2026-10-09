import { prisma } from "@/lib/prisma";
import type { ConnectedAccount } from "@/lib/ig-connect";
import { encryptToken, loadTokenKey } from "@/lib/token-crypto";

export async function saveConnectedAccount(ownerId: string, account: ConnectedAccount) {
  const existing = await prisma.igAccount.findUnique({ where: { igUserId: account.igUserId } });
  if (existing && existing.ownerId !== ownerId) {
    throw new Error("this Instagram account is already connected to another user");
  }

  const now = new Date();
  const sealed = encryptToken(account.accessToken, loadTokenKey());
  const token = {
    ciphertext: new Uint8Array(sealed.ciphertext),
    iv: new Uint8Array(sealed.iv),
    authTag: new Uint8Array(sealed.authTag),
    expiresAt: new Date(now.getTime() + account.expiresInSeconds * 1000),
    lastRefreshedAt: now,
  };

  return prisma.igAccount.upsert({
    where: { igUserId: account.igUserId },
    create: {
      ownerId,
      igUserId: account.igUserId,
      username: account.username,
      accountType: account.accountType,
      status: "active",
      token: { create: token },
    },
    update: {
      username: account.username,
      accountType: account.accountType,
      status: "active",
      token: { upsert: { create: token, update: token } },
    },
  });
}
