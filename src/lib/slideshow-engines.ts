import { spawn } from "node:child_process";
import { mkdir, readdir, rm, stat, statfs, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PrismaClient } from "@/generated/prisma/client";
import type { AiEngineStatus } from "@/generated/prisma/enums";
import { downloadVerified, type DownloadProgress } from "./ai-download";
import { formatGigabytes } from "./ai-engine";
import manifest from "./slideshow-engines.json";
import { UserError } from "./user-error";

// The slideshows' two offline engines: the script writer (llama.cpp's llama-server, Windows Vulkan build, with the
// Qwen3.5 4B model) and the picture maker (stable-diffusion.cpp's sd-cli, Windows Vulkan build, with Z-Image Turbo, its
// Qwen3 4B text encoder and its VAE). Vulkan runs on AMD, Intel and NVIDIA graphics alike. Every download is pinned in
// slideshow-engines.json by URL, size and sha256 (from the GitHub release pages and the Hugging Face file listings, at
// fixed commits). They live in <data>\slideshow\<engine>, not in the tools the installer ships.
export const SLIDESHOW_ENGINES = manifest;

export type SlideshowEngineId = keyof typeof SLIDESHOW_ENGINES;
export type EngineFile = {
  name: string;
  url: string;
  sha256: string | null;
  size: number;
  file: string;
  unpackTo: string | null;
};
export type EngineManifest = { name: string; files: EngineFile[] };
export type SlideshowEngineQueue = { send(engine: SlideshowEngineId): Promise<string> };

export const SLIDESHOW_ENGINE_IDS = Object.keys(SLIDESHOW_ENGINES) as SlideshowEngineId[];
const PROGRESS_EVERY_MS = 3000;

export function isSlideshowEngineId(value: string): value is SlideshowEngineId {
  return Object.hasOwn(SLIDESHOW_ENGINES, value);
}

// <data>\slideshow (setup writes the data folder to .env as LOCALIRS_DATA_DIR). There is no default.
export function slideshowDir(): string {
  const data = process.env.LOCALIRS_DATA_DIR;
  if (!data) {
    throw new Error("LOCALIRS_DATA_DIR is not set. The installer writes it to .env; for development, add it to .env.");
  }
  return path.join(data, "slideshow");
}

export function engineDir(root: string, engine: SlideshowEngineId): string {
  return path.join(root, engine);
}

// The programs and model files the worker runs, by where the install puts them.
export function scriptWriterPaths(root: string) {
  const dir = engineDir(root, "script");
  const [, model] = SLIDESHOW_ENGINES.script.files;
  return { server: path.join(dir, "llama", exe("llama-server")), model: path.join(dir, model.file) };
}

export function pictureMakerPaths(root: string) {
  const dir = engineDir(root, "picture");
  const [, diffusion, llm, vae] = SLIDESHOW_ENGINES.picture.files;
  return {
    cli: path.join(dir, "sd", exe("sd-cli")),
    diffusion: path.join(dir, diffusion.file),
    llm: path.join(dir, llm.file),
    vae: path.join(dir, vae.file),
  };
}

function exe(name: string): string {
  return process.platform === "win32" ? `${name}.exe` : name;
}

export function engineDownloadBytes(engine: EngineManifest): number {
  return engine.files.reduce((sum, file) => sum + file.size, 0);
}

// The downloads, the unpacked programs (each zip is deleted only after unpacking, and unpacks to under three times its
// size), and a tenth more.
export function engineFreeBytes(engine: EngineManifest): number {
  const unpacked = engine.files.reduce((sum, file) => sum + (file.unpackTo ? file.size * 3 : 0), 0);
  return Math.ceil((engineDownloadBytes(engine) + unpacked) * 1.1);
}

export type SlideshowEngineState = {
  id: string;
  status: AiEngineStatus;
  step: string | null;
  percent: number | null;
  error: string | null;
  installedBytes: bigint | null;
};

export async function getSlideshowEngine(db: PrismaClient, id: SlideshowEngineId): Promise<SlideshowEngineState> {
  return (
    (await db.slideshowEngine.findUnique({ where: { id } })) ?? {
      id,
      status: "not_installed",
      step: null,
      percent: null,
      error: null,
      installedBytes: null,
    }
  );
}

export async function setSlideshowEngine(
  db: PrismaClient,
  id: SlideshowEngineId,
  data: { status?: AiEngineStatus; step?: string | null; percent?: number | null; error?: string | null; installedBytes?: bigint | null },
) {
  return db.slideshowEngine.upsert({ where: { id }, create: { id, ...data }, update: data });
}

// Queues the install. A failed install can be started again; its finished downloads are kept.
export async function startSlideshowEngineInstall({
  db,
  queue,
  engine,
}: {
  db: PrismaClient;
  queue: SlideshowEngineQueue;
  engine: SlideshowEngineId;
}) {
  const name = SLIDESHOW_ENGINES[engine].name;
  const state = await getSlideshowEngine(db, engine);
  if (state.status === "installing") throw new UserError(`the ${name.toLowerCase()} is already being installed`);
  if (state.status === "installed") throw new UserError(`the ${name.toLowerCase()} is already installed`);
  await setSlideshowEngine(db, engine, { status: "installing", step: "Waiting for the worker to start", percent: 0, error: null });
  try {
    await queue.send(engine);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await setSlideshowEngine(db, engine, { status: "failed", step: null, percent: null, error: message });
    throw err;
  }
}

