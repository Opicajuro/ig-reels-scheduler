// A fake of TikTok's open API and upload host for the TikTok tests: OAuth tokens, user info, the inbox upload's init,
// the chunk PUTs (checked against the Media Transfer Guide's rules) and the status, as fetch.

export type TikTokCall = { method: string; url: URL; headers: Headers; body: string };

type Upload = { size: number; chunkSize: number; totalChunks: number; received: number; chunks: number };

export function tikTokError(status: number, code: string, message = code) {
  return new Response(JSON.stringify({ data: {}, error: { code, message, log_id: "log-1" } }), { status });
}

const MB = 1_000_000;

export class FakeTikTok {
  calls: TikTokCall[] = [];
  uploads = new Map<string, Upload>();
  // Status reads left, after the last chunk, before the draft is in the inbox.
  pollsUntilInbox = 1;
  polls = 0;
  nextPublish = 1;
  refreshes = 0;
  // An answer given instead of the usual one, for the first call whose "METHOD host/path" starts with the key.
  failures = new Map<string, Response | Error>();

  fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const body = init?.body instanceof Blob ? `<${init.body.size} bytes>` : String(init?.body ?? "");
    this.calls.push({ method, url, headers, body });
    const route = `${method} ${url.host}${url.pathname}`;
    for (const [key, answer] of this.failures) {
      if (route.startsWith(key)) {
        this.failures.delete(key);
        if (answer instanceof Error) throw answer;
        return answer;
      }
    }
    return this.answer(method, url, headers, body, init?.body instanceof Blob ? init.body.size : 0);
  }) as typeof fetch;

  private answer(method: string, url: URL, headers: Headers, body: string, bytes: number): Response {
    const ok = (data: unknown) => new Response(JSON.stringify({ data, error: { code: "ok", message: "", log_id: "log-1" } }));
    if (url.pathname === "/v2/oauth/token/") {
      const params = new URLSearchParams(body);
      if (params.get("grant_type") === "refresh_token") this.refreshes += 1;
      return new Response(
        JSON.stringify({
          access_token: `act.${this.refreshes}`,
          expires_in: 86400,
          open_id: "open-1",
          refresh_expires_in: 31536000,
          refresh_token: `rft.${this.refreshes}`,
          scope: "user.info.basic,video.upload",
          token_type: "Bearer",
        }),
      );
    }
    if (url.pathname === "/v2/user/info/") return ok({ user: { open_id: "open-1", display_name: "Baker Bea" } });
    if (url.pathname === "/v2/post/publish/inbox/video/init/") {
      const { source_info: info } = JSON.parse(body) as {
        source_info: { source: string; video_size: number; chunk_size: number; total_chunk_count: number };
      };
      if (info.source !== "FILE_UPLOAD") return tikTokError(400, "invalid_params");
      const publishId = `v_inbox_file~v2.${this.nextPublish++}`;
      this.uploads.set(publishId, { size: info.video_size, chunkSize: info.chunk_size, totalChunks: info.total_chunk_count, received: 0, chunks: 0 });
      return ok({ publish_id: publishId, upload_url: `https://open-upload.tiktokapis.com/video/?upload_id=${publishId}&upload_token=tok` });
    }
    if (url.host === "open-upload.tiktokapis.com" && method === "PUT") {
      const upload = this.uploads.get(url.searchParams.get("upload_id") ?? "");
      if (!upload) return new Response(null, { status: 404 });
      const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(headers.get("Content-Range") ?? "");
      if (!match || Number(match[3]) !== upload.size || Number(headers.get("Content-Length")) !== bytes) return new Response(null, { status: 400 });
      const [start, end] = [Number(match[1]), Number(match[2])];
      if (start !== upload.received) return new Response(null, { status: 416 });
      const length = end - start + 1;
      const last = upload.chunks === upload.totalChunks - 1;
      // Each chunk is the declared chunk_size, except the last, which takes the rest; at least 5 MB unless it is the
      // whole video; at most 64 MB, or 128 MB for the last.
      const sizeOk = last ? end === upload.size - 1 && length <= 128 * MB : length === upload.chunkSize && length <= 64 * MB;
      if (!sizeOk || (upload.totalChunks > 1 && upload.chunkSize < 5 * MB)) return new Response(null, { status: 400 });
      upload.received = end + 1;
      upload.chunks += 1;
      return new Response(null, { status: last ? 201 : 206 });
    }
    if (url.pathname === "/v2/post/publish/status/fetch/") {
      const { publish_id: publishId } = JSON.parse(body) as { publish_id: string };
      const upload = this.uploads.get(publishId);
      if (!upload) return tikTokError(400, "invalid_publish_id");
      if (upload.received < upload.size) return ok({ status: "PROCESSING_UPLOAD", uploaded_bytes: upload.received });
      this.polls += 1;
      return ok({ status: this.polls >= this.pollsUntilInbox ? "SEND_TO_USER_INBOX" : "PROCESSING_UPLOAD", uploaded_bytes: upload.size });
    }
    return new Response("not found", { status: 404 });
  }
}
