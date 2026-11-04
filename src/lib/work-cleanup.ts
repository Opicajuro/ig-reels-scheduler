import type { PrismaClient } from "@/generated/prisma/client";
import { deleteClip } from "./clip-projects";
import type { ClipStore } from "./clip-store";
import type { StartupWorkJobs } from "./queues";
import { UserError } from "./user-error";

export const CLOSED_ERROR = "Stopped because Localirs was closed. Make it again.";

const BUSY_VIDEO = ["queued", "running"] as const;
const BUSY_SLIDESHOW = ["writing", "queued", "running"] as const;

// The ids whose work has no pg-boss job waiting to run it. Its job marked running belongs to the closed worker, which
// would only fail it when it expires hours later, so it is cancelled.
async function interrupted(ids: string[], jobs: StartupWorkJobs): Promise<string[]> {
  const cut: string[] = [];
  for (const id of ids) {
    if ((await jobs.waiting(id)).length > 0) continue;
    const open = await jobs.open(id);
    if (open.length > 0) await jobs.cancel(open);
    cut.push(id);
  }
  return cut;
}

// Run once when the worker starts, before it takes AI video jobs. An AI video still waiting or being made then, with no
// job waiting to run it, was cut off by closing Localirs: it is marked failed. Making it again starts from zero anyway.
// Its ComfyUI went with the closed worker's process tree, and the next video starts its own.
export async function failInterruptedAiVideos({ db, jobs }: { db: PrismaClient; jobs: StartupWorkJobs }): Promise<string[]> {
  const videos = await db.aiVideoJob.findMany({ where: { status: { in: [...BUSY_VIDEO] } }, select: { id: true } });
  const failed = await interrupted(
    videos.map((video) => video.id),
    jobs,
  );
  if (failed.length > 0) {
    await db.aiVideoJob.updateMany({
      where: { id: { in: failed }, status: { in: [...BUSY_VIDEO] } },
      data: { status: "failed", step: null, error: CLOSED_ERROR },
    });
  }
  return failed;
}

// The same for slideshows, before the worker takes slideshow jobs. A slideshow whose script was written keeps its draft,
// so it can be made again from it. Its llama-server or sd-cli went with the closed worker.
export async function failInterruptedSlideshows({ db, jobs }: { db: PrismaClient; jobs: StartupWorkJobs }): Promise<string[]> {
  const shows = await db.slideshowJob.findMany({ where: { status: { in: [...BUSY_SLIDESHOW] } }, select: { id: true } });
  const failed = await interrupted(
    shows.map((show) => show.id),
    jobs,
  );
  if (failed.length > 0) {
    await db.slideshowJob.updateMany({
      where: { id: { in: failed }, status: { in: [...BUSY_SLIDESHOW] } },
      data: { status: "failed", step: null, error: CLOSED_ERROR },
    });
  }
  return failed;
}

// Deletes a finished or failed AI video from the Clips page: its start picture, the clip it made and its row. One
// still waiting or being made is cancelled first.
export async function deleteAiVideo({ db, store, ownerId, jobId }: { db: PrismaClient; store: ClipStore; ownerId: string; jobId: string }) {
  const video = await db.aiVideoJob.findFirst({ where: { id: jobId, ownerId }, select: { status: true, clipId: true, startImageKey: true } });
  if (!video) throw new UserError("AI video not found");
  if ((BUSY_VIDEO as readonly string[]).includes(video.status)) throw new UserError("this AI video is being made; cancel it first");

  // Files go first, so a failed delete leaves the row in place to retry from.
  if (video.startImageKey) await store.remove(video.startImageKey);
  if (video.clipId) await deleteClip({ db, store, ownerId, clipId: video.clipId });
  await db.aiVideoJob.delete({ where: { id: jobId } });
}

// Deletes a slideshow that is a draft, finished or failed: its uploaded photos, the clip it made and its row. One being
// written or made is cancelled first.
export async function deleteSlideshow({ db, store, ownerId, jobId }: { db: PrismaClient; store: ClipStore; ownerId: string; jobId: string }) {
  const show = await db.slideshowJob.findFirst({ where: { id: jobId, ownerId }, select: { status: true, clipId: true, slides: true } });
  if (!show) throw new UserError("slideshow not found");
  if ((BUSY_SLIDESHOW as readonly string[]).includes(show.status)) throw new UserError("this slideshow is being written or made; cancel it first");

  for (const key of photoKeys(show.slides)) await store.remove(key);
  if (show.clipId) await deleteClip({ db, store, ownerId, clipId: show.clipId });
  await db.slideshowJob.delete({ where: { id: jobId } });
}

// The storage keys of the photos uploaded for a slideshow's slides.
function photoKeys(slides: unknown): string[] {
  if (slides === null) return [];
  if (!Array.isArray(slides)) throw new Error("the stored slides are not a list");
  return slides.flatMap((slide: { source?: { kind?: unknown; key?: unknown } | null }) => {
    const source = slide.source;
    if (source?.kind !== "photo") return [];
    if (typeof source.key !== "string") throw new Error("a stored slide's photo has no key");
    return [source.key];
  });
}
