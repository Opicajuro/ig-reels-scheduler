import { execFileSync, spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { END_CARD_SECONDS, HOOK_SECONDS, probeDuration } from "@/clip-engine/ffmpeg.js";
import { cutTimes, tightenClip } from "@/clip-engine/pacing.js";
import { recaptionClip, renderClipProject } from "./clip-render";
import type { ClipStore } from "./clip-store";
import { validateHighlights } from "./highlights";

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
  // The library's sound effects used here, as short tones of their own pitch, so each can be found in a clip's sound.
  const music = path.join(workRoot, "music");
  await mkdir(music);
  for (const [id, frequency] of Object.entries(SOUND_TONES)) {
    execFileSync("ffmpeg", [
      "-v", "error", "-y", "-f", "lavfi", "-i", `sine=frequency=${frequency}:sample_rate=48000:duration=0.3`,
      "-af", "volume=4", "-c:a", "libvorbis", path.join(music, `${id}.ogg`),
    ]);
  }
  process.env.MUSIC_DIR = music;
});

const SOUND_TONES = { "kenney-weapon-change": 2000, "kenney-placement": 3000, "kenney-tile-swap": 1500, "kenney-coin": 2500 };

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
        state.clips.map((clip) => ({
          id: clip.id,
          storageKey: clip.storageKey,
          baseKey: clip.baseKey ?? null,
          start: clip.start,
          title: clip.title ?? null,
        })),
      findUnique: async ({ where }: { where: { id: string } }) => {
        const clip = state.clips.find((row) => row.id === where.id);
        if (!clip) return null;
        // As read back: a JSON null is null, and a column never written is null too.
        const read = Object.fromEntries(Object.entries(clip).map(([key, value]) => [key, value === Prisma.DbNull ? null : value]));
        return { sounds: null, cuts: null, recaptionWords: null, recaptionSounds: null, ...read, project: { ...state.project } };
      },
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        const clip = state.clips.find((row) => Object.entries(where).every(([key, value]) => row[key] === value));
        if (!clip) return { count: 0 };
        Object.assign(clip, data);
        if (typeof data.recaptionStep === "string") {
          state.steps.push(data.recaptionStep);
          onStep(data.recaptionStep, clip);
        }
        return { count: 1 };
      },
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
  const downloaded: string[] = [];
  const store: ClipStore = {
    downloadTo: async (key, filePath) => {
      downloaded.push(key);
      await copyFile(path.join(bucket, key), filePath);
    },
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
  return { store, uploaded, removed, downloaded };
}

