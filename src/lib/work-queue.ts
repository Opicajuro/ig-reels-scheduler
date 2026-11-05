import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { AI_VIDEO_CANCELLED } from "./ai-video";
import { requireRenderId, resumablePlan } from "./clip-resume";
import type { ClipJobs, RecaptionJobs, WorkJobs } from "./queues";
import { isSlideshowEngineId, SLIDESHOW_ENGINES } from "./slideshow-engines";
import { UserError } from "./user-error";

// What the Queue page lists: everything running or waiting. Dates are ISO strings, as the page polls this as JSON.

// Posts are listed from an hour before they publish.
export const PUBLISH_SOON_MS = 60 * 60 * 1000;
export const RENDER_CANCELLED = "Cancelled";
export const SLIDESHOW_CANCELLED = "Cancelled";

export type QueueRender = {
  id: string;
  name: string;
  // "picking" while "Find highlights" analyses the video, "rendering" while clips are made.
  status: "picking" | "rendering";
  step: string | null;
  startedAt: string;
  clipsDone: number;
  // Known once the render has picked its clips.
  clipsTotal: number | null;
};
// A clip whose captions are drawn again from its edited words.
export type QueueRecaption = { id: string; name: string; projectId: string; projectName: string; step: string | null };
// An intro or B-roll names the project of the clip it is made from.
// A clip whose title, description and hashtags the script writer is writing.
export type QueueWriter = { id: string; name: string; projectId: string; projectName: string; step: string | null };
export type QueueAiVideo = {
  id: string;
  prompt: string;
  kind: "prompt" | "intro" | "broll";
  projectId: string | null;
  status: "queued" | "running";
  step: string | null;
};
export type QueueSlideshow = { id: string; topic: string; status: "writing" | "queued" | "running"; step: string | null };
// The AI video engine ("ai") or a slideshow engine being installed. They are not owned: one install serves the PC.
export type QueueEngine = { id: string; name: string; step: string | null; percent: number | null };
export type QueuePost = {
  id: string;
  username: string;
  caption: string;
  status: "scheduled" | "container_created";
  scheduledAt: string;
};
export type QueueListing = {
  renders: QueueRender[];
  recaptions: QueueRecaption[];
  writers: QueueWriter[];
  aiVideos: QueueAiVideo[];
  slideshows: QueueSlideshow[];
  engines: QueueEngine[];
  posts: QueuePost[];
};

