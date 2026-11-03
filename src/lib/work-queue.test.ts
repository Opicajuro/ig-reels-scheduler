import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import type { WorkJobs, ClipJob, ClipJobs, RecaptionJobs } from "./queues";
import { requeueInterruptedRecaptions } from "./clip-resume";
import { cancelAiVideo, cancelRecaption, cancelRender, cancelSlideshow, listQueue, PUBLISH_SOON_MS } from "./work-queue";

type Row = Record<string, unknown>;

const now = new Date("2026-10-30T12:00:00Z");

describe("listQueue", () => {
  it("lists renders with their progress, AI videos, slideshows, engine installs and posts publishing within the hour", async () => {
    const where: Row = {};
    const db = {
      clipProject: {
        findMany: async (args: { where: Row }) => {
          where.projects = args.where;
          return [
            {
              id: "p1",
              name: "Talk",
              status: "rendering",
              renderStep: "Making clip 2 of 3",
              renderStartedAt: new Date("2026-10-30T11:50:00Z"),
              renderId: "r1",
              renderPlan: { renderId: "r1", clips: [1, 2, 3].map((n) => ({ clipId: `c${n}`, start: n * 40, length: 30 })) },
              _count: { clips: 1 },
            },
            {
              id: "p2",
              name: "Podcast",
              status: "rendering",
              renderStep: null,
              renderStartedAt: new Date("2026-10-30T11:59:00Z"),
              renderId: "r2",
              // An earlier render's plan: this one has not picked its clips yet.
              renderPlan: { renderId: "r0", clips: [] },
              _count: { clips: 0 },
            },
            {
              id: "p3",
              name: "Lecture",
              status: "picking",
              renderStep: "Analysing motion and sound",
              renderStartedAt: new Date("2026-10-30T11:59:30Z"),
              renderId: "r3",
              // Finding highlights makes no clips, so the clips of the last render are not counted against a plan.
              renderPlan: { renderId: "r3", clips: [] },
              _count: { clips: 2 },
            },
          ];
        },
      },
      clip: {
        findMany: async (args: { where: Row }) => {
          where.recaptions = args.where;
          return [{ id: "c9", name: "clip-002", recaptionStep: "Drawing captions", project: { id: "p1", name: "Talk" } }];
        },
      },
      aiVideoJob: {
        findMany: async (args: { where: Row }) => {
          where.videos = args.where;
          return [
            { id: "v1", prompt: "A fox", kind: "prompt", status: "running", step: "Generating video 40%", sourceClip: null },
            { id: "v2", prompt: "A sunrise", kind: "intro", status: "queued", step: null, sourceClip: { projectId: "p9" } },
          ];
        },
      },
      slideshowJob: {
        findMany: async (args: { where: Row }) => {
          where.slideshows = args.where;
          return [{ id: "s1", topic: "Sleep", status: "writing", step: "Writing script" }];
        },
      },
      aiEngine: { findFirst: async () => ({ step: "Downloading ComfyUI", percent: 12 }) },
      slideshowEngine: { findMany: async () => [{ id: "picture", step: "Unpacking sd-cli", percent: 80 }] },
      post: {
        findMany: async (args: { where: Row }) => {
          where.posts = args.where;
          return [
            {
              id: "post1",
              caption: "Hello",
              status: "container_created",
              scheduledAt: new Date("2026-10-30T12:20:00Z"),
              account: { username: "me" },
            },
          ];
        },
      },
    } as unknown as PrismaClient;

    const listing = await listQueue({ db, ownerId: "o1", now });

    expect(listing).toEqual({
      renders: [
        { id: "p1", name: "Talk", status: "rendering", step: "Making clip 2 of 3", startedAt: "2026-10-30T11:50:00.000Z", clipsDone: 1, clipsTotal: 3 },
        { id: "p2", name: "Podcast", status: "rendering", step: null, startedAt: "2026-10-30T11:59:00.000Z", clipsDone: 0, clipsTotal: null },
        { id: "p3", name: "Lecture", status: "picking", step: "Analysing motion and sound", startedAt: "2026-10-30T11:59:30.000Z", clipsDone: 2, clipsTotal: null },
      ],
      recaptions: [{ id: "c9", name: "clip-002", projectId: "p1", projectName: "Talk", step: "Drawing captions" }],
      aiVideos: [
        { id: "v1", prompt: "A fox", kind: "prompt", projectId: null, status: "running", step: "Generating video 40%" },
        { id: "v2", prompt: "A sunrise", kind: "intro", projectId: "p9", status: "queued", step: null },
      ],
      slideshows: [{ id: "s1", topic: "Sleep", status: "writing", step: "Writing script" }],
      engines: [
        { id: "ai", name: "AI video engine", step: "Downloading ComfyUI", percent: 12 },
        { id: "picture", name: "Picture maker", step: "Unpacking sd-cli", percent: 80 },
      ],
      posts: [{ id: "post1", username: "me", caption: "Hello", status: "container_created", scheduledAt: "2026-10-30T12:20:00.000Z" }],
    });
    expect(where.projects).toEqual({ ownerId: "o1", status: { in: ["picking", "rendering"] } });
    expect(where.recaptions).toEqual({ project: { ownerId: "o1" }, recaptionId: { not: null } });
    expect(where.videos).toEqual({ ownerId: "o1", status: { in: ["queued", "running"] } });
    expect(where.slideshows).toEqual({ ownerId: "o1", status: { in: ["writing", "queued", "running"] } });
    expect(where.posts).toEqual({
      account: { ownerId: "o1" },
      OR: [
        { status: "container_created" },
        { status: "scheduled", scheduledAt: { lte: new Date(now.getTime() + PUBLISH_SOON_MS) } },
      ],
    });
  });

  it("throws on a rendering project without a start time", async () => {
    const db = {
      clipProject: {
        findMany: async () => [{ id: "p1", name: "x", status: "rendering", renderStep: null, renderStartedAt: null, renderId: "r1", renderPlan: null, _count: { clips: 0 } }],
      },
      clip: { findMany: async () => [] },
      aiVideoJob: { findMany: async () => [] },
      slideshowJob: { findMany: async () => [] },
      aiEngine: { findFirst: async () => null },
      slideshowEngine: { findMany: async () => [] },
      post: { findMany: async () => [] },
    } as unknown as PrismaClient;
    await expect(listQueue({ db, ownerId: "o1", now })).rejects.toThrow("no start time");
  });
});

