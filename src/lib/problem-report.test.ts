import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LOG_TAIL_BYTES, readLogTail, reportName, writeProblemReport, type ReportFacts } from "./problem-report";

// Reads a ZIP's entries from its central directory.
function readZip(bytes: Buffer): Map<string, Buffer> {
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = bytes.readUInt16LE(end + 10);
  let offset = bytes.readUInt32LE(end + 16);
  const entries = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    const method = bytes.readUInt16LE(offset + 10);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const localOffset = bytes.readUInt32LE(offset + 42);
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    const dataStart = localOffset + 30 + bytes.readUInt16LE(localOffset + 26) + bytes.readUInt16LE(localOffset + 28);
    const data = bytes.subarray(dataStart, dataStart + compressedSize);
    entries.set(name, method === 8 ? inflateRawSync(data) : Buffer.from(data));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

const facts: ReportFacts = {
  appVersion: "0.1.0",
  appBuild: "57",
  os: "Windows_NT 10.0.26100 (x64)",
  node: "v22.0.0",
  encoder: "NVIDIA GPU (NVENC)",
  failedPosts: 2,
  failedClipRenders: 1,
  failedAiVideos: 0,
};

describe("reportName", () => {
  it("names the ZIP by local time", () => {
    expect(reportName(new Date(2026, 9, 30, 2, 5, 9))).toBe("localirs-report-2026-10-30_020509.zip");
  });
});

describe("writeProblemReport", () => {
  let dataDir: string;
  const bigLog = Buffer.concat([Buffer.alloc(200_000, "a"), Buffer.alloc(LOG_TAIL_BYTES, "b")]);

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), "problem-report-test-"));
    await writeFile(path.join(dataDir, "web.log"), "web started\n");
    await writeFile(path.join(dataDir, "worker.err.log"), bigLog);
    await writeFile(path.join(dataDir, "restore.log"), "not a report log\n");
    await writeFile(path.join(dataDir, ".env"), "TOKEN_ENC_KEY=secret\n");
    await writeFile(path.join(dataDir, "secrets.json"), '{"password":"secret"}');
  });

  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("zips the logs that exist, the version and the summary, and nothing secret", async () => {
    const zipPath = await writeProblemReport({ dataDir, facts, now: new Date(2026, 9, 30, 2, 5, 9) });
    expect(zipPath).toBe(path.join(dataDir, "reports", "localirs-report-2026-10-30_020509.zip"));

    const entries = readZip(await readFile(zipPath));
    expect([...entries.keys()].sort()).toEqual(["summary.txt", "version.txt", "web.log", "worker.err.log"]);
    expect(entries.has(".env")).toBe(false);
    expect(entries.has("secrets.json")).toBe(false);
    for (const data of entries.values()) expect(data.toString()).not.toContain("secret");

    expect(entries.get("web.log")!.toString()).toBe("web started\n");
    const tail = entries.get("worker.err.log")!;
    expect(tail.length).toBe(LOG_TAIL_BYTES);
    expect(tail.equals(bigLog.subarray(bigLog.length - LOG_TAIL_BYTES))).toBe(true);

    expect(entries.get("version.txt")!.toString()).toBe("Localirs 0.1.0\nInstaller build: 57\n");
    const summary = entries.get("summary.txt")!.toString();
    expect(summary).toContain("OS: Windows_NT 10.0.26100 (x64)");
    expect(summary).toContain("Video encoder: NVIDIA GPU (NVENC)");
    expect(summary).toContain("Failed posts: 2");
    expect(summary).toContain("Failed clip renders: 1");
    expect(summary).toContain("Logs (the last 1 MB of each): worker.err.log, web.log");
  });

  it("refuses a data folder that does not exist", async () => {
    await expect(writeProblemReport({ dataDir: path.join(dataDir, "missing"), facts, now: new Date() })).rejects.toThrow();
  });
});

describe("readLogTail", () => {
  it("returns the whole file when it is small", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "log-tail-test-"));
    await writeFile(path.join(dir, "a.log"), "0123456789");
    expect((await readLogTail(path.join(dir, "a.log"), 4)).toString()).toBe("6789");
    expect((await readLogTail(path.join(dir, "a.log"), 100)).toString()).toBe("0123456789");
    await rm(dir, { recursive: true, force: true });
  });
});