function renderingProject(overrides: Row = {}): Row {
  return {
    id: "p1",
    status: "rendering",
    renderId: "r1",
    renderPlan: null,
    highlights: null,
    transcript: null,
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
    sfxHook: null,
    sfxCaptions: null,
    sfxCuts: null,
    captionPosition: "bottom",
    captionUppercase: false,
    captionHighlight: "yellow",
    captionEmoji: false,
    crop: "centre",
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
    // Each clip and its kept cut.
    expect(bucket.uploaded).toHaveLength(4);
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
    expect(bucket.uploaded).toEqual(["clips/p1/c2.mp4", "clips/p1/c2.base.mp4"]);
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

describe("renderClipProject in two phases", () => {
  it("finds the highlights for review without making clips, then makes exactly the reviewed ones", async () => {
    const deps = fakeDb(renderingProject({ status: "picking" }));
    const bucket = bucketStore(root);
    deps.state.clips.push({ id: "old", storageKey: "clips/p1/old.mp4", name: "old", start: 0 });

    await renderClipProject({
      db: deps.db,
      store: bucket.store,
      projectId: "p1",
      renderId: "r1",
      workDir: await mkdtemp(path.join(workRoot, "run-")),
    });

    expect(deps.state.steps).toEqual(["Downloading the video", "Analysing motion and sound"]);
    expect(deps.state.project).toMatchObject({ status: "review", renderStep: null, durationSeconds: 40, renderPlan: null });
    const picked = deps.state.project.highlights as { start: number; length: number }[];
    expect(picked).toHaveLength(2);
    expect(validateHighlights(picked, 40)).toEqual(picked);
    // Nothing is made or replaced until "Make clips".
    expect(bucket.uploaded).toEqual([]);
    expect(bucket.removed).toEqual([]);
    expect(deps.state.clips.map((clip) => clip.id)).toEqual(["old"]);

    // Adjusted on the timeline, by half seconds.
    const reviewed = [
      { start: 2.5, length: 15.5 },
      { start: 21, length: 16 },
    ];
    Object.assign(deps.state.project, { status: "rendering", renderId: "r2", highlights: reviewed });
    deps.state.steps = [];
    await renderClipProject({
      db: deps.db,
      store: bucket.store,
      projectId: "p1",
      renderId: "r2",
      workDir: await mkdtemp(path.join(workRoot, "run-")),
    });

    // The video is not analysed again.
    expect(deps.state.steps).toEqual(["Downloading the video", "Making clip 1 of 2", "Making clip 2 of 2"]);
    expect(bucket.removed).toEqual(["clips/p1/old.mp4"]);
    expect(deps.state.clips.map(({ start, length }) => ({ start, length }))).toEqual(reviewed);
    expect(deps.state.project).toMatchObject({ status: "done", renderStep: null, highlights: reviewed });
    expect(deps.state.project.renderPlan).toEqual({
      renderId: "r2",
      clips: deps.state.clips.map(({ id, start, length }) => ({ clipId: id, start, length })),
    });
    for (const [index, clip] of deps.state.clips.entries()) {
      const duration = await probeDuration(path.join(root, String(clip.storageKey)));
      expect(duration).toBeGreaterThan(reviewed[index].length - 0.2);
      expect(duration).toBeLessThan(reviewed[index].length + 0.2);
    }
  });

  it("captions reviewed clips from the stored words, without transcribing again", async () => {
    const transcript = [
      { text: "hello", startMs: 3000, endMs: 3600 },
      { text: "world", startMs: 3600, endMs: 4200 },
    ];
    const previous = process.env.WHISPER_MODEL;
    // Transcribing would need the whisper model.
    delete process.env.WHISPER_MODEL;
    try {
      const deps = fakeDb(
        renderingProject({
          withCaptions: true,
          captionPreset: "classic",
          durationSeconds: 40,
          transcript,
          highlights: [{ start: 2, length: 15 }],
        }),
      );
      await renderClipProject({
        db: deps.db,
        store: bucketStore(root).store,
        projectId: "p1",
        renderId: "r1",
        workDir: await mkdtemp(path.join(workRoot, "run-")),
      });

      expect(deps.state.steps).toEqual(["Downloading the video", "Drawing captions", "Making clip 1 of 1"]);
      expect(deps.state.project).toMatchObject({ status: "done", transcript });
    } finally {
      if (previous !== undefined) process.env.WHISPER_MODEL = previous;
    }
  });

  it("refuses reviewed highlights that do not fit the video", async () => {
    const deps = fakeDb(renderingProject({ durationSeconds: 40, highlights: [{ start: 30, length: 15 }] }));

    await expect(
      renderClipProject({
        db: deps.db,
        store: bucketStore(root).store,
        projectId: "p1",
        renderId: "r1",
        workDir: await mkdtemp(path.join(workRoot, "run-")),
      }),
    ).rejects.toThrow("within the 40s video");
    expect(deps.state.project).toMatchObject({ status: "failed" });
    expect(deps.state.clips).toEqual([]);
  });

  it("stops finding highlights once cancelled, leaving none to review", async () => {
    const deps = fakeDb(renderingProject({ status: "picking" }), (step, project) => {
      if (step === "Analysing motion and sound") Object.assign(project, { status: "ready", renderStep: "Cancelled", renderId: null });
    });

    await renderClipProject({
      db: deps.db,
      store: bucketStore(root).store,
      projectId: "p1",
      renderId: "r1",
      workDir: await mkdtemp(path.join(workRoot, "run-")),
    });

    expect(deps.state.project).toMatchObject({ status: "ready", renderStep: "Cancelled", highlights: null });
  });
});

describe("recaptionClip", () => {
  const transcript = [
    { text: "hello", startMs: 3000, endMs: 3600 },
    { text: "world", startMs: 3600, endMs: 4200 },
  ];

  // A captioned project with one clip made from 2 s to 17 s.
  async function captionedClip(onStep?: (step: string, row: Row) => void, overrides: Row = {}) {
    const deps = fakeDb(
      renderingProject({
        ...overrides,
        withCaptions: true,
        captionPreset: "box",
        durationSeconds: 40,
        transcript,
        highlights: [{ start: 2, length: 15 }],
        progressBar: "cyan",
      }),
      onStep,
    );
    const bucket = bucketStore(root);
    await renderClipProject({
      db: deps.db,
      store: bucket.store,
      projectId: "p1",
      renderId: "r1",
      workDir: await mkdtemp(path.join(workRoot, "run-")),
    });
    deps.state.steps = [];
    return { deps, bucket, clip: deps.state.clips[0] };
  }

  it("keeps a captioned clip's words and its cut without captions", async () => {
    const { clip, bucket } = await captionedClip();

    expect(clip.words).toEqual([
      { text: "hello", startMs: 1000, endMs: 1600, lineStart: true },
      { text: "world", startMs: 1600, endMs: 2200 },
    ]);
    expect(clip.baseKey).toBe(`clips/p1/${clip.id}.base.mp4`);
    expect(bucket.uploaded).toEqual([`clips/p1/${clip.id}.mp4`, `clips/p1/${clip.id}.base.mp4`]);
    const duration = await probeDuration(path.join(root, String(clip.baseKey)));
    expect(Math.abs(duration - 15)).toBeLessThan(0.2);
  });

  it("draws the edited words over the kept cut and replaces the clip with the next version", async () => {
    const { deps, bucket, clip } = await captionedClip();
    const before = path.join(workRoot, `${clip.id}-before.mp4`);
    await copyFile(path.join(root, String(clip.storageKey)), before);
    const edited = [{ text: "WWWWWWWWWW", startMs: 1000, endMs: 1600, lineStart: true }];
    Object.assign(clip, { version: 1, recaptionId: "x1", recaptionWords: edited, recaptionStep: null, recaptionError: null });
    bucket.downloaded.length = 0;

    await recaptionClip({ db: deps.db, store: bucket.store, clipId: String(clip.id), recaptionId: "x1", workDir: await mkdtemp(path.join(workRoot, "run-")) });

    // Only the kept cut is read: the source is not cut again.
    expect(bucket.downloaded).toEqual([`clips/p1/${clip.id}.base.mp4`]);
    expect(deps.state.steps).toEqual(["Downloading the clip", "Drawing captions", "Making the clip", "Saving"]);
    expect(clip).toMatchObject({
      storageKey: `clips/p1/${clip.id}.v2.mp4`,
      version: 2,
      words: edited,
      recaptionId: null,
      recaptionStep: null,
      recaptionWords: Prisma.DbNull,
      recaptionError: null,
    });
    expect(bucket.removed).toContain(`clips/p1/${clip.id}.mp4`);
    const after = path.join(root, String(clip.storageKey));
    expect(Math.abs((await probeDuration(after)) - (await probeDuration(before)))).toBeLessThan(0.1);
    // The caption shown at 1.3 s changed; after the captions, the picture is the same.
    expect(changedShare(grayRows(before, 1.3, 960, 960), grayRows(after, 1.3, 960, 960))).toBeGreaterThan(0.01);
    expect(changedShare(grayRows(before, 8, 0, 1900), grayRows(after, 8, 0, 1900))).toBeLessThan(0.005);
  });

  it("keeps the clip's crop in its kept cut, so captions drawn again show the same picture", async () => {
    const { deps, bucket, clip } = await captionedClip(undefined, { crop: "fit" });
    const base = path.join(root, String(clip.baseKey));
    // Fitted, the 16:9 source is a band across the middle with its blurred fill above it.
    const fill = grayRows(base, 8, 0, 300);
    const band = grayRows(base, 8, 860, 200);
    expect(changedShare(grayRows(path.join(root, String(clip.storageKey)), 8, 0, 300), fill)).toBeLessThan(0.005);
    expect(changedShare(fill, band)).toBeGreaterThan(0.05);
    const before = path.join(workRoot, `${clip.id}-fit-before.mp4`);
    await copyFile(path.join(root, String(clip.storageKey)), before);
    Object.assign(clip, { version: 1, recaptionId: "x1", recaptionWords: clip.words, recaptionStep: null, recaptionError: null });

    await recaptionClip({ db: deps.db, store: bucket.store, clipId: String(clip.id), recaptionId: "x1", workDir: await mkdtemp(path.join(workRoot, "run-")) });

    const after = path.join(root, String(clip.storageKey));
    expect(changedShare(grayRows(before, 8, 0, 1900), grayRows(after, 8, 0, 1900))).toBeLessThan(0.005);
  });

  it("replaces nothing once cancelled", async () => {
    let cancelAt = "";
    const { deps, bucket, clip } = await captionedClip((step, row) => {
      if (step === cancelAt) Object.assign(row, { recaptionId: null, recaptionStep: null, recaptionWords: null });
    });
    cancelAt = "Drawing captions";
    const storageKey = clip.storageKey;
    Object.assign(clip, { version: 1, recaptionId: "x1", recaptionWords: clip.words, recaptionStep: null });
    bucket.uploaded.length = 0;

    await recaptionClip({ db: deps.db, store: bucket.store, clipId: String(clip.id), recaptionId: "x1", workDir: await mkdtemp(path.join(workRoot, "run-")) });

    expect(clip).toMatchObject({ storageKey, version: 1, recaptionId: null });
    expect(bucket.uploaded).toEqual([]);
    // A job that starts after its re-render was cancelled does nothing.
    await recaptionClip({ db: deps.db, store: bucket.store, clipId: String(clip.id), recaptionId: "x1", workDir: workRoot });
    expect(deps.state.steps).toEqual(["Downloading the clip", "Drawing captions"]);
  });

  it("keeps a tightened clip's words in its tightened time and redraws them there, at the same length", async () => {
    // "um" is cut, and the long pause before "world" shrinks.
    const spoken = [
      { text: "hello", startMs: 3000, endMs: 3600 },
      { text: "um", startMs: 3600, endMs: 4000 },
      { text: "world", startMs: 6000, endMs: 6600 },
    ];
    const deps = fakeDb(
      renderingProject({
        withCaptions: true,
        tightenPacing: true,
        captionPreset: "box",
        durationSeconds: 40,
        transcript: spoken,
        highlights: [{ start: 2, length: 15 }],
      }),
    );
    const bucket = bucketStore(root);
    await renderClipProject({
      db: deps.db,
      store: bucket.store,
      projectId: "p1",
      renderId: "r1",
      workDir: await mkdtemp(path.join(workRoot, "run-")),
    });
    const [clip] = deps.state.clips;
    const cut = tightenClip(spoken, 2, 15);
    expect(clip.length).toBe(cut.length);
    expect(cut.length).toBeLessThan(2);
    expect((clip.words as { text: string }[]).map((word) => word.text)).toEqual(["hello", "world"]);
    const world = cut.words.find((word: { text: string }) => word.text === "world")!;
    expect((clip.words as { startMs: number; endMs: number }[])[1]).toMatchObject({ startMs: world.startMs, endMs: world.endMs });
    // The kept cut is the tightened clip without captions.
    expect(Math.abs((await probeDuration(path.join(root, String(clip.baseKey)))) - cut.length)).toBeLessThan(0.1);

    const before = path.join(workRoot, `${clip.id}-tight-before.mp4`);
    await copyFile(path.join(root, String(clip.storageKey)), before);
    // Once the pause is shortened, "world" joins "hello" on one line, as the render drew it.
    expect(clip.words).toEqual([
      { text: "hello", startMs: cut.words[0].startMs, endMs: cut.words[0].endMs, lineStart: true },
      { text: "world", startMs: world.startMs, endMs: world.endMs },
    ]);
    const edited = [(clip.words as object[])[0], { text: "WWWWWWWWWW", startMs: world.startMs, endMs: world.endMs }];
    Object.assign(clip, { version: 1, recaptionId: "x1", recaptionWords: edited, recaptionStep: null, recaptionError: null });

    await recaptionClip({ db: deps.db, store: bucket.store, clipId: String(clip.id), recaptionId: "x1", workDir: await mkdtemp(path.join(workRoot, "run-")) });

    expect(clip).toMatchObject({ version: 2, words: edited, length: cut.length });
    const after = path.join(root, String(clip.storageKey));
    expect(Math.abs((await probeDuration(after)) - cut.length)).toBeLessThan(0.1);
    // The edited word shows where "world" landed once tightened; before the first word, the picture is the same.
    const worldAt = (world.startMs + world.endMs) / 2000;
    expect(changedShare(grayRows(before, worldAt, 960, 960), grayRows(after, worldAt, 960, 960))).toBeGreaterThan(0.01);
    const earlyAt = cut.words[0].startMs / 2000;
    expect(earlyAt).toBeGreaterThan(0.05);
    expect(changedShare(grayRows(before, earlyAt, 0, 1900), grayRows(after, earlyAt, 0, 1900))).toBeLessThan(0.005);
  });

  it("leaves no caption bundle behind after a render, a re-render or a failed re-render", async () => {
    const previous = process.env.TMPDIR;
    // A temp folder of its own, so other renders running at the same time do not count.
    process.env.TMPDIR = await mkdtemp(path.join(workRoot, "tmpdir-"));
    const bundles = async () => (await readdir(os.tmpdir())).filter((name) => name.startsWith("remotion-webpack-bundle-"));
    try {
      const before = await bundles();
      const { deps, bucket, clip } = await captionedClip();
      expect(await bundles()).toEqual(before);

      Object.assign(clip, { version: 1, recaptionId: "x1", recaptionWords: clip.words, recaptionStep: null });
      await recaptionClip({ db: deps.db, store: bucket.store, clipId: String(clip.id), recaptionId: "x1", workDir: await mkdtemp(path.join(workRoot, "run-")) });
      expect(clip.version).toBe(2);
      expect(await bundles()).toEqual(before);

      // Fails while drawing, with the bundle built.
      deps.state.project.captionPreset = "nope";
      Object.assign(clip, { recaptionId: "x2", recaptionWords: clip.words });
      await expect(
        recaptionClip({ db: deps.db, store: bucket.store, clipId: String(clip.id), recaptionId: "x2", workDir: await mkdtemp(path.join(workRoot, "run-")) }),
      ).rejects.toThrow();
      expect(await bundles()).toEqual(before);
    } finally {
      if (previous === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous;
    }
  });

  it("records why a re-render failed and clears it", async () => {
    const { deps, bucket, clip } = await captionedClip();
    Object.assign(clip, { version: 1, recaptionId: "x1", recaptionWords: clip.words, baseKey: "clips/p1/missing.base.mp4" });

    await expect(
      recaptionClip({ db: deps.db, store: bucket.store, clipId: String(clip.id), recaptionId: "x1", workDir: await mkdtemp(path.join(workRoot, "run-")) }),
    ).rejects.toThrow();
    expect(clip).toMatchObject({ recaptionId: null, recaptionStep: null, version: 1 });
    expect(String(clip.recaptionError)).not.toBe("");
  });
});

describe("sound effects", () => {
  const transcript = [
    { text: "hello", startMs: 3000, endMs: 3600 },
    { text: "world", startMs: 3600, endMs: 4200 },
  ];

  async function render(project: Row) {
    const deps = fakeDb(renderingProject({ durationSeconds: 40, highlights: [{ start: 2, length: 15 }], ...project }));
    const bucket = bucketStore(root);
    await renderClipProject({ db: deps.db, store: bucket.store, projectId: "p1", renderId: "r1", workDir: await mkdtemp(path.join(workRoot, "run-")) });
    deps.state.steps = [];
    return { deps, bucket, clip: deps.state.clips[0] };
  }

  // How much louder the sound's tone is in the clip than in its kept cut, which has no sounds, from seconds on.
  function louder(clip: Row, sound: keyof typeof SOUND_TONES, seconds: number) {
    const from = seconds + 0.03;
    const to = seconds + 0.2;
    const tone = SOUND_TONES[sound];
    return bandLevel(path.join(root, String(clip.storageKey)), tone, from, to) - bandLevel(path.join(root, String(clip.baseKey)), tone, from, to);
  }

  it("whooshes as the hook title shows and pops as each caption line shows, at the same length", async () => {
    const { clip } = await render({
      withCaptions: true,
      captionPreset: "box",
      transcript,
      hookMode: "text",
      hookText: "Wait for it",
      sfxHook: "kenney-weapon-change",
      sfxCaptions: "kenney-placement",
    });
    // The one caption line starts 1 s in: "hello" at 3 s of a clip from 2 s.
    const whoosh = louder(clip, "kenney-weapon-change", 0);
    const pop = louder(clip, "kenney-placement", 1);
    expect(whoosh).toBeGreaterThan(20);
    expect(pop).toBeGreaterThan(20);
    // Not at other times: the pop is not at 0 s (where only the whoosh's edges reach its pitch), the whoosh not at 5 s.
    expect(pop - louder(clip, "kenney-placement", 0)).toBeGreaterThan(10);
    expect(whoosh - louder(clip, "kenney-weapon-change", 5)).toBeGreaterThan(10);
    const length = await probeDuration(path.join(root, String(clip.storageKey)));
    expect(Math.abs(length - (await probeDuration(path.join(root, String(clip.baseKey)))))).toBeLessThan(0.1);
  });

  it("ticks at a tightened clip's jump cuts, and keeps them for drawing it again", async () => {
    const spoken = [
      { text: "hello", startMs: 3000, endMs: 3600 },
      { text: "um", startMs: 3600, endMs: 4000 },
      { text: "world", startMs: 6000, endMs: 6600 },
    ];
    const { deps, bucket, clip } = await render({ tightenPacing: true, transcript: spoken, sfxCuts: "kenney-tile-swap" });
    const cuts = cutTimes(tightenClip(spoken, 2, 15).keep);
    expect(cuts.length).toBeGreaterThan(0);
    expect(clip.cuts).toEqual(cuts);
    expect(louder(clip, "kenney-tile-swap", cuts[0])).toBeGreaterThan(20);

    // Drawn again with a sound of its own, the ticks stay where the cuts are.
    Object.assign(clip, { version: 1, recaptionId: "x1", recaptionSounds: [{ time: 0.1, sound: "kenney-coin", volume: 100 }] });
    await recaptionClip({ db: deps.db, store: bucket.store, clipId: String(clip.id), recaptionId: "x1", workDir: await mkdtemp(path.join(workRoot, "run-")) });
    expect(clip.version).toBe(2);
    expect(louder(clip, "kenney-tile-swap", cuts[0])).toBeGreaterThan(20);
    expect(louder(clip, "kenney-coin", 0.1)).toBeGreaterThan(20);
  });

  it("re-renders a clip without captions with its own sounds over its kept cut", async () => {
    const { deps, bucket, clip } = await render({});
    expect(clip.words).toBe(Prisma.DbNull);
    expect(clip.baseKey).toBe(`clips/p1/${clip.id}.base.mp4`);
    const sounds = [{ time: 5, sound: "kenney-coin", volume: 100 }];
    Object.assign(clip, { version: 1, recaptionId: "x1", recaptionSounds: sounds, recaptionStep: null, recaptionError: null });
    bucket.downloaded.length = 0;

    await recaptionClip({ db: deps.db, store: bucket.store, clipId: String(clip.id), recaptionId: "x1", workDir: await mkdtemp(path.join(workRoot, "run-")) });

    expect(bucket.downloaded).toEqual([`clips/p1/${clip.id}.base.mp4`]);
    expect(deps.state.steps).toEqual(["Downloading the clip", "Making the clip", "Saving"]);
    expect(clip).toMatchObject({
      storageKey: `clips/p1/${clip.id}.v2.mp4`,
      version: 2,
      sounds,
      words: Prisma.DbNull,
      recaptionId: null,
      recaptionSounds: Prisma.DbNull,
      recaptionError: null,
    });
    const coin = louder(clip, "kenney-coin", 5);
    expect(coin).toBeGreaterThan(20);
    expect(coin - louder(clip, "kenney-coin", 2)).toBeGreaterThan(10);
    const length = await probeDuration(path.join(root, String(clip.storageKey)));
    expect(Math.abs(length - (await probeDuration(path.join(root, String(clip.baseKey)))))).toBeLessThan(0.1);
  });

  it("keeps a clip's own sounds when its captions are drawn again", async () => {
    const sounds = [{ time: 6, sound: "kenney-coin", volume: 80 }];
    const { deps, bucket, clip } = await render({ withCaptions: true, captionPreset: "box", transcript });
    const edited = [{ text: "WWWW", startMs: 1000, endMs: 1600, lineStart: true }];
    Object.assign(clip, { version: 1, sounds, recaptionId: "x1", recaptionWords: edited });

    await recaptionClip({ db: deps.db, store: bucket.store, clipId: String(clip.id), recaptionId: "x1", workDir: await mkdtemp(path.join(workRoot, "run-")) });

    expect(clip).toMatchObject({ version: 2, words: edited, sounds });
    expect(louder(clip, "kenney-coin", 6)).toBeGreaterThan(20);
  });
});

// The mean level (dB) of one frequency band of file between from and to seconds.
function bandLevel(file: string, frequency: number, from: number, to: number) {
  const band = `bandpass=f=${frequency}:width_type=h:w=40`;
  const result = spawnSync(
    "ffmpeg",
    ["-v", "info", "-ss", String(from), "-t", String(to - from), "-i", file, "-af", `${band},${band},${band},volumedetect`, "-f", "null", "-"],
    { encoding: "utf8" },
  );
  const match = /mean_volume: (-?[\d.]+) dB/.exec(result.stderr);
  if (!match) throw new Error(`no level for ${file}: ${result.stderr.slice(-500)}`);
  return Number(match[1]);
}

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
