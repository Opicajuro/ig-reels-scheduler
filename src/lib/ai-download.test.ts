import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { downloadVerified, type DownloadProgress } from "./ai-download";

const body = randomBytes(300_000);
const sha256 = createHash("sha256").update(body).digest("hex");

let server: Server;
let base: string;
let dir: string;
let requests: { path: string; range: string | undefined }[];
let ranges = true;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "ai-download-test-"));
  // Serves body at /file, with Range support like GitHub and Hugging Face, and a different file at /damaged.
  server = createServer((request, response) => {
    requests.push({ path: request.url!, range: request.headers.range });
    const content = request.url === "/damaged" ? Buffer.from(body).fill(1, 0, 10) : body;
    const match = /^bytes=(\d+)-$/.exec(request.headers.range ?? "");
    if (match && ranges) {
      const from = Number(match[1]);
      response.writeHead(206, { "Content-Range": `bytes ${from}-${content.length - 1}/${content.length}` });
      response.end(content.subarray(from));
      return;
    }
    response.writeHead(200, { "Content-Length": content.length });
    response.end(content);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
  requests = [];
  ranges = true;
});

async function sizeOf(file: string) {
  return stat(file).then(
    (info) => info.size,
    () => null,
  );
}

describe("downloadVerified", () => {
  it("downloads, checks the sha256 and only then gives the file its name", async () => {
    const file = path.join(dir, "fresh.bin");
    const progress: DownloadProgress[] = [];
    await downloadVerified({ url: `${base}/file`, file, size: body.length, sha256, onProgress: (p) => progress.push(p) });
    expect((await readFile(file)).equals(body)).toBe(true);
    expect(await sizeOf(`${file}.part`)).toBeNull();
    expect(progress.filter((p) => p.phase === "downloading").at(-1)).toEqual({ phase: "downloading", bytes: body.length });
    expect(progress.at(-1)).toEqual({ phase: "checking", bytes: body.length });
    expect(requests).toEqual([{ path: "/file", range: undefined }]);
  });

  it("carries on from a part file left by an interrupted download", async () => {
    const file = path.join(dir, "resumed.bin");
    await writeFile(`${file}.part`, body.subarray(0, 100_000));
    await downloadVerified({ url: `${base}/file`, file, size: body.length, sha256, onProgress: () => {} });
    expect((await readFile(file)).equals(body)).toBe(true);
    expect(requests).toEqual([{ path: "/file", range: "bytes=100000-" }]);
  });

  it("starts again when the server sends the whole file instead of the rest", async () => {
    ranges = false;
    const file = path.join(dir, "restarted.bin");
    await writeFile(`${file}.part`, body.subarray(0, 100_000));
    await downloadVerified({ url: `${base}/file`, file, size: body.length, sha256, onProgress: () => {} });
    expect((await readFile(file)).equals(body)).toBe(true);
  });

  it("does nothing for a file that is already there", async () => {
    const file = path.join(dir, "done.bin");
    await writeFile(file, "checked before");
    await downloadVerified({ url: `${base}/file`, file, size: body.length, sha256, onProgress: () => {} });
    expect(requests).toEqual([]);
  });

  it("deletes a damaged download and says so", async () => {
    const file = path.join(dir, "damaged.bin");
    await expect(
      downloadVerified({ url: `${base}/damaged`, file, size: body.length, sha256, onProgress: () => {} }),
    ).rejects.toThrow(`is damaged (sha256`);
    expect(await sizeOf(file)).toBeNull();
    expect(await sizeOf(`${file}.part`)).toBeNull();
  });

  it("keeps a download that is shorter than expected, to resume it", async () => {
    const file = path.join(dir, "short.bin");
    await expect(
      downloadVerified({ url: `${base}/file`, file, size: body.length + 10, sha256, onProgress: () => {} }),
    ).rejects.toThrow(`stopped at ${body.length} of ${body.length + 10} bytes`);
    expect(await sizeOf(`${file}.part`)).toBe(body.length);
    expect(await sizeOf(file)).toBeNull();
  });

  it("fails on an HTTP error", async () => {
    const missing = createServer((_request, response) => {
      response.writeHead(404);
      response.end();
    });
    await new Promise<void>((resolve) => missing.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(missing.address() as AddressInfo).port}/gone`;
    await expect(
      downloadVerified({ url, file: path.join(dir, "gone.bin"), size: 1, sha256, onProgress: () => {} }),
    ).rejects.toThrow("failed with HTTP 404");
    await new Promise((resolve) => missing.close(resolve));
  });
});