// Deletes the engine's folder. Not while it installs or while a slideshow is being written or made.
export async function uninstallSlideshowEngine({ db, root, engine }: { db: PrismaClient; root: string; engine: SlideshowEngineId }) {
  const state = await getSlideshowEngine(db, engine);
  if (state.status === "installing") throw new UserError("wait for the install to finish first");
  const busy = await db.slideshowJob.count({ where: { status: { in: ["writing", "queued", "running"] } } });
  if (busy > 0) throw new UserError("wait for the slideshows being made to finish first");
  await rm(engineDir(root, engine), { recursive: true, force: true });
  await setSlideshowEngine(db, engine, { status: "not_installed", step: null, percent: null, error: null, installedBytes: null });
}

export type Unzip = (archive: string, into: string) => Promise<void>;

// Windows' own tar (bsdtar, in System32 since Windows 10) unpacks .zip files.
export const unzipWithTar: Unzip = (archive, into) =>
  new Promise((resolve, reject) => {
    const tar = process.platform === "win32" ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
    const child = spawn(tar, ["-xf", archive, "-C", into], { windowsHide: true });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar exited with ${code}: ${output.trim().split(/\r?\n/).slice(-3).join(" ")}`));
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

// Downloads, checks and unpacks one engine into root\<engine>, writing the step and percentage to its row every few
// seconds. The row must already say "installing". Each finished download is kept, so a failed install that is started
// again only fetches what is missing. A file without a pinned sha256 is refused, never downloaded unchecked.
export async function installSlideshowEngine({
  db,
  root,
  engine,
  manifest: engineManifest = SLIDESHOW_ENGINES[engine],
  unzip = unzipWithTar,
}: {
  db: PrismaClient;
  root: string;
  engine: SlideshowEngineId;
  manifest?: EngineManifest;
  unzip?: Unzip;
}) {
  let lastWrite = 0;
  const report = async (step: string, percent: number, force = false) => {
    if (!force && Date.now() - lastWrite < PROGRESS_EVERY_MS) return;
    lastWrite = Date.now();
    await setSlideshowEngine(db, engine, { step, percent });
  };
  const dir = engineDir(root, engine);
  const total = engineDownloadBytes(engineManifest);
  let done = 0;

  try {
    for (const item of engineManifest.files) {
      if (!item.sha256) throw new Error(`${item.name} is not pinned yet: slideshow-engines.json has no sha256 for ${item.url}`);
    }
    await mkdir(dir, { recursive: true });
    const { bavail, bsize } = await statfs(dir);
    const free = bavail * bsize;
    const needed = engineFreeBytes(engineManifest);
    if (free < needed) {
      throw new Error(`not enough free disk space: the ${engineManifest.name.toLowerCase()} needs ${formatGigabytes(needed)}, the drive has ${formatGigabytes(free)}`);
    }

    for (const item of engineManifest.files) {
      // The marker is written only after a complete unpack, so a half-unpacked program is unpacked again.
      const unpacked = item.unpackTo ? path.join(dir, `${item.file}.unpacked`) : null;
      if (unpacked && (await exists(unpacked))) {
        done += item.size;
        continue;
      }
      const file = path.join(dir, item.file);
      await report(`Downloading ${item.name}`, Math.floor((done / total) * 100), true);
      // Progress callbacks come from the download stream, which does not wait for them; the last write is awaited.
      let pending: Promise<void> = Promise.resolve();
      try {
        await downloadVerified({
          url: item.url,
          file,
          size: item.size,
          sha256: item.sha256!,
          onProgress: ({ phase, bytes }: DownloadProgress) => {
            const step =
              phase === "downloading"
                ? `Downloading ${item.name}: ${formatGigabytes(bytes)} of ${formatGigabytes(item.size)}`
                : `Checking ${item.name}: ${Math.floor((bytes / item.size) * 100)}%`;
            const percent = Math.floor(((done + (phase === "downloading" ? bytes : item.size)) / total) * 100);
            pending = pending.then(() => report(step, percent));
          },
        });
      } finally {
        await pending;
      }
      done += item.size;
      if (unpacked) {
        await report(`Unpacking ${item.name}`, Math.floor((done / total) * 100), true);
        const into = path.join(dir, item.unpackTo!);
        await rm(into, { recursive: true, force: true });
        await mkdir(into, { recursive: true });
        await unzip(file, into);
        await rm(file);
        await writeFile(unpacked, "");
      }
    }

    await report("Measuring the installed files", 100, true);
    await setSlideshowEngine(db, engine, { status: "installed", step: null, percent: null, error: null, installedBytes: BigInt(await folderBytes(dir)) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await setSlideshowEngine(db, engine, { status: "failed", step: null, percent: null, error: message });
    throw err;
  }
}
