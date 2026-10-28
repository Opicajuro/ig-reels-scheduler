import { rm } from "node:fs/promises";
import path from "node:path";
import type { PrismaClient } from "@/generated/prisma/client";
import manifest from "./ai-engine.json";
import { UserError } from "./user-error";

// The AI video engine: ComfyUI's Windows portable build for NVIDIA and the Wan 2.2 TI2V 5B model files, all pinned
// in ai-engine.json with their sizes and sha256 (from the GitHub release and the Hugging Face file listings, at fixed
// commits). It lives in <data>\ai, next to the database and storage, not in the tools the installer ships.
export const AI_ENGINE = manifest;

const ENGINE_ID = 1;

export type AiEngineQueue = { send(): Promise<string> };

// The data folder of the install (setup writes it to .env as LOCALIRS_DATA_DIR). There is no default: a dev copy sets
// it in its own .env.
export function aiDir(): string {
  const data = process.env.LOCALIRS_DATA_DIR;
  if (!data) {
    throw new Error("LOCALIRS_DATA_DIR is not set. The installer writes it to .env; for development, add it to .env.");
  }
  return path.join(data, "ai");
}

export function comfyRoot(dir: string): string {
  return path.join(dir, AI_ENGINE.comfyui.folder);
}

export function modelPath(dir: string, model: { folder: string; file: string }): string {
  return path.join(comfyRoot(dir), "ComfyUI", "models", model.folder, model.file);
}

// Everything that is downloaded, and the free space an install needs: the downloads, the unpacked ComfyUI (its
// archive is deleted only after unpacking), and a tenth more.
export function downloadBytes(engine: typeof AI_ENGINE): number {
  return engine.comfyui.size + engine.models.reduce((sum, model) => sum + model.size, 0);
}

export function requiredFreeBytes(engine: typeof AI_ENGINE): number {
  return Math.ceil((downloadBytes(engine) + engine.comfyui.unpackedSize) * 1.1);
}

export function formatGigabytes(bytes: number | bigint): string {
  return `${(Number(bytes) / 1e9).toFixed(1)} GB`;
}

export async function getAiEngine(db: PrismaClient) {
  return (
    (await db.aiEngine.findUnique({ where: { id: ENGINE_ID } })) ?? {
      id: ENGINE_ID,
      status: "not_installed" as const,
      step: null,
      percent: null,
      error: null,
      installedBytes: null,
      updatedAt: new Date(0),
    }
  );
}

export async function setAiEngine(
  db: PrismaClient,
  data: { status?: "not_installed" | "installing" | "installed" | "failed"; step?: string | null; percent?: number | null; error?: string | null; installedBytes?: bigint | null },
) {
  return db.aiEngine.upsert({ where: { id: ENGINE_ID }, create: { id: ENGINE_ID, ...data }, update: data });
}

// Queues the install. A failed install can be started again; its finished downloads are kept.
export async function startAiEngineInstall({ db, queue }: { db: PrismaClient; queue: AiEngineQueue }) {
  const engine = await getAiEngine(db);
  if (engine.status === "installing") throw new UserError("the AI video engine is already being installed");
  if (engine.status === "installed") throw new UserError("the AI video engine is already installed");
  await setAiEngine(db, { status: "installing", step: "Waiting for the worker to start", percent: 0, error: null });
  try {
    await queue.send();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await setAiEngine(db, { status: "failed", step: null, percent: null, error: message });
    throw err;
  }
}

// Deletes <data>\ai with everything in it. Not while installing or while a video is being made, which use it.
export async function uninstallAiEngine({ db, dir }: { db: PrismaClient; dir: string }) {
  const engine = await getAiEngine(db);
  if (engine.status === "installing") throw new UserError("wait for the install to finish first");
  const busy = await db.aiVideoJob.count({ where: { status: { in: ["queued", "running"] } } });
  if (busy > 0) throw new UserError("wait for the AI videos being made to finish first");
  await rm(dir, { recursive: true, force: true });
  await setAiEngine(db, { status: "not_installed", step: null, percent: null, error: null, installedBytes: null });
}
