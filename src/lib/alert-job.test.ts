import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { sendOwnerAlerts } from "./alert-job";

const NOW = new Date("2026-10-12T08:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

function fakeDb() {
  const users = [
    {
      id: "user-a",
      email: "owner-a@example.com",
      accounts: [
        {
          username: "streamer",
          status: "reauth_required",
          token: { expiresAt: new Date(NOW.getTime() + 30 * DAY) },
        },
      ],
      failedPosts: [{ id: "post-1", lastError: "video too large" }],
    },
    {
      id: "user-b",
      email: "owner-b@example.com",
      accounts: [
        {
          username: "other",
          status: "active",
          token: { expiresAt: new Date(NOW.getTime() + 30 * DAY) },
        },
      ],
      failedPosts: [],
    },
  ];
  const db = {
    user: {
      findMany: async () => users.map((user) => ({ id: user.id, email: user.email, accounts: user.accounts })),
    },
    post: {
      findMany: async ({ where }: { where: { account: { ownerId: string } } }) =>
        users.find((user) => user.id === where.account.ownerId)?.failedPosts ?? [],
    },
  };
  return db as unknown as PrismaClient;
}

describe("sendOwnerAlerts", () => {
  it("emails each owner who has problems and skips owners who do not", async () => {
    const sent: Array<{ to: string; subject: string; text: string }> = [];
    const count = await sendOwnerAlerts({
      db: fakeDb(),
      now: NOW,
      send: async (message) => {
        sent.push(message);
      },
    });

    expect(count).toBe(1);
    expect(sent).toEqual([
      {
        to: "owner-a@example.com",
        subject: "Scheduler alerts (2)",
        text: "Post post-1 failed: video too large\n@streamer needs to be reconnected",
      },
    ]);
  });
});
