import type { PrismaClient } from "@/generated/prisma/client";
import type { ClipJobs, RecaptionJobs } from "./queues";

// title is the title kept from the clip this one replaces, for a hook that shows the clip's title.
export type PlannedClip = { clipId: string; start: number; length: number; title?: string };

// The highlights a render picked, stored on the project (renderPlan) before its first clip is made.
export type RenderPlan = { renderId: string; clips: PlannedClip[] };

function isPlannedClip(value: unknown): value is PlannedClip {
  if (!value || typeof value !== "object") return false;
  const clip = value as Record<string, unknown>;
  return (
    typeof clip.clipId === "string" &&
    typeof clip.start === "number" &&
    typeof clip.length === "number" &&
    (clip.title === undefined || typeof clip.title === "string")
  );
}

export function parseRenderPlan(value: unknown): RenderPlan {
  if (!value || typeof value !== "object") throw new Error("the stored render plan is not an object");
  const plan = value as Record<string, unknown>;
  if (typeof plan.renderId !== "string") throw new Error("the stored render plan has no render id");
  if (!Array.isArray(plan.clips) || !plan.clips.every(isPlannedClip)) {
    throw new Error("the stored render plan has malformed clips");
  }
  return { renderId: plan.renderId, clips: plan.clips };
}

// The plan the render goes on with, or null when it starts over: a plan stored by an earlier "Make clips" is not this
// render's.
export function resumablePlan(renderId: string, renderPlan: unknown): RenderPlan | null {
  if (renderPlan === null) return null;
  const plan = parseRenderPlan(renderPlan);
  return plan.renderId === renderId ? plan : null;
}

export function requireRenderId(project: { id: string; renderId: string | null }): string {
  if (!project.renderId) throw new Error(`rendering project ${project.id} has no render id`);
  return project.renderId;
}

// The planned clips still to make, with their place in the plan, after the clips the render already saved. Any other
// clip on the project means the plan and the clips disagree.
export function remainingClips(plan: RenderPlan, savedClipIds: string[]): { index: number; clip: PlannedClip }[] {
  const planned = new Set(plan.clips.map((clip) => clip.clipId));
  const stray = savedClipIds.find((id) => !planned.has(id));
  if (stray) throw new Error(`clip ${stray} is not part of the render being resumed`);
  const saved = new Set(savedClipIds);
  return plan.clips.flatMap((clip, index) => (saved.has(clip.clipId) ? [] : [{ index, clip }]));
}

export function resumeStep(clipNumber: number, total: number): string {
  return `Resuming… clip ${clipNumber} of ${total}`;
}

// Run once when the worker starts, before it takes clip jobs. A project still "rendering" or "picking" then was cut off
// by closing Localirs (a PC that only slept carries on with its job when it wakes). Its job is marked running by the
// worker that was closed, and would only fail when it expires hours later, so it is cancelled and the render is queued
// again. A job of this render that is still waiting is left to run. Finding highlights starts again from its download.
export async function requeueInterruptedRenders({ db, jobs }: { db: PrismaClient; jobs: ClipJobs }): Promise<string[]> {
  const projects = await db.clipProject.findMany({
    where: { status: { in: ["picking", "rendering"] } },
    select: { id: true, status: true, renderId: true, renderPlan: true, _count: { select: { clips: true } } },
  });
  const requeued: string[] = [];
  for (const project of projects) {
    const renderId = requireRenderId(project);
    const plan = project.status === "rendering" ? resumablePlan(renderId, project.renderPlan) : null;
    const open = await jobs.open(project.id);
    if (open.some((job) => job.state !== "active" && job.renderId === renderId)) continue;
    if (open.length > 0) await jobs.cancel(open.map((job) => job.id));
    const renderStep = plan ? resumeStep(Math.min(project._count.clips + 1, plan.clips.length), plan.clips.length) : "Resuming…";
    await db.clipProject.update({ where: { id: project.id }, data: { renderStep } });
    await jobs.send(project.id, renderId);
    requeued.push(project.id);
  }
  return requeued;
}

// Run once when the worker starts, before it takes caption jobs: a clip whose captions were being drawn again when
// Localirs was closed has its job cancelled and queued again with the same edit.
export async function requeueInterruptedRecaptions({ db, jobs }: { db: PrismaClient; jobs: RecaptionJobs }): Promise<string[]> {
  const clips = await db.clip.findMany({ where: { recaptionId: { not: null } }, select: { id: true, recaptionId: true } });
  const requeued: string[] = [];
  for (const clip of clips) {
    if (!clip.recaptionId) throw new Error(`clip ${clip.id} has no recaption id`);
    const open = await jobs.open(clip.id);
    if (open.length > 0) await jobs.cancel(open);
    await db.clip.updateMany({ where: { id: clip.id, recaptionId: clip.recaptionId }, data: { recaptionStep: null } });
    await jobs.send(clip.id, clip.recaptionId);
    requeued.push(clip.id);
  }
  return requeued;
}
