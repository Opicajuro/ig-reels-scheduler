import { createWriteStream } from "node:fs";
import { mkdir, open, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import archiver from "archiver";
import type { PrismaClient } from "@/generated/prisma/client";
import { readAppBuild } from "./backup";
import { getVideoEncoding, VIDEO_ENCODER_LABELS } from "./video-encoding";

// A problem report is one ZIP in data\reports with the end of each log, the version and a short summary of this PC,
// to send to whoever helps. Only the files named here go in, so .env, secrets.json and the database never do.
// The names are the ones installer/services.ps1 and the setup, start and stop scripts write.
export const REPORT_LOG_FILES = [
  "setup.log",
  "start.log",
  "stop.log",
  "worker.log",
  "worker.err.log",
  "web.log",
  "web.err.log",
  "storage.err.log",
  "postgres.log",
];
export const LOG_TAIL_BYTES = 1024 * 1024;

export type ReportFacts = {
  appVersion: string;
  appBuild: string | null;
  os: string;
  node: string;
  encoder: string;
  failedPosts: number;
  failedClipRenders: number;
  failedAiVideos: number;
};

export function reportsFolder(dataDir: string): string {
  return path.join(dataDir, "reports");
}

// Local time, so the files read naturally in Explorer; the name sorts in time order.
export function reportName(date: Date): string {
  const two = (n: number) => String(n).padStart(2, "0");
  return (
    `localirs-report-${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}_` +
    `${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}.zip`
  );
}

export async function readLogTail(file: string, maxBytes = LOG_TAIL_BYTES): Promise<Buffer> {
  const handle = await open(file, "r");
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return buffer;
  } finally {
    await handle.close();
  }
}

export function buildVersionText(facts: Pick<ReportFacts, "appVersion" | "appBuild">): string {
  return `Localirs ${facts.appVersion}\nInstaller build: ${facts.appBuild ?? "none (not an installed copy)"}\n`;
}

export function buildSummary(facts: ReportFacts, now: Date, logs: string[]): string {
  return [
    `Report made: ${now.toISOString()}`,
    `OS: ${facts.os}`,
    `Node: ${facts.node}`,
    `Video encoder: ${facts.encoder}`,
    `Failed posts: ${facts.failedPosts}`,
    `Failed clip renders: ${facts.failedClipRenders}`,
    `Failed AI videos: ${facts.failedAiVideos}`,
    `Logs (the last ${LOG_TAIL_BYTES / 1024 / 1024} MB of each): ${logs.length === 0 ? "none found" : logs.join(", ")}`,
    "",
  ].join("\n");
}

export async function gatherReportFacts(db: PrismaClient, dataDir: string, appVersion: string): Promise<ReportFacts> {
  const [encoding, failedPosts, failedClipRenders, failedAiVideos] = await Promise.all([
    getVideoEncoding(db),
    db.post.count({ where: { status: "failed" } }),
    db.clipProject.count({ where: { status: "failed" } }),
    db.aiVideoJob.count({ where: { status: "failed" } }),
  ]);
  return {
    appVersion,
    appBuild: await readAppBuild(dataDir),
    os: `${os.type()} ${os.release()} (${os.arch()})`,
    node: process.version,
    encoder: encoding ? VIDEO_ENCODER_LABELS[encoding.encoder] : "not checked yet (the worker has not started)",
    failedPosts,
    failedClipRenders,
    failedAiVideos,
  };
}

async function existingLogs(dataDir: string): Promise<string[]> {
  const found: string[] = [];
  for (const name of REPORT_LOG_FILES) {
    const info = await stat(path.join(dataDir, name)).catch(() => null);
    if (info?.isFile()) found.push(name);
  }
  return found;
}

// Writes the ZIP to data\reports and returns its path.
export async function writeProblemReport({ dataDir, facts, now }: { dataDir: string; facts: ReportFacts; now: Date }): Promise<string> {
  if (!(await stat(dataDir)).isDirectory()) throw new Error(`${dataDir} is not a folder`);
  const folder = reportsFolder(dataDir);
  await mkdir(folder, { recursive: true });
  const zipPath = path.join(folder, reportName(now));
  const logs = await existingLogs(dataDir);

  const output = createWriteStream(zipPath);
  const archive = archiver("zip", { zlib: { level: 6 } });
  const finished = new Promise<void>((resolve, reject) => {
    output.on("close", () => resolve());
    archive.on("error", reject);
    output.on("error", reject);
  });
  archive.pipe(output);
  for (const name of logs) archive.append(await readLogTail(path.join(dataDir, name)), { name });
  archive.append(buildVersionText(facts), { name: "version.txt" });
  archive.append(buildSummary(facts, now, logs), { name: "summary.txt" });
  await archive.finalize();
  await finished;
  return zipPath;
}
