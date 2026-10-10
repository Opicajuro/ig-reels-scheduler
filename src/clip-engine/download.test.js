import { test } from "vitest";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { downloadVideo } from "./download.js";

const workDir = mkdtempSync(path.join(os.tmpdir(), "local-clips-download-"));
const fixture = path.join(workDir, "fixture.mp4");
execFileSync("ffmpeg", [
  "-v", "error", "-y",
  "-f", "lavfi", "-i", "testsrc=duration=5:size=320x240:rate=30",
  "-c:v", "libx264", "-pix_fmt", "yuv420p",
  fixture,
]);

test("downloadVideo saves a link as source.mp4 and returns its title", async () => {
  const bytes = readFileSync(fixture);
  const server = http.createServer((req, res) => {
    if (req.url !== "/clip.mp4") {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": bytes.length });
    res.end(bytes);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const dir = mkdtempSync(path.join(workDir, "project-"));

  try {
    const title = await downloadVideo(`http://127.0.0.1:${port}/clip.mp4`, dir);
    assert.equal(typeof title, "string");
    assert.ok(title.length > 0);
    assert.ok(statSync(path.join(dir, "source.mp4")).size > 0);
  } finally {
    server.close();
  }
});

test("downloadVideo rejects when the link cannot be fetched", async () => {
  const dir = mkdtempSync(path.join(workDir, "project-"));
  await assert.rejects(downloadVideo("http://127.0.0.1:1/missing.mp4", dir), /yt-dlp/);
});
