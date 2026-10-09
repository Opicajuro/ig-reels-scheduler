import type { PrismaClient } from "@/generated/prisma/client";

const LOCK_TTL_MS = 15 * 60 * 1000;

// Holds the publish lock for an account as a lease stored on the account row. A lease whose time has passed
// can be taken, so a worker that dies mid-publish does not block the account for longer than LOCK_TTL_MS.
export function createAccountLock(db: PrismaClient) {
  return {
    async acquire(accountId: string): Promise<boolean> {
      const now = new Date();
      const { count } = await db.igAccount.updateMany({
        where: { id: accountId, OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] },
        data: { lockedUntil: new Date(now.getTime() + LOCK_TTL_MS) },
      });
      return count === 1;
    },
    async release(accountId: string): Promise<void> {
      await db.igAccount.updateMany({ where: { id: accountId }, data: { lockedUntil: null } });
    },
  };
}
