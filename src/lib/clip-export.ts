import { createWriteStream } from "node:fs";
import path from "node:path";
import archiver from "archiver";
import type { ClipStore } from "./clip-store";

export type PostingItem = {
  name: string;
  storageKey: string;
  title: string | null;
  description: string | null;
  postAt: Date;
};

// The times the clips should go out: the first one, then one every `everyHours`.
export function planPostTimes(firstAt: Date, everyHours: number, count: number): Date[] {
  return Array.from({ length: count }, (_, index) => new Date(firstAt.getTime() + index * everyHours * 60 * 60 * 1000));
}

// Names in the ZIP are plain, so nothing in a clip name can change folders when the ZIP is opened.
export function zipFileName(index: number, name: string): string {
  return `${index + 1}-${name.replace(/[^A-Za-z0-9 _.-]/g, "_")}.mp4`;
}

export function formatPostTime(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(at);
}

// Plain text sheet: for each clip, when to post it, and the title and description to paste.
export function buildPostingSheet(projectName: string, items: PostingItem[], timeZone: string): string {
  const blocks = items.map((item, index) =>
    [
      `${index + 1}. ${zipFileName(index, item.name)}`,
      `Post at: ${formatPostTime(item.postAt, timeZone)}`,
      `Title: ${item.title ?? item.name}`,
      "Description:",
      item.description ?? "",
    ].join("\n"),
  );
  const header = [
    `Posting sheet: ${projectName}`,
    "",
    "Upload each clip in YouTube Studio or Instagram, set the time shown, and paste the title and description.",
  ].join("\n");
  return `${[header, ...blocks].join("\n\n")}\n`;
}

// Downloads each clip from storage and writes them, with the sheet, into one ZIP file in workDir.
export async function writePostingZip({
  store,
  workDir,
  projectName,
  items,
  timeZone,
}: {
  store: ClipStore;
  workDir: string;
  projectName: string;
  items: PostingItem[];
  timeZone: string;
}): Promise<string> {
  const zipPath = path.join(workDir, "posting.zip");
  const output = createWriteStream(zipPath);
  const archive = archiver("zip", { zlib: { level: 6 } });
  const finished = new Promise<void>((resolve, reject) => {
    output.on("close", () => resolve());
    archive.on("error", reject);
    output.on("error", reject);
  });
  archive.pipe(output);

  for (const [index, item] of items.entries()) {
    const local = path.join(workDir, `clip-${index + 1}.mp4`);
    await store.downloadTo(item.storageKey, local);
    archive.file(local, { name: zipFileName(index, item.name) });
  }
  archive.append(buildPostingSheet(projectName, items, timeZone), { name: "posting-sheet.txt" });
  await archive.finalize();
  await finished;
  return zipPath;
}
