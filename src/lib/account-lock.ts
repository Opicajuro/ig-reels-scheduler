import type Redis from "ioredis";

const LOCK_TTL_MS = 15 * 60 * 1000;

export function createAccountLock(redis: Redis) {
  return {
    async acquire(accountId: string): Promise<boolean> {
      const result = await redis.set(`account-lock:${accountId}`, "held", "PX", LOCK_TTL_MS, "NX");
      return result === "OK";
    },
    async release(accountId: string): Promise<void> {
      await redis.del(`account-lock:${accountId}`);
    },
  };
}
