import type { PrismaClient } from "@/generated/prisma/client";
import { AI_VIDEO_CANCELLED } from "./ai-video";
import { requireRenderId, resumablePlan } from "./clip-resume";
import type { AiVideoJobs, ClipJobs } from "./queues";
import { UserError } from "./user-error";

// What the Queue page lists: everything running or waiting. Dates are ISO strings, as the page polls this as JSON.

// Posts are listed from an hour before they publish.
export const PUBLISH_SOON_MS = 60 * 60 * 1000;
export const RENDER_CANCELLED = "Cancelled";

export type QueueRender = {
  id: string;
  name: string;
  step: string | null;
  startedAt: string;
  clipsDone: number;
  // Known once the render has picked its clips.
  clipsTotal: number | null;
};
export type QueueAiVideo = { id: string; prompt: string; status: "queued" | "running"; step: string | null };
export type QueuePost = {
  id: string;
  username: string;
  caption: string;
  status: "scheduled" | "container_created";
  scheduledAt: string;
};
export type QueueListing = { renders: QueueRender[]; aiVideos: QueueAiVideo[]; posts: QueuePost[] };

export async function listQueue({ db, ownerId, now }: { db: PrismaClient; ownerId: string; now: Date }): Promise<QueueListing> {
  const [projects, videos, posts] = await Promise.all([
    db.clipProject.findMany({
      where: { ownerId, status: "rendering" },
      orderBy: { renderStartedAt: "asc" },
      select: {
        id: true,
        name: true,
        renderStep: true,
        renderStartedAt: true,
        renderId: true,
        renderPlan: true,
        _count: { select: { clips: true } },
      },
    }),
    db.aiVideoJob.findMany({
      where: { ownerId, status: { in: ["queued", "running"] } },
      orderBy: { createdAt: "asc" },
      select: { id: true, prompt: true, status: true, step: true },
    }),
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
      const plan = resumablePlan(requireRenderId(project), project.renderPlan);
      return {
        id: project.id,
        name: project.name,
        step: project.renderStep,
        startedAt: project.renderStartedAt.toISOString(),
        clipsDone: project._count.clips,
        clipsTotal: plan ? plan.clips.length : null,
      };
    }),
    aiVideos: videos.map((video) => {
      if (video.status !== "queued" && video.status !== "running") throw new Error(`AI video ${video.id} is ${video.status}`);
      return { id: video.id, prompt: video.prompt, status: video.status, step: video.step };
    }),
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

// Stops a render: its waiting job is dropped, and a running one stops before its next clip, as the project no longer
// carries its render id. The clips already made stay; the project is "done" with them, or "ready" without any.
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
  if (project.status !== "rendering") throw new UserError("this project is not making clips");
  const renderId = requireRenderId(project);

  const open = await jobs.open(projectId);
  if (open.length > 0) await jobs.cancel(open.map((job) => job.id));
  const { count } = await db.clipProject.updateMany({
    where: { id: projectId, status: "rendering", renderId },
    data: {
      status: project._count.clips > 0 ? "done" : "ready",
      renderStep: RENDER_CANCELLED,
      renderId: null,
      error: null,
    },
  });
  if (count === 0) throw new UserError("the clips finished before they could be cancelled");
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
  jobs: AiVideoJobs;
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
