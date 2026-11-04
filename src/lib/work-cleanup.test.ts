import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import type { ClipStore } from "./clip-store";
import type { StartupWorkJobs } from "./queues";
import { CLOSED_ERROR, deleteAiVideo, deleteSlideshow, failInterruptedAiVideos, failInterruptedSlideshows } from "./work-cleanup";

type Row = Record<string, unknown> & { id: string };

// Enough of Prisma for these functions: { in } filters, { project: { ownerId } } on clips, and include: { project }.
function fakeDb(seed: { videos?: Row[]; shows?: Row[]; projects?: Row[]; clips?: Row[] }) {
  const tables: Record<string, Row[]> = {
    aiVideoJob: seed.videos ?? [],
    slideshowJob: seed.shows ?? [],
    clipProject: seed.projects ?? [],
    clip: seed.clips ?? [],
  };
  const project = (clip: Row) => tables.clipProject.find((row) => row.id === clip.projectId);
  const matches = (row: Row, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([key, value]) => {
      if (key === "project") return project(row)?.ownerId === (value as { ownerId: string }).ownerId;
      if (value && typeof value === "object" && "in" in value) return (value.in as unknown[]).includes(row[key]);
      return row[key] === value;
    });
  const model = (table: string) => ({
    findMany: async ({ where, include }: { where: Record<string, unknown>; include?: { project?: boolean } }) =>
      tables[table].filter((row) => matches(row, where)).map((row) => ({ ...row, ...(include?.project ? { project: project(row) } : {}) })),
    findFirst: async ({ where }: { where: Record<string, unknown> }) => tables[table].find((row) => matches(row, where)) ?? null,
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const rows = tables[table].filter((row) => matches(row, where));
      for (const row of rows) Object.assign(row, data);
      return { count: rows.length };
    },
    delete: async ({ where }: { where: { id: string } }) => {
      tables[table] = tables[table].filter((row) => row.id !== where.id);
    },
    deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
      tables[table] = tables[table].filter((row) => !matches(row, where));
    },
  });
  const db = {
    aiVideoJob: model("aiVideoJob"),
    slideshowJob: model("slideshowJob"),
    clip: model("clip"),
  } as unknown as PrismaClient;
  return { db, tables };
}

// pg-boss jobs per id: "created" ones wait for the worker, "active" ones were taken by the closed worker.
function fakeJobs(byId: Record<string, Array<{ id: string; state: "created" | "active" }>>) {
  const cancelled: string[] = [];
  const jobs: StartupWorkJobs = {
    open: async (id) => (byId[id] ?? []).map((job) => job.id),
    waiting: async (id) => (byId[id] ?? []).filter((job) => job.state === "created").map((job) => job.id),
    cancel: async (ids) => void cancelled.push(...ids),
  };
  return { jobs, cancelled };
}

function fakeStore() {
  const removed: string[] = [];
  const store: ClipStore = {
    downloadTo: async () => {},
    upload: async () => {},
    copy: async () => {},
    remove: async (key) => void removed.push(key),
  };
  return { store, removed };
}

describe("failInterruptedAiVideos", () => {
  it("fails the videos cut off by closing Localirs and cancels their stale jobs, leaving waiting and finished ones", async () => {
    const { db, tables } = fakeDb({
      videos: [
        { id: "running", status: "running", step: "Generating video 35%", error: null },
        { id: "queued-lost", status: "queued", step: null, error: null },
        { id: "queued-waiting", status: "queued", step: null, error: null },
        { id: "done", status: "done", step: null, error: null },
      ],
    });
    const { jobs, cancelled } = fakeJobs({ running: [{ id: "j1", state: "active" }], "queued-waiting": [{ id: "j2", state: "created" }] });

    expect(await failInterruptedAiVideos({ db, jobs })).toEqual(["running", "queued-lost"]);
    expect(cancelled).toEqual(["j1"]);
    expect(tables.aiVideoJob.map(({ id, status, step, error }) => ({ id, status, step, error }))).toEqual([
      { id: "running", status: "failed", step: null, error: CLOSED_ERROR },
      { id: "queued-lost", status: "failed", step: null, error: CLOSED_ERROR },
      { id: "queued-waiting", status: "queued", step: null, error: null },
      { id: "done", status: "done", step: null, error: null },
    ]);
  });

  it("changes nothing when no video is busy", async () => {
    const { db, tables } = fakeDb({ videos: [{ id: "v1", status: "failed", error: "boom" }] });
    const { jobs, cancelled } = fakeJobs({});
    expect(await failInterruptedAiVideos({ db, jobs })).toEqual([]);
    expect(cancelled).toEqual([]);
    expect(tables.aiVideoJob[0]).toMatchObject({ status: "failed", error: "boom" });
  });
});

