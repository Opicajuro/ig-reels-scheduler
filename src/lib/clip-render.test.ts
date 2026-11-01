import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { END_CARD_SECONDS, HOOK_SECONDS, probeDuration } from "@/clip-engine/ffmpeg.js";
import { renderClipProject } from "./clip-render";
import type { ClipStore } from "./clip-store";

let fixture: string;
let root: string;
let workRoot: string;

beforeAll(async () => {
  workRoot = await mkdtemp(path.join(os.tmpdir(), "clip-render-test-"));
  fixture = path.join(workRoot, "fixture.mp4");
  execFileSync("ffmpeg", [
    "-v", "error", "-y",
    "-f", "lavfi", "-i", "testsrc=duration=40:size=640x360:rate=30",
    "-f", "lavfi", "-i", "sine=duration=40",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
    fixture,
  ]);
  root = path.join(workRoot, "bucket");
  await mkdir(path.join(root, "clip-sources"), { recursive: true });
  await copyFile(fixture, path.join(root, "clip-sources", "p1.mp4"));
});

afterAll(async () => {
  await rm(workRoot, { recursive: true, force: true });
});

type Row = Record<string, unknown>;

function fakeDb(project: Row, onStep: (step: string, project: Row) => void = () => {}) {
  const state = { project: { ...project }, clips: [] as Row[], steps: [] as string[] };
  const db = {
    clipProject: {
      findUnique: async () => ({ ...state.project }),
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        const matches = Object.entries(where).every(([key, value]) =>
          key === "clips" ? state.clips.length > 0 : key === "id" || state.project[key] === value,
        );
        if (!matches) return { count: 0 };
        Object.assign(state.project, data);
        if (typeof data.renderStep === "string") {
          state.steps.push(data.renderStep);
          onStep(data.renderStep, state.project);
        }
        return { count: 1 };
      },
    },
    clip: {
      findMany: async () =>
        state.clips.map((clip) => ({ id: clip.id, storageKey: clip.storageKey, start: clip.start, title: clip.title ?? null })),
      deleteMany: async () => {
        state.clips = [];
      },
      create: async ({ data }: { data: Row }) => {
        state.clips.push(data);
        return data;
      },
    },
  };
  return { db: db as unknown as PrismaClient, state };
}

function bucketStore(bucket: string) {
  const uploaded: string[] = [];
  const removed: string[] = [];
  const store: ClipStore = {
    downloadTo: async (key, filePath) => copyFile(path.join(bucket, key), filePath),
    upload: async (key, filePath) => {
      await mkdir(path.dirname(path.join(bucket, key)), { recursive: true });
      await copyFile(filePath, path.join(bucket, key));
      uploaded.push(key);
    },
    copy: async (from, to) => {
      await mkdir(path.dirname(path.join(bucket, to)), { recursive: true });
      await copyFile(path.join(bucket, from), path.join(bucket, to));
    },
    remove: async (key) => {
      removed.push(key);
      await rm(path.join(bucket, key), { force: true });
    },
  };
  return { store, uploaded, removed };
}

function renderingProject(overrides: Row = {}): Row {
  return {
    id: "p1",
    status: "rendering",
    renderId: "r1",
    renderPlan: null,
    sourceKey: "clip-sources/p1.mp4",
    sourceUrl: null,
    durationSeconds: null,
    clipSeconds: 15,
    clipCount: 2,
    withCaptions: false,
    captionPreset: null,
    captionFont: "default",
    hookMode: "off",
    hookText: null,
    progressBar: null,
    endCardText: null,
    error: null,
    ...overrides,
  };
}

