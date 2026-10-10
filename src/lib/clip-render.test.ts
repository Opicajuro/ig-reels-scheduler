import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { probeDuration } from "@/clip-engine/ffmpeg.js";
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

function fakeDb(project: Row) {
  const state = { project: { ...project }, clips: [] as Row[] };
  const db = {
    clipProject: {
      findUnique: async () => ({ ...state.project }),
      update: async ({ data }: { data: Row }) => {
        Object.assign(state.project, data);
        return state.project;
      },
    },
    clip: {
      findMany: async () => state.clips.map((clip) => ({ storageKey: clip.storageKey })),
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
    sourceKey: "clip-sources/p1.mp4",
    sourceUrl: null,
    durationSeconds: null,
    clipSeconds: 15,
    clipCount: 2,
    withCaptions: false,
    captionPreset: null,
    error: null,
    ...overrides,
  };
}

describe("renderClipProject", () => {
  it("renders the clips from the uploaded source and records each one", async () => {
    const work = await mkdtemp(path.join(workRoot, "run-"));
    const deps = fakeDb(renderingProject());
    const bucket = bucketStore(root);

    await renderClipProject({ db: deps.db, store: bucket.store, projectId: "p1", workDir: work });

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

  it("caps the clip count at what the video length allows", async () => {
    const work = await mkdtemp(path.join(workRoot, "run-"));
    const deps = fakeDb(renderingProject({ clipCount: 10 }));

    await renderClipProject({ db: deps.db, store: bucketStore(root).store, projectId: "p1", workDir: work });

    expect(deps.state.clips).toHaveLength(2);
  });

  it("removes the previous clips before rendering again", async () => {
    const work = await mkdtemp(path.join(workRoot, "run-"));
    const deps = fakeDb(renderingProject());
    deps.state.clips.push({ storageKey: "clips/p1/old.mp4", name: "old" });
    const bucket = bucketStore(root);

    await renderClipProject({ db: deps.db, store: bucket.store, projectId: "p1", workDir: work });

    expect(bucket.removed).toEqual(["clips/p1/old.mp4"]);
    expect(deps.state.clips.some((clip) => clip.name === "old")).toBe(false);
  });

  it("marks the project failed with the reason and rethrows when the source is missing", async () => {
    const work = await mkdtemp(path.join(workRoot, "run-"));
    const deps = fakeDb(renderingProject({ sourceKey: "clip-sources/missing.mp4" }));

    await expect(
      renderClipProject({ db: deps.db, store: bucketStore(root).store, projectId: "p1", workDir: work }),
    ).rejects.toThrow();

    expect(deps.state.project.status).toBe("failed");
    expect(String(deps.state.project.error)).not.toBe("");
  });

  it("refuses a project that is not in the rendering state", async () => {
    const work = await mkdtemp(path.join(workRoot, "run-"));
    const deps = fakeDb(renderingProject({ status: "ready" }));

    await expect(
      renderClipProject({ db: deps.db, store: bucketStore(root).store, projectId: "p1", workDir: work }),
    ).rejects.toThrow("is not rendering");
    expect(await readFile(fixture).then((bytes) => bytes.length > 0)).toBe(true);
  });
});
