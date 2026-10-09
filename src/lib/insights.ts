import type { PrismaClient } from "@/generated/prisma/client";
import { META_API_VERSION } from "./meta";
import { MetaApiError } from "./meta-errors";
import type { PublishQueue } from "./scheduling";

const METRICS = ["views", "reach", "likes", "comments", "shares", "saved", "total_interactions"];
const PULLS = [
  { label: "1h", offsetMs: 60 * 60 * 1000 },
  { label: "24h", offsetMs: 24 * 60 * 60 * 1000 },
  { label: "7d", offsetMs: 7 * 24 * 60 * 60 * 1000 },
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
  queue: PublishQueue,
  { postId, publishedAt, now }: { postId: string; publishedAt: Date; now: Date },
) {
  for (const pull of PULLS) {
    const delay = Math.max(0, publishedAt.getTime() + pull.offsetMs - now.getTime());
    await queue.add("pull", { postId }, { jobId: `${postId}:${pull.label}`, delay });
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
