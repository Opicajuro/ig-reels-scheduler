import { spawn } from "node:child_process";
import { mkdir, readdir, rm, stat, statfs, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PrismaClient } from "@/generated/prisma/client";
import { downloadVerified, type DownloadProgress } from "./ai-download";
import { AI_ENGINE, comfyRoot, downloadBytes, formatGigabytes, modelPath, requiredFreeBytes, setAiEngine } from "./ai-engine";

// Windows' path limit: ComfyUI's deepest file must fit under it, or Python cannot load it.
const MAX_PATH = 259;
const PROGRESS_EVERY_MS = 3000;

export type Extract = (archive: string, into: string) => Promise<void>;

// Unpacks a .7z with 7zr.exe, the stand-alone 7-Zip the installer puts in the tools folder (on the worker's PATH):
// Windows itself cannot open .7z files.
export const extract7z: Extract = (archive, into) =>
  new Promise((resolve, reject) => {
    const child = spawn("7zr", ["x", archive, `-o${into}`, "-y", "-bd"], { windowsHide: true });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`7zr exited with ${code}: ${output.trim().split(/\r?\n/).slice(-3).join(" ")}`));
    });
  });

async function folderBytes(folder: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const entryPath = path.join(folder, entry.name);
    total += entry.isDirectory() ? await folderBytes(entryPath) : (await stat(entryPath)).size;
  }
  return total;
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  );
}

// Downloads and unpacks the engine into dir, writing the step and percentage to the engine row every few seconds.
// The engine row must already say "installing". Each finished download is kept, so a failed install that is started
// again only fetches what is missing.
export async function installAiEngine({
  db,
  dir,
  engine = AI_ENGINE,
  extract = extract7z,
}: {
  db: PrismaClient;
  dir: string;
  engine?: typeof AI_ENGINE;
  extract?: Extract;
}) {
  let lastWrite = 0;
  const report = async (step: string, percent: number, force = false) => {
    if (!force && Date.now() - lastWrite < PROGRESS_EVERY_MS) return;
    lastWrite = Date.now();
    await setAiEngine(db, { step, percent });
  };
  const total = downloadBytes(engine);
  let done = 0;
  // Progress callbacks come from the download stream, which does not wait for them; the last write is awaited.
  let pending: Promise<void> = Promise.resolve();
  const fetchFile = async (name: string, item: { url: string; size: number; sha256: string }, file: string) => {
    await report(`Downloading ${name}`, Math.floor((done / total) * 100), true);
    try {
      await downloadVerified({
        url: item.url,
        file,
        size: item.size,
        sha256: item.sha256,
        onProgress: ({ phase, bytes }: DownloadProgress) => {
          const step =
            phase === "downloading"
              ? `Downloading ${name}: ${formatGigabytes(bytes)} of ${formatGigabytes(item.size)}`
              : `Checking ${name}: ${Math.floor((bytes / item.size) * 100)}%`;
          const percent = Math.floor(((done + (phase === "downloading" ? bytes : item.size)) / total) * 100);
          pending = pending.then(() => report(step, percent));
        },
      });
    } finally {
      await pending;
    }
    done += item.size;
  };

  try {
    await mkdir(dir, { recursive: true });
    const deepest = dir.length + 1 + engine.comfyui.longestPath;
    if (deepest > MAX_PATH) {
      throw new Error(
        `the data folder's path is too long for the AI engine (${deepest} of at most ${MAX_PATH} characters). Install Localirs in a shorter folder, such as C:\\Localirs.`,
      );
    }
    const { bavail, bsize } = await statfs(dir);
    const free = bavail * bsize;
    const needed = requiredFreeBytes(engine);
    if (free < needed) {
      throw new Error(`not enough free disk space: the AI engine needs ${formatGigabytes(needed)}, the drive has ${formatGigabytes(free)}`);
    }

    // The marker is written only after a complete unpack, so a half-unpacked ComfyUI is unpacked again.
    const unpacked = path.join(dir, `comfyui-${engine.comfyui.version}.unpacked`);
    if (await exists(unpacked)) {
      done += engine.comfyui.size;
    } else {
      const archive = path.join(dir, path.basename(new URL(engine.comfyui.url).pathname));
      await fetchFile("ComfyUI", engine.comfyui, archive);
      await report("Unpacking ComfyUI (this takes a few minutes)", Math.floor((done / total) * 100), true);
      await rm(comfyRoot(dir), { recursive: true, force: true });
      await extract(archive, dir);
      await rm(archive);
      await writeFile(unpacked, "");
    }

    for (const model of engine.models) {
      const file = modelPath(dir, model);
      await mkdir(path.dirname(file), { recursive: true });
      await fetchFile(model.name, model, file);
    }

    await report("Measuring the installed files", 100, true);
    await setAiEngine(db, { status: "installed", step: null, percent: null, error: null, installedBytes: BigInt(await folderBytes(dir)) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await setAiEngine(db, { status: "failed", step: null, percent: null, error: message });
    throw err;
  }
}