function fakeProjects(project: Row | null) {
  const state = { project: project && { ...project }, clips: 0 };
  const db = {
    clipProject: {
      findFirst: async ({ where }: { where: Row }) =>
        state.project && state.project.id === where.id && state.project.ownerId === where.ownerId
          ? { ...state.project, _count: { clips: state.clips } }
          : null,
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        const p = state.project;
        if (!p || p.id !== where.id || p.status !== where.status || p.renderId !== where.renderId) return { count: 0 };
        Object.assign(p, data);
        return { count: 1 };
      },
    },
  };
  return { db: db as unknown as PrismaClient, state };
}

function fakeClipJobs(open: ClipJob[]) {
  const cancelled: string[] = [];
  const jobs: ClipJobs = {
    open: async () => open,
    cancel: async (ids) => void cancelled.push(...ids),
    send: async () => "job",
  };
  return { jobs, cancelled };
}

describe("cancelRender", () => {
  const rendering = { id: "p1", ownerId: "o1", status: "rendering", renderId: "r1", renderStep: "Making clip 2 of 3" };

  it("cancels the render's jobs and keeps the clips already made", async () => {
    const { db, state } = fakeProjects(rendering);
    state.clips = 1;
    const { jobs, cancelled } = fakeClipJobs([{ id: "j1", state: "active", renderId: "r1" }]);

    await cancelRender({ db, jobs, ownerId: "o1", projectId: "p1" });

    expect(cancelled).toEqual(["j1"]);
    expect(state.project).toMatchObject({ status: "done", renderStep: "Cancelled", renderId: null, error: null });
  });

  it("leaves a project without clips ready to make clips again", async () => {
    const { db, state } = fakeProjects(rendering);
    const { jobs, cancelled } = fakeClipJobs([]);

    await cancelRender({ db, jobs, ownerId: "o1", projectId: "p1" });

    expect(cancelled).toEqual([]);
    expect(state.project).toMatchObject({ status: "ready", renderStep: "Cancelled", renderId: null });
  });

  it("stops finding highlights, back to ready or to the clips of the last render", async () => {
    const picking = { ...rendering, status: "picking", renderStep: "Analysing motion and sound" };
    const { db, state } = fakeProjects(picking);
    const { jobs, cancelled } = fakeClipJobs([{ id: "j1", state: "active", renderId: "r1" }]);

    await cancelRender({ db, jobs, ownerId: "o1", projectId: "p1" });

    expect(cancelled).toEqual(["j1"]);
    expect(state.project).toMatchObject({ status: "ready", renderStep: "Cancelled", renderId: null });

    const withClips = fakeProjects(picking);
    withClips.state.clips = 2;
    await cancelRender({ db: withClips.db, jobs, ownerId: "o1", projectId: "p1" });
    expect(withClips.state.project).toMatchObject({ status: "done", renderId: null });
  });

  it("refuses another owner's project, a project not making clips, and a render that finished meanwhile", async () => {
    const { jobs } = fakeClipJobs([]);
    await expect(cancelRender({ db: fakeProjects(rendering).db, jobs, ownerId: "o2", projectId: "p1" })).rejects.toThrow("not found");
    const done = fakeProjects({ ...rendering, status: "done" }).db;
    await expect(cancelRender({ db: done, jobs, ownerId: "o1", projectId: "p1" })).rejects.toThrow("not making clips");

    const { db, state } = fakeProjects(rendering);
    const finishing: ClipJobs = {
      ...jobs,
      open: async () => {
        state.project!.status = "done";
        return [];
      },
    };
    await expect(cancelRender({ db, jobs: finishing, ownerId: "o1", projectId: "p1" })).rejects.toThrow("finished before");
    expect(state.project).toMatchObject({ status: "done", renderId: "r1" });
  });
});

