import { afterAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import { createAccountLock } from "./account-lock";

const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", { lazyConnect: false, maxRetriesPerRequest: 1 });

afterAll(async () => {
  await redis.quit();
});

describe("createAccountLock", () => {
  it("lets one holder in at a time and admits the next holder after release", async () => {
    const lock = createAccountLock(redis);
    const key = `test-lock-${Date.now()}`;

    expect(await lock.acquire(key)).toBe(true);
    expect(await lock.acquire(key)).toBe(false);

    await lock.release(key);
    expect(await lock.acquire(key)).toBe(true);
    await lock.release(key);
  });

  it("expires a lock whose holder never released it", async () => {
    const lock = createAccountLock(redis);
    const key = `test-lock-expiry-${Date.now()}`;
    await redis.set(`account-lock:${key}`, "stale", "PX", 50);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await lock.acquire(key)).toBe(true);
    await lock.release(key);
  });
});
