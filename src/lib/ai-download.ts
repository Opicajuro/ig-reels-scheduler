import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { rename, rm, stat } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream } from "node:stream/web";

export type DownloadProgress = { phase: "downloading" | "checking"; bytes: number };

async function sizeOf(file: string): Promise<number | null> {
  return stat(file).then(
    (info) => info.size,
    () => null,
  );
}

// Counts the bytes going through, for the progress line.
function counter(start: number, report: (bytes: number) => void): Transform {
  let bytes = start;
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      bytes += chunk.length;
      report(bytes);
      done(null, chunk);
    },
  });
}

// Downloads url to file and checks its size and sha256. The bytes go to file + ".part" first, so a download that
// stops (the PC sleeps, the worker restarts) carries on from where it was the next time; only a checked file gets
// its real name, so a file that exists is complete. A damaged download is deleted and the error says so.
export async function downloadVerified({
  url,
  file,
  size,
  sha256,
  onProgress,
}: {
  url: string;
  file: string;
  size: number;
  sha256: string;
  onProgress: (progress: DownloadProgress) => void;
}): Promise<void> {
  if ((await sizeOf(file)) !== null) return;
  const part = `${file}.part`;
  let start = (await sizeOf(part)) ?? 0;
  if (start > size) {
    await rm(part);
    start = 0;
  }

  if (start < size) {
    const response = await fetch(url, { headers: start > 0 ? { Range: `bytes=${start}-` } : {} });
    if (!response.ok || !response.body) throw new Error(`downloading ${url} failed with HTTP ${response.status}`);
    // 206 continues the part; a server that sends the whole file (200) starts it again.
    const resume = start > 0 && response.status === 206;
    const from = resume ? start : 0;
    await pipeline(
      Readable.fromWeb(response.body as ReadableStream),
      counter(from, (bytes) => onProgress({ phase: "downloading", bytes })),
      createWriteStream(part, { flags: resume ? "a" : "w" }),
    );
  }

  const got = (await sizeOf(part)) ?? 0;
  if (got !== size) throw new Error(`the download of ${url} stopped at ${got} of ${size} bytes; installing again resumes it`);

  const hash = createHash("sha256");
  let checked = 0;
  for await (const chunk of createReadStream(part)) {
    hash.update(chunk as Buffer);
    checked += (chunk as Buffer).length;
    onProgress({ phase: "checking", bytes: checked });
  }
  const digest = hash.digest("hex");
  if (digest !== sha256) {
    await rm(part);
    throw new Error(`the download of ${url} is damaged (sha256 ${digest}, expected ${sha256}); it was deleted`);
  }
  await rename(part, file);
}
