import type { PrismaClient } from "@/generated/prisma/client";
import { revokeAccount } from "./meta-callbacks";
import type { PublishQueue } from "./queues";
import { UserError } from "./user-error";

// The pause lengths the accounts page offers.
export const PAUSE_OPTIONS = [
  { minutes: 60, label: "1 hour" },
  { minutes: 24 * 60, label: "1 day" },
  { minutes: 7 * 24 * 60, label: "1 week" },
] as const;

async function ownedAccount(db: PrismaClient, ownerId: string, accountId: string) {
  const account = await db.igAccount.findFirst({ where: { id: accountId, ownerId } });
  if (!account) throw new UserError("account not found");
  return account;
}

// Pausing holds publishing for the account: the publish job defers while pausedUntil is in the future. It is the
// owner's own pause; a pause from Meta's rate limit is rateLimitedUntil and is not changed here.
export async function pauseAccount(
  db: PrismaClient,
  { ownerId, accountId, minutes, now }: { ownerId: string; accountId: string; minutes: number; now: Date },
) {
  if (!PAUSE_OPTIONS.some((option) => option.minutes === minutes)) {
    throw new UserError("pause must be 1 hour, 1 day or 1 week");
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
