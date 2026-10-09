import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { getInsights, parseInsights, pullInsights, scheduleInsightPulls } from "./insights";
import type { InsightQueue } from "./queues";

const HOUR = 60 * 60 * 1000;
const NOW = new Date("2026-10-12T12:00:00Z");

describe("parseInsights", () => {
  it("reads values from both the per-period and the total_value response shapes", () => {
    const body = {
      data: [
        { name: "views", values: [{ value: 1200 }] },
        { name: "likes", total_value: { value: 88 } },
        { name: "unknown_metric", values: [{ value: 5 }] },
      ],
    };
    expect(parseInsights(body)).toEqual([
      { metric: "views", value: 1200 },
      { metric: "likes", value: 88 },
    ]);
  });
});

describe("scheduleInsightPulls", () => {
  it("queues pulls at 1 hour, 24 hours, and 7 days after publishing", async () => {
    const sent: Array<{ postId: string; label: string; runAt: Date }> = [];
    const queue: InsightQueue = {
      send: async (postId, label, runAt) => {
        sent.push({ postId, label, runAt });
        return null;
      },
    };
    const publishedAt = new Date(NOW.getTime() - 2 * HOUR);

    await scheduleInsightPulls(queue, { postId: "post-1", publishedAt, now: NOW });

    expect(sent).toEqual([
      { postId: "post-1", label: "1h", runAt: NOW },
      { postId: "post-1", label: "24h", runAt: new Date(NOW.getTime() + 22 * HOUR) },
      { postId: "post-1", label: "7d", runAt: new Date(NOW.getTime() + 166 * HOUR) },
    ]);
  });
});

describe("getInsights", () => {
  it("asks Meta for the agreed metrics on the media object", async () => {
    const calls: string[] = [];
    const fetchFn = async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ data: [{ name: "views", values: [{ value: 5 }] }] }), { status: 200 });
    };
    const metrics = await getInsights({ igMediaId: "media-9", token: "t", fetchFn });

    expect(metrics).toEqual([{ metric: "views", value: 5 }]);
    expect(calls[0]).toContain("/media-9/insights?metric=views,reach,likes,comments,shares,saved,total_interactions");
  });
});

describe("pullInsights", () => {
  it("stores each metric as an Insight row for the post", async () => {
    const created: Array<Record<string, unknown>> = [];
    const db = {
      insight: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          created.push(data);
          return {};
        },
      },
    } as unknown as PrismaClient;

    await pullInsights({
      db,
      postId: "post-1",
      metrics: [
        { metric: "views", value: 1200 },
        { metric: "reach", value: 900 },
      ],
      now: NOW,
    });

    expect(created).toEqual([
      { postId: "post-1", metric: "views", value: 1200, fetchedAt: NOW },
      { postId: "post-1", metric: "reach", value: 900, fetchedAt: NOW },
    ]);
  });
});