describe("renderClipProject", () => {
  it("renders the clips from the uploaded source and records each one", async () => {
    const work = await mkdtemp(path.join(workRoot, "run-"));
    const deps = fakeDb(renderingProject());
    const bucket = bucketStore(root);

    await renderClipProject({ db: deps.db, store: bucket.store, projectId: "p1", renderId: "r1", workDir: work });

    expect(deps.state.project).toMatchObject({ status: "done", durationSeconds: 40, error: null });
    expect(deps.state.clips.map((clip) => clip.name)).toEqual(["clip-001", "clip-002"]);
    for (const clip of deps.state.clips) {
      // A clip may run a little past the requested length, so it ends on a quiet moment.
      expect(clip.length).toBeGreaterThanOrEqual(15);
      expect(clip.length).toBeLessThanOrEqual(19);
      expect(String(clip.storageKey)).toMatch(/^clips\/p1\/[0-9a-f-]{36}\.mp4$/);
      const duration = await probeDuration(path.join(root, String(clip.storageKey)));
      expect(duration).toBeGreaterThan(14);
      expect(duration).toBeLessThan(19);
    }
    expect(bucket.uploaded).toHaveLength(2);
  });

  it("records each step in order and clears it when done", async () => {
    const work = await mkdtemp(path.join(workRoot, "run-"));
    const deps = fakeDb(renderingProject());

    await renderClipProject({ db: deps.db, store: bucketStore(root).store, projectId: "p1", renderId: "r1", workDir: work });

    expect(deps.state.steps).toEqual([
      "Downloading the video",
      "Analysing motion and sound",
      "Making clip 1 of 2",
      "Making clip 2 of 2",
    ]);
    expect(deps.state.project.renderStep).toBeNull();
  });

  it("caps the clip count at what the video length allows", async () => {
    const work = await mkdtemp(path.join(workRoot, "run-"));
    const deps = fakeDb(renderingProject({ clipCount: 10 }));

    await renderClipProject({ db: deps.db, store: bucketStore(root).store, projectId: "p1", renderId: "r1", workDir: work });

    expect(deps.state.clips).toHaveLength(2);
  });

  it("removes the previous clips before rendering again", async () => {
    const work = await mkdtemp(path.join(workRoot, "run-"));
    const deps = fakeDb(renderingProject());
    deps.state.clips.push({ id: "old", storageKey: "clips/p1/old.mp4", name: "old" });
    const bucket = bucketStore(root);

    await renderClipProject({ db: deps.db, store: bucket.store, projectId: "p1", renderId: "r1", workDir: work });

    expect(bucket.removed).toEqual(["clips/p1/old.mp4"]);
    expect(deps.state.clips.some((clip) => clip.name === "old")).toBe(false);
  });

  it("stores the picked clips as this render's plan before making them", async () => {
    const work = await mkdtemp(path.join(workRoot, "run-"));
    const deps = fakeDb(renderingProject());

    await renderClipProject({ db: deps.db, store: bucketStore(root).store, projectId: "p1", renderId: "r1", workDir: work });

    expect(deps.state.project.renderPlan).toEqual({
      renderId: "r1",
      clips: deps.state.clips.map(({ id, start, length }) => ({ clipId: id, start, length })),
    });
  });

  it("goes on from the clips an interrupted render saved, without picking again", async () => {
    const work = await mkdtemp(path.join(workRoot, "run-"));
    const plan = {
      renderId: "r1",
      clips: [
        { clipId: "c1", start: 0, length: 15 },
        { clipId: "c2", start: 20, length: 15 },
      ],
    };
    const deps = fakeDb(renderingProject({ renderPlan: plan }));
    deps.state.clips.push({ id: "c1", storageKey: "clips/p1/c1.mp4", name: "clip-001", start: 0, length: 15 });
    const bucket = bucketStore(root);

    await renderClipProject({ db: deps.db, store: bucket.store, projectId: "p1", renderId: "r1", workDir: work });

    expect(bucket.removed).toEqual([]);
    expect(bucket.uploaded).toEqual(["clips/p1/c2.mp4"]);
    expect(deps.state.clips.map((clip) => [clip.id, clip.name, clip.start])).toEqual([
      ["c1", "clip-001", 0],
      ["c2", "clip-002", 20],
    ]);
    expect(deps.state.steps).toEqual(["Resuming… clip 2 of 2", "Resuming… clip 2 of 2"]);
    expect(deps.state.project).toMatchObject({ status: "done", renderStep: null, renderPlan: plan });
  });

  it("finishes an interrupted render whose clips were all saved", async () => {
    const work = await mkdtemp(path.join(workRoot, "run-"));
    const deps = fakeDb(renderingProject({ renderPlan: { renderId: "r1", clips: [{ clipId: "c1", start: 0, length: 15 }] } }));
    deps.state.clips.push({ id: "c1", storageKey: "clips/p1/c1.mp4", name: "clip-001" });
    const bucket = bucketStore(root);

    await renderClipProject({ db: deps.db, store: bucket.store, projectId: "p1", renderId: "r1", workDir: work });

    expect(bucket.uploaded).toEqual([]);
    expect(deps.state.project).toMatchObject({ status: "done", renderStep: null });
  });

  it("starts over, replacing the clips, when the stored plan is from an earlier render", async () => {
    const work = await mkdtemp(path.join(workRoot, "run-"));
    const deps = fakeDb(
      renderingProject({ renderId: "r2", renderPlan: { renderId: "r1", clips: [{ clipId: "c1", start: 0, length: 15 }] } }),
    );
    deps.state.clips.push({ id: "c1", storageKey: "clips/p1/c1.mp4", name: "clip-001" });
    const bucket = bucketStore(root);

    await renderClipProject({ db: deps.db, store: bucket.store, projectId: "p1", renderId: "r2", workDir: work });

    expect(bucket.removed).toEqual(["clips/p1/c1.mp4"]);
    expect(deps.state.clips).toHaveLength(2);
    expect(deps.state.clips.some((clip) => clip.id === "c1")).toBe(false);
    expect(deps.state.project.renderPlan).toMatchObject({ renderId: "r2" });
  });

  it("stops before the next clip once the render is cancelled, keeping the clips made", async () => {
    const work = await mkdtemp(path.join(workRoot, "run-"));
    // The Queue page's cancel clears the render id while the first clip is made.
    const deps = fakeDb(renderingProject(), (step, project) => {
      if (step === "Making clip 1 of 2") Object.assign(project, { status: "ready", renderStep: "Cancelled", renderId: null });
    });
    const bucket = bucketStore(root);

    await renderClipProject({ db: deps.db, store: bucket.store, projectId: "p1", renderId: "r1", workDir: work });

    expect(deps.state.clips.map((clip) => clip.name)).toEqual(["clip-001"]);
    expect(deps.state.steps.at(-1)).toBe("Making clip 1 of 2");
    // Cancelled with no clip made yet, the project went back to ready; the clip finished since then makes it done.
    expect(deps.state.project).toMatchObject({ status: "done", renderStep: "Cancelled", renderId: null });
  });

  it("stops at its next step when cancelled before the clips, without writing over the cancel", async () => {
    const work = await mkdtemp(path.join(workRoot, "run-"));
    const deps = fakeDb(renderingProject(), (step, project) => {
      if (step === "Downloading the video") Object.assign(project, { status: "ready", renderStep: "Cancelled", renderId: null });
    });

    await renderClipProject({ db: deps.db, store: bucketStore(root).store, projectId: "p1", renderId: "r1", workDir: work });

    expect(deps.state.clips).toEqual([]);
    expect(deps.state.steps).toEqual(["Downloading the video"]);
    expect(deps.state.project).toMatchObject({ status: "ready", renderStep: "Cancelled", renderId: null, renderPlan: null });
  });

  it("refuses a job queued for an earlier render", async () => {
    const work = await mkdtemp(path.join(workRoot, "run-"));
    const deps = fakeDb(renderingProject({ renderId: "r2" }));

    await expect(
      renderClipProject({ db: deps.db, store: bucketStore(root).store, projectId: "p1", renderId: "r1", workDir: work }),
    ).rejects.toThrow("earlier render");
    expect(deps.state.project.status).toBe("rendering");
  });

  it("marks the project failed with the reason and rethrows when the source is missing", async () => {
    const work = await mkdtemp(path.join(workRoot, "run-"));
    const deps = fakeDb(renderingProject({ sourceKey: "clip-sources/missing.mp4" }));

    await expect(
      renderClipProject({ db: deps.db, store: bucketStore(root).store, projectId: "p1", renderId: "r1", workDir: work }),
    ).rejects.toThrow();

    expect(deps.state.project.status).toBe("failed");
    expect(String(deps.state.project.error)).not.toBe("");
    expect(deps.state.project.renderStep).toBeNull();
  });

  it("refuses a project that is not in the rendering state", async () => {
    const work = await mkdtemp(path.join(workRoot, "run-"));
    const deps = fakeDb(renderingProject({ status: "ready" }));

    await expect(
      renderClipProject({ db: deps.db, store: bucketStore(root).store, projectId: "p1", renderId: "r1", workDir: work }),
    ).rejects.toThrow("is not rendering");
    expect(await readFile(fixture).then((bytes) => bytes.length > 0)).toBe(true);
  });

  it("keeps the clip titles for a hook that shows them, and draws each clip's hook, end card and bar", async () => {
    const deps = fakeDb(
      renderingProject({ hookMode: "clipTitle", endCardText: "@myhandle", progressBar: "cyan", captionFont: "anton" }),
    );
    const bucket = bucketStore(root);
    await renderClipProject({
      db: deps.db,
      store: bucket.store,
      projectId: "p1",
      renderId: "r1",
      workDir: await mkdtemp(path.join(workRoot, "run-")),
    });
    // The first clips have no titles yet, so they have no hook.
    expect(deps.state.clips.map((clip) => clip.title)).toEqual([null, null]);
    deps.state.clips[0].title = "Watch this";
    const titled = deps.state.clips[0].start;

    Object.assign(deps.state.project, { status: "rendering", renderId: "r2" });
    await renderClipProject({
      db: deps.db,
      store: bucket.store,
      projectId: "p1",
      renderId: "r2",
      workDir: await mkdtemp(path.join(workRoot, "run-")),
    });

    expect(deps.state.clips.map((clip) => [clip.start, clip.title])).toEqual([
      [titled, "Watch this"],
      [deps.state.clips[1].start, null],
    ]);
    const [first, second] = deps.state.clips.map((clip) => ({
      file: path.join(root, String(clip.storageKey)),
      length: Number(clip.length),
    }));
    // The rows the hook's box covers.
    const top = (file: string, seconds: number) => grayRows(file, seconds, 150, 100);
    // testsrc moves, so each clip's top is compared with its frame a moment after the hook has gone: only the titled
    // clip changes much.
    const hookChange = (file: string) => changedShare(top(file, 1), top(file, HOOK_SECONDS + 0.1));
    expect(hookChange(first.file) - hookChange(second.file)).toBeGreaterThan(0.3);
    // The end card dims the whole picture in the last seconds, of every clip.
    for (const clip of [first, second]) {
      const before = meanGray(clip.file, clip.length - END_CARD_SECONDS - 0.5);
      const during = meanGray(clip.file, clip.length - END_CARD_SECONDS + 0.3);
      expect(before - during).toBeGreaterThan(30);
    }
  });
});

// The frame at seconds as gray rows y to y + height.
function grayRows(file: string, seconds: number, y: number, height: number) {
  return execFileSync("ffmpeg", [
    "-v", "error", "-ss", String(seconds), "-i", file, "-frames:v", "1",
    "-vf", `crop=iw:${height}:0:${y}`, "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1",
  ], { maxBuffer: 16 * 1024 * 1024 });
}

function meanGray(file: string, seconds: number) {
  const pixels = grayRows(file, seconds, 0, 1920);
  let sum = 0;
  for (const value of pixels) sum += value;
  return sum / pixels.length;
}

function changedShare(a: Buffer, b: Buffer) {
  let changed = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 40) changed++;
  return changed / a.length;
}
