import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { createSlideshowScript, slideshowPhotoUpload, startSlideshowRender } from "./slideshow";

type Row = Record<string, unknown>;

function fakeDb({ engines = { script: "installed", picture: "installed" }, job = null as Row | null } = {}) {
  const state = { created: [] as Row[], updates: [] as Row[] };
  const db = {
    slideshowEngine: { findUnique: async ({ where }: { where: { id: string } }) => ({ id: where.id, status: (engines as Row)[where.id] }) },
    slideshowJob: {
      create: async ({ data }: { data: Row }) => (state.created.push(data), { id: "new-show", ...data }),
      findFirst: async ({ where }: { where: Row }) => (job && where.id === job.id && where.ownerId === job.ownerId ? job : null),
      update: async ({ data }: { data: Row }) => (state.updates.push(data), data),
    },
    clip: { findFirst: async ({ where }: { where: Row }) => (where.id === "clip-1" ? { id: "clip-1", length: 30 } : null) },
    clipProject: { findFirst: async ({ where }: { where: Row }) => (where.id === "project-1" ? { id: "project-1", durationSeconds: 600 } : null) },
  };
  return { db: db as unknown as PrismaClient, state };
}

const queue = (sent: string[][]) => ({ send: async (id: string, kind: string) => (sent.push([id, kind]), "pg-boss-id") });

describe("createSlideshowScript", () => {
  it("saves the topic and queues the script writer", async () => {
    const { db, state } = fakeDb();
    const sent: string[][] = [];
    await createSlideshowScript({ db, queue: queue(sent), ownerId: "owner-1", topic: "  Better sleep ", slideCount: 4 });
    expect(state.created).toEqual([{ ownerId: "owner-1", topic: "Better sleep", slideCount: 4, status: "writing", step: "Waiting for the worker" }]);
    expect(sent).toEqual([["new-show", "script"]]);
  });

  it("refuses an empty topic, another slide count, or a missing script writer", async () => {
    const { db } = fakeDb();
    const base = { db, queue: queue([]), ownerId: "owner-1", topic: "Sleep", slideCount: 5 };
    await expect(createSlideshowScript({ ...base, topic: " " })).rejects.toThrow("what the slideshow is about");
    await expect(createSlideshowScript({ ...base, slideCount: 11 })).rejects.toThrow("3 to 10 slides");
    const { db: none } = fakeDb({ engines: { script: "not_installed", picture: "installed" } });
    await expect(createSlideshowScript({ ...base, db: none })).rejects.toThrow("install the script writer first");
  });

  it("marks the slideshow failed when it cannot be queued", async () => {
    const { db, state } = fakeDb();
    const broken = { send: async () => Promise.reject(new Error("database is down")) };
    await expect(createSlideshowScript({ db, queue: broken, ownerId: "owner-1", topic: "Sleep", slideCount: 3 })).rejects.toThrow("database is down");
    expect(state.updates).toEqual([{ status: "failed", step: null, error: "database is down" }]);
  });
});

describe("startSlideshowRender", () => {
  const draft = { id: "show-1", ownerId: "owner-1", status: "draft", slideCount: 3, slides: [] };
  const slides = [
    { text: " One ", picture: "A", source: { kind: "ai" } },
    { text: "Two", picture: "B", source: { kind: "clip", clipId: "clip-1", at: 12.5 } },
    { text: "Three", picture: "C", source: { kind: "photo", key: "slideshow-inputs/0b0e5e5e-1111-4222-8333-944445555666.png" } },
  ];
  const base = (db: PrismaClient, sent: string[][] = []) => ({
    db,
    queue: queue(sent),
    ownerId: "owner-1",
    jobId: "show-1",
    slides,
    voice: "af_heart",
    captionPreset: "words",
  });

  it("saves the checked slides and queues the render", async () => {
    const { db, state } = fakeDb({ job: draft });
    const sent: string[][] = [];
    await startSlideshowRender(base(db, sent));
    expect(state.updates).toEqual([
      {
        slides: [
          { text: "One", picture: "A", source: { kind: "ai" } },
          { text: "Two", picture: "B", source: { kind: "clip", clipId: "clip-1", at: 12.5 } },
          slides[2],
        ],
        voice: "af_heart",
        captionPreset: "words",
        status: "queued",
        step: null,
        error: null,
      },
    ]);
    expect(sent).toEqual([["show-1", "render"]]);
  });

  it("refuses slides without a picture, someone else's clip, a moment past the end, a foreign key or a missing picture maker", async () => {
    const { db } = fakeDb({ job: draft });
    const withSource = (index: number, source: unknown) => slides.map((slide, at) => (at === index ? { ...slide, source } : slide));
    await expect(startSlideshowRender({ ...base(db), slides: withSource(0, null) })).rejects.toThrow("choose a picture for slide 1");
    await expect(startSlideshowRender({ ...base(db), slides: withSource(1, { kind: "clip", clipId: "other", at: 1 }) })).rejects.toThrow(
      "no longer exists",
    );
    await expect(startSlideshowRender({ ...base(db), slides: withSource(1, { kind: "clip", clipId: "clip-1", at: 31 }) })).rejects.toThrow(
      "outside the video",
    );
    await expect(startSlideshowRender({ ...base(db), slides: withSource(2, { kind: "photo", key: "clips/p/c.mp4" }) })).rejects.toThrow(
      "not valid",
    );
    await expect(startSlideshowRender({ ...base(db), slides: slides.slice(0, 2) })).rejects.toThrow("needs its 3 slides");
    await expect(startSlideshowRender({ ...base(db), voice: "robot" })).rejects.toThrow("one of the voices");
    await expect(startSlideshowRender({ ...base(db), captionPreset: "comic" })).rejects.toThrow("one of the caption styles");
    const { db: noPictures } = fakeDb({ job: draft, engines: { script: "installed", picture: "not_installed" } });
    await expect(startSlideshowRender(base(noPictures))).rejects.toThrow("install the picture maker first");
  });

  it("refuses a slideshow that is not a draft", async () => {
    const { db } = fakeDb({ job: { ...draft, status: "running" } });
    await expect(startSlideshowRender(base(db))).rejects.toThrow("not waiting to be made");
    const { db: other } = fakeDb({ job: { ...draft, ownerId: "someone-else" } });
    await expect(startSlideshowRender(base(other))).rejects.toThrow("no longer exists");
  });
});

describe("slideshowPhotoUpload", () => {
  it("gives a photo its own key and refuses other files", () => {
    expect(slideshowPhotoUpload(".JPG")).toMatchObject({ key: expect.stringMatching(/^slideshow-inputs\/[0-9a-f-]{36}\.jpg$/), contentType: "image/jpeg" });
    expect(() => slideshowPhotoUpload(".gif")).toThrow("PNG, JPEG or WebP");
  });
});