describe("failInterruptedSlideshows", () => {
  it("fails slideshows being written or made, keeping their slides", async () => {
    const slides = [{ text: "Hi", picture: "a cat", source: { kind: "ai" } }];
    const { db, tables } = fakeDb({
      shows: [
        { id: "writing", status: "writing", slides: null },
        { id: "running", status: "running", slides },
        { id: "draft", status: "draft", slides },
      ],
    });
    const { jobs, cancelled } = fakeJobs({ running: [{ id: "j1", state: "active" }] });

    expect(await failInterruptedSlideshows({ db, jobs })).toEqual(["writing", "running"]);
    expect(cancelled).toEqual(["j1"]);
    expect(tables.slideshowJob.map(({ id, status, error }) => ({ id, status, error }))).toEqual([
      { id: "writing", status: "failed", error: CLOSED_ERROR },
      { id: "running", status: "failed", error: CLOSED_ERROR },
      { id: "draft", status: "draft", error: undefined },
    ]);
    expect(tables.slideshowJob[1].slides).toEqual(slides);
  });
});

const owned = { ownerId: "user-1" };
const projects = [
  { id: "p1", ownerId: "user-1", status: "done" },
  { id: "p2", ownerId: "user-2", status: "done" },
];
const clip = (fields: Partial<Row> = {}): Row => ({
  id: "c1",
  projectId: "p1",
  storageKey: "clips/p1/c1.mp4",
  baseKey: null,
  recaptionId: null,
  ...fields,
});

describe("deleteAiVideo", () => {
  it("deletes the video's start picture, its clip with the clip's file, and its row", async () => {
    const { db, tables } = fakeDb({
      projects,
      clips: [clip(), clip({ id: "c2", storageKey: "clips/p1/c2.mp4" })],
      videos: [{ id: "v1", ownerId: "user-1", status: "done", clipId: "c1", startImageKey: "ai-inputs/a.png" }],
    });
    const files = fakeStore();
    await deleteAiVideo({ db, store: files.store, ...owned, jobId: "v1" });

    expect(files.removed).toEqual(["ai-inputs/a.png", "clips/p1/c1.mp4"]);
    expect(tables.clip.map((row) => row.id)).toEqual(["c2"]);
    expect(tables.aiVideoJob).toEqual([]);
  });

  it("deletes a failed video that made no clip", async () => {
    const { db, tables } = fakeDb({ videos: [{ id: "v1", ownerId: "user-1", status: "failed", clipId: null, startImageKey: null }] });
    const files = fakeStore();
    await deleteAiVideo({ db, store: files.store, ...owned, jobId: "v1" });
    expect(files.removed).toEqual([]);
    expect(tables.aiVideoJob).toEqual([]);
  });

  it("refuses a video still waiting or being made, and someone else's", async () => {
    const { db, tables } = fakeDb({
      projects,
      clips: [clip({ id: "theirs", projectId: "p2" })],
      videos: [
        { id: "running", ownerId: "user-1", status: "running", clipId: null, startImageKey: null },
        { id: "queued", ownerId: "user-1", status: "queued", clipId: null, startImageKey: null },
        { id: "theirs", ownerId: "user-2", status: "done", clipId: "theirs", startImageKey: null },
      ],
    });
    const files = fakeStore();
    await expect(deleteAiVideo({ db, store: files.store, ...owned, jobId: "running" })).rejects.toThrow("cancel it first");
    await expect(deleteAiVideo({ db, store: files.store, ...owned, jobId: "queued" })).rejects.toThrow("cancel it first");
    await expect(deleteAiVideo({ db, store: files.store, ...owned, jobId: "theirs" })).rejects.toThrow("AI video not found");
    expect(files.removed).toEqual([]);
    expect(tables.aiVideoJob).toHaveLength(3);
    expect(tables.clip).toHaveLength(1);
  });
});

describe("deleteSlideshow", () => {
  it("deletes the slides' photos, the clip and the row", async () => {
    const { db, tables } = fakeDb({
      projects,
      clips: [clip({ id: "c1", storageKey: "clips/p1/c1.mp4", baseKey: "clips/p1/c1-base.mp4" })],
      shows: [
        {
          id: "s1",
          ownerId: "user-1",
          status: "done",
          clipId: "c1",
          slides: [
            { text: "a", picture: "b", source: { kind: "photo", key: "slideshow-inputs/x.png" } },
            { text: "c", picture: "d", source: { kind: "ai" } },
          ],
        },
      ],
    });
    const files = fakeStore();
    await deleteSlideshow({ db, store: files.store, ...owned, jobId: "s1" });

    expect(files.removed).toEqual(["slideshow-inputs/x.png", "clips/p1/c1.mp4", "clips/p1/c1-base.mp4"]);
    expect(tables.clip).toEqual([]);
    expect(tables.slideshowJob).toEqual([]);
  });

  it("refuses a slideshow being written or made, and someone else's", async () => {
    const { db, tables } = fakeDb({
      shows: [
        { id: "writing", ownerId: "user-1", status: "writing", clipId: null, slides: null },
        { id: "theirs", ownerId: "user-2", status: "draft", clipId: null, slides: null },
      ],
    });
    const files = fakeStore();
    await expect(deleteSlideshow({ db, store: files.store, ...owned, jobId: "writing" })).rejects.toThrow("cancel it first");
    await expect(deleteSlideshow({ db, store: files.store, ...owned, jobId: "theirs" })).rejects.toThrow("slideshow not found");
    expect(tables.slideshowJob).toHaveLength(2);
  });
});