export async function listQueue({ db, ownerId, now }: { db: PrismaClient; ownerId: string; now: Date }): Promise<QueueListing> {
  const [projects, recaptions, writers, videos, slideshows, aiEngine, slideshowEngines, posts] = await Promise.all([
    db.clipProject.findMany({
      where: { ownerId, status: { in: ["picking", "rendering"] } },
      orderBy: { renderStartedAt: "asc" },
      select: {
        id: true,
        name: true,
        status: true,
        renderStep: true,
        renderStartedAt: true,
        renderId: true,
        renderPlan: true,
        _count: { select: { clips: true } },
      },
    }),
    db.clip.findMany({
      where: { project: { ownerId }, recaptionId: { not: null } },
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true, recaptionStep: true, project: { select: { id: true, name: true } } },
    }),
    db.clip.findMany({
      where: { project: { ownerId }, aiWriteId: { not: null } },
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true, aiWriteStep: true, project: { select: { id: true, name: true } } },
    }),
    db.aiVideoJob.findMany({
      where: { ownerId, status: { in: ["queued", "running"] } },
      orderBy: { createdAt: "asc" },
      select: { id: true, prompt: true, kind: true, status: true, step: true, sourceClip: { select: { projectId: true } } },
    }),
    db.slideshowJob.findMany({
      where: { ownerId, status: { in: ["writing", "queued", "running"] } },
      orderBy: { createdAt: "asc" },
      select: { id: true, topic: true, status: true, step: true },
    }),
    db.aiEngine.findFirst({ where: { status: "installing" }, select: { step: true, percent: true } }),
    db.slideshowEngine.findMany({ where: { status: "installing" }, orderBy: { id: "asc" }, select: { id: true, step: true, percent: true } }),
    db.post.findMany({
      where: {
        account: { ownerId },
        OR: [
          { status: "container_created" },
          { status: "scheduled", scheduledAt: { lte: new Date(now.getTime() + PUBLISH_SOON_MS) } },
        ],
      },
      orderBy: { scheduledAt: "asc" },
      select: { id: true, caption: true, status: true, scheduledAt: true, account: { select: { username: true } } },
    }),
  ]);

  return {
    renders: projects.map((project) => {
      if (!project.renderStartedAt) throw new Error(`rendering project ${project.id} has no start time`);
      if (project.status !== "picking" && project.status !== "rendering") throw new Error(`project ${project.id} is ${project.status}`);
      const plan = project.status === "rendering" ? resumablePlan(requireRenderId(project), project.renderPlan) : null;
      return {
        id: project.id,
        name: project.name,
        status: project.status,
        step: project.renderStep,
        startedAt: project.renderStartedAt.toISOString(),
        clipsDone: project._count.clips,
        clipsTotal: plan ? plan.clips.length : null,
      };
    }),
    recaptions: recaptions.map((clip) => ({
      id: clip.id,
      name: clip.name,
      projectId: clip.project.id,
      projectName: clip.project.name,
      step: clip.recaptionStep,
    })),
    writers: writers.map((clip) => ({
      id: clip.id,
      name: clip.name,
      projectId: clip.project.id,
      projectName: clip.project.name,
      step: clip.aiWriteStep,
    })),
    aiVideos: videos.map((video) => {
      if (video.status !== "queued" && video.status !== "running") throw new Error(`AI video ${video.id} is ${video.status}`);
      return {
        id: video.id,
        prompt: video.prompt,
        kind: video.kind,
        projectId: video.sourceClip?.projectId ?? null,
        status: video.status,
        step: video.step,
      };
    }),
    slideshows: slideshows.map((show) => {
      if (show.status !== "writing" && show.status !== "queued" && show.status !== "running") throw new Error(`slideshow ${show.id} is ${show.status}`);
      return { id: show.id, topic: show.topic, status: show.status, step: show.step };
    }),
    engines: [
      ...(aiEngine ? [{ id: "ai", name: "AI video engine", step: aiEngine.step, percent: aiEngine.percent }] : []),
      ...slideshowEngines.map((engine) => {
        if (!isSlideshowEngineId(engine.id)) throw new Error(`unknown slideshow engine "${engine.id}"`);
        return { id: engine.id, name: SLIDESHOW_ENGINES[engine.id].name, step: engine.step, percent: engine.percent };
      }),
    ],
    posts: posts.map((post) => {
      if (post.status !== "scheduled" && post.status !== "container_created") throw new Error(`post ${post.id} is ${post.status}`);
      return {
        id: post.id,
        username: post.account.username,
        caption: post.caption,
        status: post.status,
        scheduledAt: post.scheduledAt.toISOString(),
      };
    }),
  };
}

// Stops a render or "Find highlights": its waiting job is dropped, and a running one stops before its next clip or step,
// as the project no longer carries its render id. The clips already made stay; the project is "done" with them, or
// "ready" without any.
export async function cancelRender({
  db,
  jobs,
  ownerId,
  projectId,
}: {
  db: PrismaClient;
  jobs: ClipJobs;
  ownerId: string;
  projectId: string;
}) {
  const project = await db.clipProject.findFirst({
    where: { id: projectId, ownerId },
    select: { id: true, status: true, renderId: true, _count: { select: { clips: true } } },
  });
  if (!project) throw new UserError("project not found");
  if (project.status !== "rendering" && project.status !== "picking") {
    throw new UserError("this project is not making clips or finding highlights");
  }
  const renderId = requireRenderId(project);

  const open = await jobs.open(projectId);
  if (open.length > 0) await jobs.cancel(open.map((job) => job.id));
  const { count } = await db.clipProject.updateMany({
    where: { id: projectId, status: project.status, renderId },
    data: {
      status: project._count.clips > 0 ? "done" : "ready",
      renderStep: RENDER_CANCELLED,
      renderId: null,
      error: null,
    },
  });
  if (count === 0) throw new UserError("the clips finished before they could be cancelled");
}

