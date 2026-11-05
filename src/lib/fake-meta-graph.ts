// A fake of the Graph API and rupload.facebook.com for the Facebook tests: OAuth, the Page list, and the Reels
// Publishing API's start, upload, finish and status, as fetch.

export type GraphCall = { method: string; url: URL; headers: Headers; body: string };

type Phase = { status: string; bytes_transfered?: number; error?: { message: string } };

export type FakeReel = {
  uploading: Phase;
  processing: Phase;
  publishing: Phase;
  // Status reads left before a finished Reel shows as published.
  pollsUntilPublished: number;
};

export function graphError(status: number, code: number, message = `error ${code}`) {
  return new Response(JSON.stringify({ error: { message, type: "OAuthException", code } }), { status });
}

export class FakeGraph {
  calls: GraphCall[] = [];
  reels = new Map<string, FakeReel>();
  nextVideo = 1;
  pollsUntilPublished = 1;
  // An answer given instead of the usual one, for the first call whose "METHOD path" starts with the key.
  failures = new Map<string, Response | Error>();

  fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body instanceof Blob ? `<${init.body.size} bytes>` : String(init?.body ?? "");
    const headers = new Headers(init?.headers);
    this.calls.push({ method, url, headers, body });
    const route = `${method} ${url.host}${url.pathname}`;
    for (const [key, answer] of this.failures) {
      if (route.startsWith(key)) {
        this.failures.delete(key);
        if (answer instanceof Error) throw answer;
        return answer;
      }
    }
    return this.answer(method, url, headers, body);
  }) as typeof fetch;

  private params(url: URL, body: string): URLSearchParams {
    return url.search ? url.searchParams : new URLSearchParams(body);
  }

  private answer(method: string, url: URL, headers: Headers, body: string): Response {
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
    const path = url.pathname.replace(/^\/v\d+\.\d+\//, "/");
    if (url.host === "rupload.facebook.com") {
      const videoId = url.pathname.split("/").pop() as string;
      const reel = this.reels.get(videoId);
      if (!reel) return graphError(400, 100, "unknown video");
      const size = Number(headers.get("file_size") ?? 0);
      reel.uploading = { status: "complete", bytes_transfered: headers.get("file_url") ? undefined : size };
      return json({ success: true });
    }
    if (path === "/oauth/access_token") {
      const params = this.params(url, body);
      return json({ access_token: params.get("grant_type") === "fb_exchange_token" ? "long-user-token" : "short-user-token" });
    }
    if (path === "/me/permissions") {
      return json({
        data: [
          { permission: "pages_show_list", status: "granted" },
          { permission: "pages_read_engagement", status: "granted" },
          { permission: "pages_manage_posts", status: "granted" },
        ],
      });
    }
    if (path === "/me/accounts") {
      if (url.searchParams.get("after") === "2") {
        return json({ data: [{ id: "page-3", name: "Third", access_token: "page-token-3", tasks: ["CREATE_CONTENT"] }] });
      }
      return json({
        data: [
          { id: "page-1", name: "Bakery", access_token: "page-token-1", tasks: ["MANAGE", "CREATE_CONTENT"] },
          { id: "page-2", name: "Analytics only", access_token: "page-token-2", tasks: ["ANALYZE"] },
        ],
        paging: { next: `https://graph.facebook.com/v26.0/me/accounts?access_token=x&after=2` },
      });
    }
    const reelsMatch = /^\/([^/]+)\/video_reels$/.exec(path);
    if (method === "POST" && reelsMatch) {
      const params = this.params(url, body);
      if (params.get("upload_phase") === "start") {
        const videoId = `video-${this.nextVideo++}`;
        this.reels.set(videoId, {
          uploading: { status: "not_started" },
          processing: { status: "not_started" },
          publishing: { status: "not_started" },
          pollsUntilPublished: this.pollsUntilPublished,
        });
        return json({ video_id: videoId, upload_url: `https://rupload.facebook.com/video-upload/${videoId}` });
      }
      const reel = this.reels.get(params.get("video_id") ?? "");
      if (!reel) return graphError(400, 100, "unknown video");
      reel.processing = { status: "in_progress" };
      reel.publishing = { status: "in_progress" };
      return json({ success: true, post_id: `${reelsMatch[1]}_${params.get("video_id")}` });
    }
    const videoMatch = /^\/(video-\d+)$/.exec(path);
    if (method === "GET" && videoMatch) {
      const reel = this.reels.get(videoMatch[1]);
      if (!reel) return graphError(400, 100, "unknown video");
      if (url.searchParams.get("fields") === "permalink_url") return json({ permalink_url: `/reel/${videoMatch[1]}`, id: videoMatch[1] });
      if (reel.publishing.status === "in_progress") {
        reel.pollsUntilPublished -= 1;
        if (reel.pollsUntilPublished <= 0) {
          reel.processing = { status: "complete" };
          reel.publishing = { status: "complete" };
        }
      }
      return json({
        id: videoMatch[1],
        status: {
          video_status: reel.publishing.status === "complete" ? "ready" : "processing",
          uploading_phase: reel.uploading,
          processing_phase: reel.processing,
          publishing_phase: reel.publishing,
        },
      });
    }
    return new Response("not found", { status: 404 });
  }
}
