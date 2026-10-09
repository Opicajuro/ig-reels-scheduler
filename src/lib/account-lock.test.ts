import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAccountLock } from "./account-lock";
import { prisma } from "./prisma";

const suffix = `${process.pid}-${Date.now()}`;
let ownerId: string;
let accountId: string;

beforeAll(async () => {
  const owner = await prisma.user.create({ data: { email: `lock-${suffix}@example.test` } });
  ownerId = owner.id;
  const account = await prisma.igAccount.create({
    data: { ownerId, igUserId: `lock-${suffix}`, username: "lock-test", accountType: "BUSINESS" },
  });
  accountId = account.id;
});

afterAll(async () => {
  await prisma.user.delete({ where: { id: ownerId } });
});

describe("createAccountLock", () => {
  it("lets one holder in at a time and admits the next holder after release", async () => {
    const lock = createAccountLock(prisma);

    expect(await lock.acquire(accountId)).toBe(true);
    expect(await lock.acquire(accountId)).toBe(false);

    await lock.release(accountId);
    expect(await lock.acquire(accountId)).toBe(true);
    await lock.release(accountId);
  });

  it("keeps a lease that has not run out", async () => {
    const lock = createAccountLock(prisma);
    await prisma.igAccount.update({ where: { id: accountId }, data: { lockedUntil: new Date(Date.now() + 60_000) } });

    expect(await lock.acquire(accountId)).toBe(false);
    await lock.release(accountId);
  });

  it("takes over a lease whose time has passed", async () => {
    const lock = createAccountLock(prisma);
    await prisma.igAccount.update({ where: { id: accountId }, data: { lockedUntil: new Date(Date.now() - 1000) } });

    expect(await lock.acquire(accountId)).toBe(true);
    await lock.release(accountId);
  });
});
