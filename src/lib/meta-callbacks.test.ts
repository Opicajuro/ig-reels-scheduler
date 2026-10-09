import type { PrismaClient } from "@/generated/prisma/client";
import { describe, expect, it } from "vitest";
import { purgeUserData, revokeAccount } from "./meta-callbacks";

function fakeDb() {
  const calls: Array<{ model: string; method: string; args: unknown }> = [];
  const record = (model: string, method: string) => async (args: unknown) => {
    calls.push({ model, method, args });
    return { count: 1 };
  };
  const db = {
    igAccount: { updateMany: record("igAccount", "updateMany"), deleteMany: record("igAccount", "deleteMany") },
    post: { updateMany: record("post", "updateMany") },
  };
  return { db: db as unknown as PrismaClient, calls };
}

describe("revokeAccount", () => {
  it("marks the account revoked and cancels its scheduled posts", async () => {
    const { db, calls } = fakeDb();
    await revokeAccount(db, "17841");

    expect(calls).toEqual([
      {
        model: "igAccount",
        method: "updateMany",
        args: { where: { igUserId: "17841" }, data: { status: "revoked" } },
      },
      {
        model: "post",
        method: "updateMany",
        args: {
          where: { account: { igUserId: "17841" }, status: "scheduled" },
          data: { status: "canceled" },
        },
      },
    ]);
  });
});

describe("purgeUserData", () => {
  it("deletes the account, relying on cascades for tokens, media, and posts", async () => {
    const { db, calls } = fakeDb();
    await purgeUserData(db, "17841");

    expect(calls).toEqual([
      { model: "igAccount", method: "deleteMany", args: { where: { igUserId: "17841" } } },
    ]);
  });
});
