import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { sendOwnerAlerts } from "./alert-job";

const NOW = new Date("2026-10-12T08:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

function fakeDb({ failedPosts, status }: { failedPosts: Array<{ id: string; lastError: string }>; status: string }) {
  const db = {
    post: { findMany: async () => failedPosts },
    igAccount: {
      findMany: async () => [
        { username: "streamer", status, token: { expiresAt: new Date(NOW.getTime() + 30 * DAY) } },
      ],
    },
  };
  return db as unknown as PrismaClient;
}

describe("sendOwnerAlerts", () => {
  it("emails the owner a list of the problems", async () => {
    const sent: Array<{ subject: string; text: string }> = [];
    const result = await sendOwnerAlerts({
      db: fakeDb({ failedPosts: [{ id: "post-1", lastError: "video too large" }], status: "reauth_required" }),
      ownerId: "owner-1",
      now: NOW,
      send: async (message) => {
        sent.push(message);
      },
    });

    expect(result).toBe(true);
    expect(sent).toEqual([
      {
        subject: "Scheduler alerts (2)",
        text: "Post post-1 failed: video too large\n@streamer needs to be reconnected",
      },
    ]);
  });

  it("sends nothing when everything is healthy", async () => {
    const sent: unknown[] = [];
    const result = await sendOwnerAlerts({
      db: fakeDb({ failedPosts: [], status: "active" }),
      ownerId: "owner-1",
      now: NOW,
      send: async (message) => {
        sent.push(message);
      },
    });

    expect(result).toBe(false);
    expect(sent).toEqual([]);
  });
});
