import { META_API_VERSION } from "./meta";
import { MetaApiError } from "./meta-errors";

const BASE = `https://graph.instagram.com/${META_API_VERSION}`;
const BUC_HEADER = "X-Business-Use-Case-Usage";
const BUC_PAUSE_THRESHOLD = 80;
// Meta reports estimated_time_to_regain_access in minutes. Verify against a live response before relying on it.
const BUC_MINUTES_TO_SECONDS = 60;

type Fetch = typeof fetch;
type BucPauseHandler = (seconds: number) => void;

async function callMeta(
  input: string,
  init: RequestInit,
  token: string,
  fetchFn: Fetch,
  onBucPause?: BucPauseHandler,
): Promise<Record<string, unknown>> {
  const response = await fetchFn(input, {
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${token}` },
  });

  const pause = bucPauseSeconds(response.headers.get(BUC_HEADER));
  if (pause > 0) onBucPause?.(pause);

  const text = await response.text();
  let body: Record<string, unknown> & { error?: { message?: string; code?: number } };
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    // A gateway error page is not JSON. Report it by status so the retry rules can classify it.
    if (!response.ok) throw new MetaApiError(response.status, undefined, `Meta returned HTTP ${response.status}`);
    throw new Error("Meta returned a non-JSON response");
  }
  if (!response.ok) {
    throw new MetaApiError(response.status, body.error?.code, body.error?.message ?? "Meta request failed");
  }
  return body;
}

export async function createContainer({
  igUserId,
  token,
  videoUrl,
  caption,
  shareToFeed,
  aiGenerated,
  fetchFn = fetch,
  onBucPause,
}: {
  igUserId: string;
  token: string;
  videoUrl: string;
  caption: string;
  shareToFeed: boolean;
  aiGenerated: boolean;
  fetchFn?: Fetch;
  onBucPause?: BucPauseHandler;
}): Promise<string> {
  const form = new URLSearchParams({
    media_type: "REELS",
    video_url: videoUrl,
    caption,
    share_to_feed: String(shareToFeed),
  });
  // Instagram's AI info label. It is only sent when set, so other posts are created exactly as before.
  if (aiGenerated) form.set("is_ai_generated", "true");
  const body = await callMeta(`${BASE}/${igUserId}/media`, { method: "POST", body: form }, token, fetchFn, onBucPause);
  return body.id as string;
}

export async function getContainerStatus({
  containerId,
  token,
  fetchFn = fetch,
  onBucPause,
}: {
  containerId: string;
  token: string;
  fetchFn?: Fetch;
  onBucPause?: BucPauseHandler;
}): Promise<string> {
  const body = await callMeta(`${BASE}/${containerId}?fields=status_code`, {}, token, fetchFn, onBucPause);
  return body.status_code as string;
}

export async function publishContainer({
  igUserId,
  containerId,
  token,
  fetchFn = fetch,
  onBucPause,
}: {
  igUserId: string;
  containerId: string;
  token: string;
  fetchFn?: Fetch;
  onBucPause?: BucPauseHandler;
}): Promise<string> {
  const body = await callMeta(
    `${BASE}/${igUserId}/media_publish`,
    { method: "POST", body: new URLSearchParams({ creation_id: containerId }) },
    token,
    fetchFn,
    onBucPause,
  );
  return body.id as string;
}

export async function getPermalink({
  igMediaId,
  token,
  fetchFn = fetch,
  onBucPause,
}: {
  igMediaId: string;
  token: string;
  fetchFn?: Fetch;
  onBucPause?: BucPauseHandler;
}): Promise<string> {
  const body = await callMeta(
    `${BASE}/${igMediaId}?fields=permalink,media_product_type`,
    {},
    token,
    fetchFn,
    onBucPause,
  );
  return body.permalink as string;
}

export async function getPublishingLimit({
  igUserId,
  token,
  fetchFn = fetch,
  onBucPause,
}: {
  igUserId: string;
  token: string;
  fetchFn?: Fetch;
  onBucPause?: BucPauseHandler;
}): Promise<{ quotaUsage: number; quotaTotal: number }> {
  const body = await callMeta(
    `${BASE}/${igUserId}/content_publishing_limit?fields=quota_usage,config`,
    {},
    token,
    fetchFn,
    onBucPause,
  );
  const entry = (body.data as Array<{ quota_usage: number; config: { quota_total: number } }>)[0];
  return { quotaUsage: entry.quota_usage, quotaTotal: entry.config.quota_total };
}

// Returns how long to pause, in seconds, when any Business Use Case usage figure has reached the threshold.
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
      if (hot) pause = Math.max(pause, entry.estimated_time_to_regain_access * BUC_MINUTES_TO_SECONDS);
    }
  }
  return pause;
}
