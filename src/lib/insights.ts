import type { PrismaClient } from "@/generated/prisma/client";
import { META_API_VERSION } from "./meta";
import { MetaApiError } from "./meta-errors";
import type { InsightQueue } from "./queues";

const METRICS = ["views", "reach", "likes", "comments", "shares", "saved", "total_interactions"];
const METRIC_LABELS: Record<string, string> = {
  views: "Views",
  reach: "Accounts reached",
  likes: "Likes",
  comments: "Comments",
  shares: "Shares",
  saved: "Saves",
  total_interactions: "All interactions",
};
const PULLS = [
  { label: "1h", title: "After 1 h", offsetMs: 60 * 60 * 1000 },
  { label: "24h", title: "After 24 h", offsetMs: 24 * 60 * 60 * 1000 },
  { label: "7d", title: "After 7 d", offsetMs: 7 * 24 * 60 * 60 * 1000 },
];

type Metric = { metric: string; value: number };

export function parseInsights(body: unknown): Metric[] {
  const data = (body as { data?: Array<Record<string, unknown>> }).data ?? [];
  const metrics: Metric[] = [];
  for (const entry of data) {
    const name = entry.name as string;
    if (!METRICS.includes(name)) continue;
    const values = entry.values as Array<{ value: number }> | undefined;
    const total = entry.total_value as { value: number } | undefined;
    const value = values?.[0]?.value ?? total?.value;
    if (typeof value === "number") metrics.push({ metric: name, value });
  }
  return metrics;
}

export async function scheduleInsightPulls(
  queue: InsightQueue,
  { postId, publishedAt, now }: { postId: string; publishedAt: Date; now: Date },
) {
  for (const pull of PULLS) {
    const runAt = new Date(Math.max(now.getTime(), publishedAt.getTime() + pull.offsetMs));
    await queue.send(postId, pull.label, runAt);
  }
}

export async function getInsights({
  igMediaId,
  token,
  fetchFn = fetch,
}: {
  igMediaId: string;
  token: string;
  fetchFn?: typeof fetch;
}): Promise<Metric[]> {
  const url = `https://graph.instagram.com/${META_API_VERSION}/${igMediaId}/insights?metric=${METRICS.join(",")}`;
  const response = await fetchFn(url, { headers: { Authorization: `Bearer ${token}` } });
  const body = (await response.json()) as { error?: { code?: number; message?: string } };
  if (!response.ok) {
    throw new MetaApiError(response.status, body.error?.code, body.error?.message ?? "insights request failed");
  }
  return parseInsights(body);
}

export async function pullInsights({
  db,
  postId,
  metrics,
  now,
}: {
  db: PrismaClient;
  postId: string;
  metrics: Metric[];
  now: Date;
}) {
  for (const metric of metrics) {
    await db.insight.create({
      data: { postId, metric: metric.metric, value: metric.value, fetchedAt: now },
    });
  }
}

export type InsightTable = {
  pulls: string[];
  rows: Array<{ metric: string; label: string; values: Array<number | null> }>;
};

// The stored insight rows as a table for the post page: a column per pull (oldest first), a row per metric. Each
// pull stores all its metrics with the same fetchedAt, so rows are grouped by it.
export function insightTable(insights: Array<{ metric: string; value: number; fetchedAt: Date }>): InsightTable {
  const times = [...new Set(insights.map((insight) => insight.fetchedAt.getTime()))].sort((a, b) => a - b);
  const pulls = times.map((_, index) => PULLS[index]?.title ?? `Pull ${index + 1}`);
  const metrics = METRICS.filter((metric) => insights.some((insight) => insight.metric === metric));
  const rows = metrics.map((metric) => ({
    metric,
    label: METRIC_LABELS[metric],
    values: times.map(
      (time) => insights.find((insight) => insight.metric === metric && insight.fetchedAt.getTime() === time)?.value ?? null,
    ),
  }));
  return { pulls, rows };
}
