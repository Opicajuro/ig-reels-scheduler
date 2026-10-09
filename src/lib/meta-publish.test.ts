import { describe, expect, it } from "vitest";
import { classifyMetaError, MetaApiError } from "./meta-errors";
import {
  bucPauseSeconds,
  createContainer,
  getContainerStatus,
  getPermalink,
  getPublishingLimit,
  publishContainer,
} from "./meta-publish";

const BASE = "https://graph.instagram.com/v26.0";

function fakeFetch(
  body: unknown,
  init: { status?: number; headers?: Record<string, string>; raw?: string } = {},
) {
  const calls: Array<{ url: string; method: string; body?: BodyInit | null; auth?: string | null }> = [];
  const fetchFn = async (input: RequestInfo | URL, reqInit?: RequestInit) => {
    calls.push({
      url: String(input),
      method: reqInit?.method ?? "GET",
      body: reqInit?.body,
      auth: new Headers(reqInit?.headers).get("Authorization"),
    });
    const text = init.raw ?? JSON.stringify(body);
    return new Response(text, { status: init.status ?? 200, headers: init.headers });
  };
  return { fetchFn: fetchFn as typeof fetch, calls };
}

describe("createContainer", () => {
  it("creates a REELS container for the account and returns its id", async () => {
    const { fetchFn, calls } = fakeFetch({ id: "container-1" });
    const id = await createContainer({
      igUserId: "17841",
      token: "tok",
      videoUrl: "https://storage/reel.mp4",
      caption: "hi",
      shareToFeed: true,
      fetchFn,
    });

    expect(id).toBe("container-1");
    expect(calls[0].url).toBe(`${BASE}/17841/media`);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].auth).toBe("Bearer tok");
    const form = calls[0].body as URLSearchParams;
    expect(form.get("media_type")).toBe("REELS");
    expect(form.get("video_url")).toBe("https://storage/reel.mp4");
    expect(form.get("share_to_feed")).toBe("true");
  });

  it("throws a MetaApiError carrying Meta's error code", async () => {
    const { fetchFn } = fakeFetch({ error: { message: "bad", code: 100 } }, { status: 400 });
    await expect(
      createContainer({ igUserId: "1", token: "t", videoUrl: "u", caption: "", shareToFeed: true, fetchFn }),
    ).rejects.toMatchObject({ code: 100, status: 400 });
  });

  it("treats a 502 with an HTML body as a retryable server error, not a permanent failure", async () => {
    const { fetchFn } = fakeFetch(null, { status: 502, raw: "<html>Bad Gateway</html>" });
    const err = await createContainer({
      igUserId: "1",
      token: "t",
      videoUrl: "u",
      caption: "",
      shareToFeed: true,
      fetchFn,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MetaApiError);
    expect((err as MetaApiError).status).toBe(502);
    expect(classifyMetaError(err)).toBe("retry");
  });

  it("reports a rate-limit pause to the caller in seconds", async () => {
    const usage = JSON.stringify({
      "17841": [{ call_count: 85, total_time: 10, total_cputime: 5, estimated_time_to_regain_access: 15 }],
    });
    const { fetchFn } = fakeFetch({ id: "container-1" }, { headers: { "X-Business-Use-Case-Usage": usage } });
    const pauses: number[] = [];
    await createContainer({
      igUserId: "17841",
      token: "t",
      videoUrl: "u",
      caption: "",
      shareToFeed: true,
      fetchFn,
      onBucPause: (seconds) => pauses.push(seconds),
    });
    expect(pauses).toEqual([15 * 60]);
  });
});

describe("getContainerStatus", () => {
  it("reads status_code for the container", async () => {
    const { fetchFn, calls } = fakeFetch({ status_code: "FINISHED" });
    expect(await getContainerStatus({ containerId: "c1", token: "t", fetchFn })).toBe("FINISHED");
    expect(calls[0].url).toBe(`${BASE}/c1?fields=status_code`);
  });
});

describe("publishContainer", () => {
  it("publishes the container and returns the media id", async () => {
    const { fetchFn, calls } = fakeFetch({ id: "media-9" });
    expect(await publishContainer({ igUserId: "17841", containerId: "c1", token: "t", fetchFn })).toBe("media-9");
    expect(calls[0].url).toBe(`${BASE}/17841/media_publish`);
    expect((calls[0].body as URLSearchParams).get("creation_id")).toBe("c1");
  });
});

describe("getPermalink", () => {
  it("reads the permalink of a published media", async () => {
    const { fetchFn, calls } = fakeFetch({ permalink: "https://instagram.com/reel/abc" });
    expect(await getPermalink({ igMediaId: "media-9", token: "t", fetchFn })).toBe(
      "https://instagram.com/reel/abc",
    );
    expect(calls[0].url).toBe(`${BASE}/media-9?fields=permalink,media_product_type`);
  });
});

describe("getPublishingLimit", () => {
  it("returns usage and total for the account's 24 hour window", async () => {
    const { fetchFn, calls } = fakeFetch({
      data: [{ quota_usage: 12, config: { quota_total: 100, quota_duration: 86400 } }],
    });
    expect(await getPublishingLimit({ igUserId: "17841", token: "t", fetchFn })).toEqual({
      quotaUsage: 12,
      quotaTotal: 100,
    });
    expect(calls[0].url).toBe(`${BASE}/17841/content_publishing_limit?fields=quota_usage,config`);
  });

  it("maps Meta errors to MetaApiError", async () => {
    const { fetchFn } = fakeFetch({ error: { code: 190, message: "expired" } }, { status: 400 });
    await expect(getPublishingLimit({ igUserId: "1", token: "t", fetchFn })).rejects.toBeInstanceOf(MetaApiError);
  });
});

describe("bucPauseSeconds", () => {
  it("returns 0 when every usage percentage is under 80", () => {
    const header = JSON.stringify({
      "17841": [{ call_count: 40, total_time: 10, total_cputime: 5, estimated_time_to_regain_access: 0 }],
    });
    expect(bucPauseSeconds(header)).toBe(0);
  });

  it("returns the regain time, converted from minutes to seconds, when any percentage reaches 80", () => {
    const header = JSON.stringify({
      "17841": [{ call_count: 85, total_time: 10, total_cputime: 5, estimated_time_to_regain_access: 15 }],
    });
    expect(bucPauseSeconds(header)).toBe(900);
  });

  it("returns 0 when the header is absent", () => {
    expect(bucPauseSeconds(null)).toBe(0);
  });
});