function fakeVideos(video: Row) {
  const state = { video: { ...video } };
  const db = {
    aiVideoJob: {
      findFirst: async ({ where }: { where: Row }) =>
        state.video.id === where.id && state.video.ownerId === where.ownerId ? { ...state.video } : null,
      updateMany: async ({ where, data }: { where: { id: string; status: { in: string[] } }; data: Row }) => {
        if (state.video.id !== where.id || !where.status.in.includes(String(state.video.status))) return { count: 0 };
        Object.assign(state.video, data);
        return { count: 1 };
      },
    },
  };
  return { db: db as unknown as PrismaClient, state };
}

function fakeVideoJobs(open: string[]) {
  const cancelled: string[] = [];
  const jobs: WorkJobs = { open: async () => open, cancel: async (ids) => void cancelled.push(...ids) };
  return { jobs, cancelled };
}

describe("cancelAiVideo", () => {
  it("marks a running video cancelled, cancels its job and interrupts ComfyUI", async () => {
    const { db, state } = fakeVideos({ id: "v1", ownerId: "o1", status: "running", step: "Generating video 40%" });
    const { jobs, cancelled } = fakeVideoJobs(["j1"]);
    let interrupted = 0;

    await cancelAiVideo({ db, jobs, interrupt: async () => void interrupted++, ownerId: "o1", jobId: "v1" });

    expect(state.video).toMatchObject({ status: "failed", step: null, error: "Cancelled" });
    expect(cancelled).toEqual(["j1"]);
    expect(interrupted).toBe(1);
  });

  it("does not interrupt ComfyUI for a waiting video, which may be making another one", async () => {
    const { db, state } = fakeVideos({ id: "v1", ownerId: "o1", status: "queued", step: null });
    const { jobs, cancelled } = fakeVideoJobs(["j1"]);
    let interrupted = 0;

    await cancelAiVideo({ db, jobs, interrupt: async () => void interrupted++, ownerId: "o1", jobId: "v1" });

    expect(state.video.status).toBe("failed");
    expect(cancelled).toEqual(["j1"]);
    expect(interrupted).toBe(0);
  });

  it("refuses another owner's video and one that is already finished", async () => {
    const { jobs } = fakeVideoJobs([]);
    const interrupt = async () => {};
    const running = fakeVideos({ id: "v1", ownerId: "o1", status: "running" }).db;
    await expect(cancelAiVideo({ db: running, jobs, interrupt, ownerId: "o2", jobId: "v1" })).rejects.toThrow("not found");
    const done = fakeVideos({ id: "v1", ownerId: "o1", status: "done" }).db;
    await expect(cancelAiVideo({ db: done, jobs, interrupt, ownerId: "o1", jobId: "v1" })).rejects.toThrow("not waiting");
  });
});

function fakeSlideshows(show: Row) {
  const state = { show: { ...show } };
  const db = {
    slideshowJob: {
      findFirst: async ({ where }: { where: Row }) =>
        state.show.id === where.id && state.show.ownerId === where.ownerId ? { ...state.show } : null,
      updateMany: async ({ where, data }: { where: { id: string; status: { in: string[] } }; data: Row }) => {
        if (state.show.id !== where.id || !where.status.in.includes(String(state.show.status))) return { count: 0 };
        Object.assign(state.show, data);
        return { count: 1 };
      },
    },
  };
  return { db: db as unknown as PrismaClient, state };
}