// Stops drawing a clip's captions again: its waiting job is dropped, and a running one stops at its next step, as the
// clip no longer carries its recaption id. The clip and its words stay as they were.
export async function cancelRecaption({
  db,
  jobs,
  ownerId,
  clipId,
}: {
  db: PrismaClient;
  jobs: RecaptionJobs;
  ownerId: string;
  clipId: string;
}) {
  const clip = await db.clip.findFirst({ where: { id: clipId, project: { ownerId } }, select: { recaptionId: true } });
  if (!clip) throw new UserError("clip not found");
  if (!clip.recaptionId) throw new UserError("this clip's captions are not being re-rendered");

  const { count } = await db.clip.updateMany({
    where: { id: clipId, recaptionId: clip.recaptionId },
    data: { recaptionId: null, recaptionStep: null, recaptionWords: Prisma.DbNull, recaptionSounds: Prisma.DbNull },
  });
  if (count === 0) throw new UserError("the captions finished before they could be cancelled");
  const open = await jobs.open(clipId);
  if (open.length > 0) await jobs.cancel(open);
}

// Stops an AI video: it is marked failed with "Cancelled", its job is dropped, and ComfyUI is interrupted when the
// worker is making it. The worker stops at its next check.
export async function cancelAiVideo({
  db,
  jobs,
  interrupt,
  ownerId,
  jobId,
}: {
  db: PrismaClient;
  jobs: WorkJobs;
  interrupt: () => Promise<void>;
  ownerId: string;
  jobId: string;
}) {
  const video = await db.aiVideoJob.findFirst({ where: { id: jobId, ownerId }, select: { status: true } });
  if (!video) throw new UserError("AI video not found");
  if (video.status !== "queued" && video.status !== "running") throw new UserError("this AI video is not waiting or being made");

  const { count } = await db.aiVideoJob.updateMany({
    where: { id: jobId, status: { in: ["queued", "running"] } },
    data: { status: "failed", step: null, error: AI_VIDEO_CANCELLED },
  });
  if (count === 0) throw new UserError("the AI video finished before it could be cancelled");
  const open = await jobs.open(jobId);
  if (open.length > 0) await jobs.cancel(open);
  // Only when it was running: a waiting video's ComfyUI, if one answers, is making another video.
  if (video.status === "running") await interrupt();
}

// Stops a slideshow whose script is being written or which is waiting or being made: it is marked failed with
// "Cancelled", its job is dropped, and the worker stops at its next step, killing the llama-server or sd-cli it runs.
// A slideshow cancelled once its script was written can be made again from its draft.
export async function cancelSlideshow({
  db,
  jobs,
  ownerId,
  jobId,
}: {
  db: PrismaClient;
  jobs: WorkJobs;
  ownerId: string;
  jobId: string;
}) {
  const show = await db.slideshowJob.findFirst({ where: { id: jobId, ownerId }, select: { status: true } });
  if (!show) throw new UserError("slideshow not found");
  const busy = ["writing", "queued", "running"] as const;
  if (!(busy as readonly string[]).includes(show.status)) throw new UserError("this slideshow is not being written or made");

  const { count } = await db.slideshowJob.updateMany({
    where: { id: jobId, status: { in: [...busy] } },
    data: { status: "failed", step: null, error: SLIDESHOW_CANCELLED },
  });
  if (count === 0) throw new UserError("the slideshow finished before it could be cancelled");
  const open = await jobs.open(jobId);
  if (open.length > 0) await jobs.cancel(open);
}
