import { META_API_VERSION } from "./meta";
import { MetaApiError } from "./meta-errors";

const BASE = `https://graph.instagram.com/${META_API_VERSION}`;
const BUC_PAUSE_THRESHOLD = 80;

type Fetch = typeof fetch;

async function callMeta(input: string, init: RequestInit, token: string, fetchFn: Fetch) {
  const response = await fetchFn(input, {
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${token}` },
  });
  const body = (await response.json()) as Record<string, unknown> & {
    error?: { message?: string; code?: number };
  };
  if (!response.ok) {
    throw new MetaApiError(response.status, body.error?.code, body.error?.message ?? "Meta request failed");
  }
  return { body, headers: response.headers };
}

export async function createContainer({
  igUserId,
  token,
  videoUrl,
  caption,
  shareToFeed,
  fetchFn = fetch,
}: {
  igUserId: string;
  token: string;
  videoUrl: string;
  caption: string;
  shareToFeed: boolean;
  fetchFn?: Fetch;
}): Promise<string> {
  const form = new URLSearchParams({
    media_type: "REELS",
    video_url: videoUrl,
    caption,
    share_to_feed: String(shareToFeed),
  });
  const { body } = await callMeta(`${BASE}/${igUserId}/media`, { method: "POST", body: form }, token, fetchFn);
  return body.id as string;
}

export async function getContainerStatus({
  containerId,
  token,
  fetchFn = fetch,
}: {
  containerId: string;
  token: string;
  fetchFn?: Fetch;
}): Promise<string> {
  const { body } = await callMeta(`${BASE}/${containerId}?fields=status_code`, {}, token, fetchFn);
  return body.status_code as string;
}

export async function publishContainer({
  igUserId,
  containerId,
  token,
  fetchFn = fetch,
}: {
  igUserId: string;
  containerId: string;
  token: string;
  fetchFn?: Fetch;
}): Promise<string> {
  const { body } = await callMeta(
    `${BASE}/${igUserId}/media_publish`,
    { method: "POST", body: new URLSearchParams({ creation_id: containerId }) },
    token,
    fetchFn,
  );
  return body.id as string;
}

export async function getPermalink({
  igMediaId,
  token,
  fetchFn = fetch,
}: {
  igMediaId: string;
  token: string;
  fetchFn?: Fetch;
}): Promise<string> {
  const { body } = await callMeta(`${BASE}/${igMediaId}?fields=permalink,media_product_type`, {}, token, fetchFn);
  return body.permalink as string;
}

export async function getPublishingLimit({
  igUserId,
  token,
  fetchFn = fetch,
}: {
  igUserId: string;
  token: string;
  fetchFn?: Fetch;
}): Promise<{ quotaUsage: number; quotaTotal: number }> {
  const { body } = await callMeta(
    `${BASE}/${igUserId}/content_publishing_limit?fields=quota_usage,config`,
    {},
    token,
    fetchFn,
  );
  const entry = (body.data as Array<{ quota_usage: number; config: { quota_total: number } }>)[0];
  return { quotaUsage: entry.quota_usage, quotaTotal: entry.config.quota_total };
}

export function bucPauseSeconds(header: string | null): number {
  if (!header) return 0;
  const usage = JSON.parse(header) as Record<
    string,
    Array<{ call_count: number; total_time: number; total_cputime: number; estimated_time_to_regain_access: number }>
  >;
  let pause = 0;
  for (const entries of Object.values(usage)) {
    for (const entry of entries) {
      const hot = Math.max(entry.call_count, entry.total_time, entry.total_cputime) >= BUC_PAUSE_THRESHOLD;
      if (hot) pause = Math.max(pause, entry.estimated_time_to_regain_access);
    }
  }
  return pause;
}