describe("cancelSlideshow", () => {
  it.each(["writing", "queued", "running"])("marks a %s slideshow cancelled and cancels its job", async (status) => {
    const { db, state } = fakeSlideshows({ id: "s1", ownerId: "o1", status, step: "Voice" });
    const { jobs, cancelled } = fakeVideoJobs(["j1"]);

    await cancelSlideshow({ db, jobs, ownerId: "o1", jobId: "s1" });

    expect(state.show).toMatchObject({ status: "failed", step: null, error: "Cancelled" });
    expect(cancelled).toEqual(["j1"]);
  });

  it("refuses another owner's slideshow, a draft and one that finished meanwhile", async () => {
    const { jobs, cancelled } = fakeVideoJobs(["j1"]);
    const running = fakeSlideshows({ id: "s1", ownerId: "o1", status: "running" }).db;
    await expect(cancelSlideshow({ db: running, jobs, ownerId: "o2", jobId: "s1" })).rejects.toThrow("not found");
    const draft = fakeSlideshows({ id: "s1", ownerId: "o1", status: "draft" }).db;
    await expect(cancelSlideshow({ db: draft, jobs, ownerId: "o1", jobId: "s1" })).rejects.toThrow("not being written or made");

    const { db, state } = fakeSlideshows({ id: "s1", ownerId: "o1", status: "running" });
    const finishing = {
      ...db,
      slideshowJob: {
        ...db.slideshowJob,
        findFirst: async () => {
          const found = { ...state.show };
          state.show.status = "done";
          return found;
        },
      },
    } as unknown as PrismaClient;
    await expect(cancelSlideshow({ db: finishing, jobs, ownerId: "o1", jobId: "s1" })).rejects.toThrow("finished before");
    expect(state.show.status).toBe("done");
    expect(cancelled).toEqual([]);
  });
});

function fakeClips(clip: Row) {
  const state = { clip: { ...clip } };
  const db = {
    clip: {
      findFirst: async ({ where }: { where: { id: string; project: { ownerId: string } } }) =>
        state.clip.id === where.id && state.clip.ownerId === where.project.ownerId ? { ...state.clip } : null,
      findMany: async () => (state.clip.recaptionId ? [{ id: state.clip.id, recaptionId: state.clip.recaptionId }] : []),
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        if (state.clip.id !== where.id || state.clip.recaptionId !== where.recaptionId) return { count: 0 };
        Object.assign(state.clip, data);
        return { count: 1 };
      },
    },
  };
  return { db: db as unknown as PrismaClient, state };
}

function fakeRecaptionJobs(open: string[]) {
  const cancelled: string[] = [];
  const sent: [string, string][] = [];
  const jobs: RecaptionJobs = {
    open: async () => open,
    cancel: async (ids) => void cancelled.push(...ids),
    send: async (clipId, recaptionId) => {
      sent.push([clipId, recaptionId]);
      return "j2";
    },
  };
  return { jobs, cancelled, sent };
}

describe("cancelRecaption", () => {
  it("clears the clip's re-render, keeping the clip, and cancels its job", async () => {
    const { db, state } = fakeClips({ id: "c1", ownerId: "o1", recaptionId: "x1", recaptionStep: "Drawing captions", recaptionWords: [] });
    const { jobs, cancelled } = fakeRecaptionJobs(["j1"]);

    await cancelRecaption({ db, jobs, ownerId: "o1", clipId: "c1" });

    expect(state.clip).toMatchObject({ recaptionId: null, recaptionStep: null });
    expect(cancelled).toEqual(["j1"]);
  });

  it("refuses another owner's clip and a clip that is not being re-rendered", async () => {
    const { jobs, cancelled } = fakeRecaptionJobs(["j1"]);
    const running = fakeClips({ id: "c1", ownerId: "o1", recaptionId: "x1" }).db;
    await expect(cancelRecaption({ db: running, jobs, ownerId: "o2", clipId: "c1" })).rejects.toThrow("not found");
    const idle = fakeClips({ id: "c1", ownerId: "o1", recaptionId: null }).db;
    await expect(cancelRecaption({ db: idle, jobs, ownerId: "o1", clipId: "c1" })).rejects.toThrow("not being re-rendered");
    expect(cancelled).toEqual([]);
  });
});

describe("requeueInterruptedRecaptions", () => {
  it("cancels the interrupted job and queues the same edit again", async () => {
    const { db, state } = fakeClips({ id: "c1", ownerId: "o1", recaptionId: "x1", recaptionStep: "Making the clip" });
    const { jobs, cancelled, sent } = fakeRecaptionJobs(["j1"]);

    expect(await requeueInterruptedRecaptions({ db, jobs })).toEqual(["c1"]);

    expect(cancelled).toEqual(["j1"]);
    expect(sent).toEqual([["c1", "x1"]]);
    expect(state.clip).toMatchObject({ recaptionId: "x1", recaptionStep: null });
  });
});
