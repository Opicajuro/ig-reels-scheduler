import type { PrismaClient } from "@/generated/prisma/client";
import { revokeAccount } from "./meta-callbacks";
import type { PublishQueue } from "./queues";

const MAX_PAUSE_MINUTES = 7 * 24 * 60;

async function ownedAccount(db: PrismaClient, ownerId: string, accountId: string) {
  const account = await db.igAccount.findFirst({ where: { id: accountId, ownerId } });
  if (!account) throw new Error("account not found");
  return account;
}

// Pausing holds publishing for the account: the publish job defers while pausedUntil is in the future.
export async function pauseAccount(
  db: PrismaClient,
  { ownerId, accountId, minutes, now }: { ownerId: string; accountId: string; minutes: number; now: Date },
) {
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_PAUSE_MINUTES) {
    throw new Error(`pause must be a whole number of minutes from 1 to ${MAX_PAUSE_MINUTES}`);
  }
  await ownedAccount(db, ownerId, accountId);
  await db.igAccount.update({ where: { id: accountId }, data: { pausedUntil: new Date(now.getTime() + minutes * 60_000) } });
}

export async function resumeAccount(db: PrismaClient, { ownerId, accountId }: { ownerId: string; accountId: string }) {
  await ownedAccount(db, ownerId, accountId);
  await db.igAccount.update({ where: { id: accountId }, data: { pausedUntil: null } });
}

// Disconnecting keeps the history (posts, attempts) but stops new publishes, the same as Meta's deauthorize
// callback: the account is revoked and its scheduled and in-progress posts are canceled with their jobs.
export async function disconnectAccount(
  db: PrismaClient,
  queue: PublishQueue,
  { ownerId, accountId }: { ownerId: string; accountId: string },
) {
  const account = await ownedAccount(db, ownerId, accountId);
  await revokeAccount(db, queue, account.igUserId);
}
