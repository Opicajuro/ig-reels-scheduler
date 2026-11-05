import { describe, expect, it } from "vitest";
import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import type { ClipStore } from "./clip-store";
import {
  copyClip,
  copyClipsToProject,
  copyProject,
  createLinkProject,
  createUploadProject,
  deleteClip,
  deleteClips,
  deleteProject,
  deleteProjectSource,
  discardHighlights,
  markSourceUploaded,
  moveClipsToProject,
  renameClip,
  renameProject,
  scheduleClip,
  scheduleClips,
  setClipDetails,
  startRecaption,
  startResound,
  startRender,
} from "./clip-projects";
import { BASE_CUT_REMOVED, SOURCE_DELETED } from "./storage-messages";
import { UserError } from "./user-error";

type Row = Record<string, unknown> & { id: string };

// Enough of Prisma for these functions. Nested filters such as { project: { ownerId } } go through `relations`.
function fakeDb(
  seed: {
    projects?: Row[];
    clips?: Row[];
    accounts?: Row[];
    media?: Row[];
    posts?: Row[];
    clipLinks?: Row[];
    channels?: Row[];
    pages?: Row[];
    tiktoks?: Row[];
  } = {},
) {
  const tables: Record<string, Row[]> = {
    clipProject: seed.projects ?? [],
    clip: seed.clips ?? [],
    igAccount: seed.accounts ?? [],
    media: seed.media ?? [],
    post: seed.posts ?? [],
    clipLink: seed.clipLinks ?? [],
    ytAccount: seed.channels ?? [],
    ytPost: [],
    fbPage: seed.pages ?? [],
    fbPost: [],
    ttAccount: seed.tiktoks ?? [],
    ttPost: [],
    auditLog: [],
  };
  const relations: Record<string, Record<string, (row: Row) => Row | undefined>> = {
    clip: { project: (clip) => tables.clipProject.find((project) => project.id === clip.projectId) },
    media: { account: (media) => tables.igAccount.find((account) => account.id === media.accountId) },
    post: { media: (post) => tables.media.find((media) => media.id === post.mediaId) },
  };
  const relatedTable: Record<string, string> = { project: "clipProject", account: "igAccount", media: "media" };
  const matches = (table: string, row: Row, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([key, value]) => {
      if (value && typeof value === "object" && "in" in value) return (value.in as unknown[]).includes(row[key]);
      const relation = relations[table]?.[key];
      if (relation && value && typeof value === "object") {
        const related = relation(row);
        return related !== undefined && matches(relatedTable[key], related, value as Record<string, unknown>);
      }
      return row[key] === value;
    });
  // include: { clips } on a project, or { project } on a clip, as the real queries ask for them.
  const withIncludes = (table: string, row: Row | undefined, include?: Record<string, boolean>) => {
    if (!row) return null;
    const result = structuredClone(row) as Row;
    if (include?.clips) result.clips = structuredClone(tables.clip.filter((clip) => clip.projectId === row.id));
    if (include?.project) result.project = structuredClone(tables.clipProject.find((project) => project.id === row.projectId));
    return result;
  };
  const model = (table: string) => ({
    findFirst: async ({ where, include }: { where: Record<string, unknown>; include?: Record<string, boolean> }) =>
      withIncludes(table, tables[table].find((row) => matches(table, row, where)), include),
    findUnique: async ({ where }: { where: { id: string } }) =>
      structuredClone(tables[table].find((row) => row.id === where.id) ?? null),
    findMany: async ({ where = {}, include }: { where?: Record<string, unknown>; include?: Record<string, boolean> } = {}) =>
      tables[table].filter((row) => matches(table, row, where)).map((row) => withIncludes(table, row, include)),
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const row = { id: `${table}-${tables[table].length + 1}`, ...data } as Row;
      tables[table].push(row);
      return structuredClone(row);
    },
    update: async ({ where, data }: { where: { id: string }; data: Row }) => {
      const row = tables[table].find((item) => item.id === where.id);
      if (!row) throw new Error(`${table} ${where.id} not found`);
      Object.assign(row, data);
      return structuredClone(row);
    },
    delete: async ({ where }: { where: { id: string } }) => {
      const index = tables[table].findIndex((item) => item.id === where.id);
      if (index < 0) throw new Error(`${table} ${where.id} not found`);
      return tables[table].splice(index, 1)[0];
    },
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Row }) => {
      const rows = tables[table].filter((row) => matches(table, row, where));
      for (const row of rows) Object.assign(row, data);
      return { count: rows.length };
    },
    deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
      const kept = tables[table].filter((row) => !matches(table, row, where));
      const count = tables[table].length - kept.length;
      tables[table] = kept;
      return { count };
    },
  });
  const db = {
    clipProject: model("clipProject"),
    clip: model("clip"),
    igAccount: model("igAccount"),
    media: { ...model("media") },
    post: model("post"),
    ytAccount: model("ytAccount"),
    ytPost: model("ytPost"),
    fbPage: model("fbPage"),
    fbPost: model("fbPost"),
    ttAccount: model("ttAccount"),
    ttPost: model("ttPost"),
    auditLog: model("auditLog"),
  };
  // An interactive transaction: a throw inside it puts every table back as it was.
  const $transaction = async <T>(work: (tx: typeof db) => Promise<T>) => {
    const before = structuredClone(tables);
    try {
      return await work(db);
    } catch (err) {
      Object.assign(tables, before);
      throw err;
    }
  };
  return { db: { ...db, $transaction } as unknown as PrismaClient, tables };
}

function fakeStore() {
  const copies: Array<[string, string]> = [];
  const removed: string[] = [];
  const store: ClipStore = {
    downloadTo: async () => {},
    upload: async () => {},
    copy: async (from, to) => {
      copies.push([from, to]);
    },
    remove: async (key) => {
      removed.push(key);
    },
  };
  return { store, copies, removed };
}

const owned = { ownerId: "user-1" };

function project(overrides: Partial<Row> = {}): Row {
  return {
    id: "p1",
    ownerId: "user-1",
    name: "Grocery store challenge",
    status: "done",
    sourceKey: "clip-sources/p1.mp4",
    sourceUrl: null,
    error: null,
    durationSeconds: 60,
    clipSeconds: 15,
    clipCount: 2,
    withCaptions: false,
    captionPreset: null,
    crop: "follow",
    ...overrides,
  };
}

function clip(overrides: Partial<Row> = {}): Row {
  return {
    id: "c1",
    projectId: "p1",
    name: "clip-001",
    start: 5,
    length: 15,
    storageKey: "clips/p1/c1.mp4",
    title: "Wait for it",
    description: "Watch to the end",
    aiGenerated: false,
    ...overrides,
  };
}

describe("createUploadProject", () => {
  it("creates a project waiting for its upload, with the key the file goes to", async () => {
    const { db, tables } = fakeDb();
    const result = await createUploadProject({ db, ...owned, name: "Run", extension: ".MOV" });

    expect(result.contentType).toBe("video/quicktime");
    expect(result.sourceKey).toBe(`clip-sources/${result.projectId}.mov`);
    expect(tables.clipProject[0]).toMatchObject({ status: "awaiting_source", sourceKey: result.sourceKey });
  });

  it("refuses a file type it cannot process", async () => {
    const { db } = fakeDb();
    await expect(createUploadProject({ db, ...owned, name: "Run", extension: ".gif" })).rejects.toThrow(
      'unsupported video type ".gif"',
    );
  });
});

describe("markSourceUploaded and createLinkProject", () => {
  it("marks a waiting project ready once its file is in place", async () => {
    const { db, tables } = fakeDb({ projects: [project({ id: "p1", status: "awaiting_source" })] });
    await markSourceUploaded({ db, ...owned, projectId: "p1" });
    expect(tables.clipProject[0].status).toBe("ready");
  });

  it("creates a link project and rejects a link that is not http or https", async () => {
    const { db, tables } = fakeDb();
    await createLinkProject({ db, ...owned, name: "Talk", url: "https://example.com/talk" });
    expect(tables.clipProject[0]).toMatchObject({ status: "ready", sourceUrl: "https://example.com/talk" });
    await expect(createLinkProject({ db, ...owned, name: "Bad", url: "file:///etc/passwd" })).rejects.toThrow();
  });
});

describe("discardHighlights", () => {
  it("goes back to the clips, or to ready without any", async () => {
    const withClips = fakeDb({ projects: [project({ status: "review", highlights: [] })], clips: [clip()] });
    await discardHighlights({ db: withClips.db, ...owned, projectId: "p1" });
    expect(withClips.tables.clipProject[0]).toMatchObject({ status: "done", highlights: Prisma.DbNull });

    const empty = fakeDb({ projects: [project({ status: "review", highlights: [] })] });
    await discardHighlights({ db: empty.db, ...owned, projectId: "p1" });
    expect(empty.tables.clipProject[0].status).toBe("ready");

    await expect(discardHighlights({ db: empty.db, ...owned, projectId: "p1" })).rejects.toThrow("no highlights");
  });
});

describe("startRender", () => {
  it("stores the automatic sounds, off unless asked for, and refuses one that is not a sound effect", async () => {
    const { db, tables } = fakeDb({ projects: [project()] });
    const queue = { send: async () => "job-1" };
    const options = { db, queue, ...owned, projectId: "p1", clipSeconds: 30, clipCount: null, withCaptions: false };
    await startRender(options);
    expect(tables.clipProject[0]).toMatchObject({ sfxHook: null, sfxCaptions: null, sfxCuts: null });
    tables.clipProject[0].status = "done";
    await startRender({ ...options, sfxHook: "kenney-weapon-change", sfxCaptions: "kenney-placement", sfxCuts: null });
    expect(tables.clipProject[0]).toMatchObject({ sfxHook: "kenney-weapon-change", sfxCaptions: "kenney-placement", sfxCuts: null });
    tables.clipProject[0].status = "done";
    await expect(startRender({ ...options, sfxCuts: "km-tyrant" })).rejects.toThrow('unknown sound effect "km-tyrant"');
  });

  it("stores the crop, keeps the project's own when none is sent, and refuses an unknown one", async () => {
    const { db, tables } = fakeDb({ projects: [project({ crop: "centre" })] });
    const queue = { send: async () => "job-1" };
    const options = { db, queue, ...owned, projectId: "p1", clipSeconds: 30, clipCount: null, withCaptions: false };
    await startRender(options);
    expect(tables.clipProject[0].crop).toBe("centre");
    tables.clipProject[0].status = "done";
    await startRender({ ...options, crop: "fit" });
    expect(tables.clipProject[0].crop).toBe("fit");
    tables.clipProject[0].status = "done";
    await expect(startRender({ ...options, crop: "left" })).rejects.toThrow("crop must be one of centre, follow, fit");
  });

  it("stores the options, marks the project rendering, and queues it", async () => {
    const { db, tables } = fakeDb({ projects: [project()] });
    const queued: string[] = [];
    await startRender({
      db,
      queue: { send: async (id, renderId) => (queued.push(`${id}:${renderId}`), "job-1") },
      ...owned,
      projectId: "p1",
      clipSeconds: 30,
      clipCount: 4,
      withCaptions: true,
      captionPreset: "yellow",
      captionPosition: "bottom",
    });

    expect(tables.clipProject[0]).toMatchObject({
      status: "rendering",
      clipSeconds: 30,
      clipCount: 4,
      withCaptions: true,
      captionPreset: "yellow",
    });
    // Each "Make clips" is a new render, so it starts over rather than resuming an interrupted one.
    const { renderId } = tables.clipProject[0];
    expect(renderId).toMatch(/^[0-9a-f-]{36}$/);
    expect(queued).toEqual([`p1:${renderId}`]);
  });

  it("stores Auto as no count, so the worker picks one from the video's length", async () => {
    const { db, tables } = fakeDb({ projects: [project()] });
    await startRender({
      db,
      queue: { send: async () => "job-1" },
      ...owned,
      projectId: "p1",
      clipSeconds: 30,
      clipCount: null,
      withCaptions: false,
    });
    expect(tables.clipProject[0]).toMatchObject({ status: "rendering", clipCount: null });
  });

  it("stores the caption position and the all-capitals choice with the look", async () => {
    const { db, tables } = fakeDb({ projects: [project()] });
    await startRender({
      db,
      queue: { send: async () => "job-1" },
      ...owned,
      projectId: "p1",
      clipSeconds: 30,
      clipCount: 2,
      withCaptions: true,
      captionPreset: "box",
      captionPosition: "top",
      captionUppercase: true,
    });
    expect(tables.clipProject[0]).toMatchObject({ captionPreset: "box", captionPosition: "top", captionUppercase: true });
  });

  it("stores the background music and its volume, none by default", async () => {
    const { db, tables } = fakeDb({ projects: [project()] });
    const start = (music: { musicTrack?: string; musicVolume?: string }) =>
      startRender({ db, queue: { send: async () => "job-1" }, ...owned, projectId: "p1", clipSeconds: 30, clipCount: 2, withCaptions: false, ...music });
    await start({});
    expect(tables.clipProject[0]).toMatchObject({ musicTrack: null, musicVolume: 15 });
    tables.clipProject[0].status = "done";
    await start({ musicTrack: "oga-cathedral-forest", musicVolume: "30" });
    expect(tables.clipProject[0]).toMatchObject({ musicTrack: "oga-cathedral-forest", musicVolume: 30 });
    tables.clipProject[0].status = "done";
    await expect(start({ musicTrack: "kenney-coin", musicVolume: "30" })).rejects.toThrow("unknown music track");
  });

  it("keeps the look clips have always had unless the new options are chosen", async () => {
    const { db, tables } = fakeDb({ projects: [project()] });
    await startRender({
      db,
      queue: { send: async () => "job-1" },
      ...owned,
      projectId: "p1",
      clipSeconds: 30,
      clipCount: 2,
      withCaptions: true,
      captionPreset: "words",
      captionPosition: "bottom",
    });
    expect(tables.clipProject[0]).toMatchObject({
      captionFont: "default",
      captionHighlight: "yellow",
      captionEmoji: false,
      hookMode: "off",
      hookText: null,
      progressBar: null,
      endCardText: null,
    });
  });

  it("stores the font, highlight, emoji, hook, progress bar and end card", async () => {
    const { db, tables } = fakeDb({ projects: [project()] });
    await startRender({
      db,
      queue: { send: async () => "job-1" },
      ...owned,
      projectId: "p1",
      clipSeconds: 30,
      clipCount: 2,
      withCaptions: true,
      captionPreset: "words",
      captionPosition: "bottom",
      captionFont: "bebas",
      captionHighlight: "pink",
      captionEmoji: true,
      hookMode: "text",
      hookText: " Wait for it ",
      progressBar: "cyan",
      endCardText: "@myhandle",
    });
    expect(tables.clipProject[0]).toMatchObject({
      captionFont: "bebas",
      captionHighlight: "pink",
      captionEmoji: true,
      hookMode: "text",
      hookText: "Wait for it",
      progressBar: "cyan",
      endCardText: "@myhandle",
    });
  });

  it("rejects a text hook without text and an unknown font, before queueing", async () => {
    const { db, tables } = fakeDb({ projects: [project()] });
    const queued: string[] = [];
    const base = {
      db,
      queue: { send: async (id: string) => (queued.push(id), "job-1") },
      ...owned,
      projectId: "p1",
      clipSeconds: 30,
      clipCount: 2,
      withCaptions: false,
    };
    await expect(startRender({ ...base, hookMode: "text", hookText: "  " })).rejects.toThrow(UserError);
    await expect(startRender({ ...base, captionFont: "comic" })).rejects.toThrow(UserError);
    expect(queued).toEqual([]);
    expect(tables.clipProject[0].status).toBe("done");
  });

  it("only finds the highlights with review on, dropping the ones reviewed before", async () => {
    const { db, tables } = fakeDb({ projects: [project({ status: "review", highlights: [{ start: 0, length: 15 }] })] });
    const queued: string[] = [];
    await startRender({
      db,
      queue: { send: async (id, renderId) => (queued.push(`${id}:${renderId}`), "job-1") },
      ...owned,
      projectId: "p1",
      review: true,
      clipSeconds: 30,
      clipCount: null,
      withCaptions: false,
    });
    expect(tables.clipProject[0]).toMatchObject({ status: "picking", highlights: Prisma.DbNull, clipSeconds: 30 });
    expect(queued).toEqual([`p1:${tables.clipProject[0].renderId}`]);
  });

  it("makes clips from the reviewed highlights, in time order", async () => {
    const { db, tables } = fakeDb({ projects: [project({ status: "review", highlights: [{ start: 0, length: 15 }] })] });
    const queued: string[] = [];
    await startRender({
      db,
      queue: { send: async (id) => (queued.push(id), "job-1") },
      ...owned,
      projectId: "p1",
      highlights: JSON.stringify([
        { start: 40.5, length: 19.5 },
        { start: 2, length: 15.5 },
      ]),
      clipSeconds: 15,
      clipCount: 2,
      withCaptions: false,
    });
    expect(tables.clipProject[0]).toMatchObject({
      status: "rendering",
      highlights: [
        { start: 2, length: 15.5 },
        { start: 40.5, length: 19.5 },
      ],
    });
    expect(queued).toEqual(["p1"]);
  });

  it("refuses reviewed highlights that overlap or leave the video, or when none are being reviewed", async () => {
    const queued: string[] = [];
    const base = {
      queue: { send: async (id: string) => (queued.push(id), "job-1") },
      ...owned,
      projectId: "p1",
      clipSeconds: 15,
      clipCount: 2,
      withCaptions: false,
    };
    const reviewing = fakeDb({ projects: [project({ status: "review" })] });
    const overlapping = JSON.stringify([
      { start: 0, length: 20 },
      { start: 19, length: 20 },
    ]);
    await expect(startRender({ ...base, db: reviewing.db, highlights: overlapping })).rejects.toThrow("overlap");
    await expect(startRender({ ...base, db: reviewing.db, highlights: JSON.stringify([{ start: 50, length: 15 }]) })).rejects.toThrow(
      "within the 60s video",
    );
    expect(reviewing.tables.clipProject[0].status).toBe("review");

    const done = fakeDb({ projects: [project()] });
    await expect(startRender({ ...base, db: done.db, highlights: JSON.stringify([{ start: 0, length: 15 }]) })).rejects.toThrow(
      "no longer being reviewed",
    );
    const picking = fakeDb({ projects: [project({ status: "picking" })] });
    await expect(startRender({ ...base, db: picking.db })).rejects.toThrow("still being found");
    expect(queued).toEqual([]);
  });

  it("refuses a project that is still waiting for its upload or is already rendering", async () => {
    const waiting = fakeDb({ projects: [project({ status: "awaiting_source" })] });
    await expect(
      startRender({ db: waiting.db, queue: { send: async () => "x" }, ...owned, projectId: "p1", clipSeconds: 30, clipCount: 2, withCaptions: false }),
    ).rejects.toThrow("upload the video before making clips");

    const busy = fakeDb({ projects: [project({ status: "rendering" })] });
    await expect(
      startRender({ db: busy.db, queue: { send: async () => "x" }, ...owned, projectId: "p1", clipSeconds: 30, clipCount: 2, withCaptions: false }),
    ).rejects.toThrow("already rendering");
  });

  it("rejects a clip count outside 1 to 10 and a clip length outside the allowed range", async () => {
    const { db } = fakeDb({ projects: [project()] });
    const queue = { send: async () => "x" };
    await expect(startRender({ db, queue, ...owned, projectId: "p1", clipSeconds: 30, clipCount: 11, withCaptions: false })).rejects.toThrow(
      "clipCount must be a whole number from 1 to 10",
    );
    await expect(startRender({ db, queue, ...owned, projectId: "p1", clipSeconds: 5, clipCount: 2, withCaptions: false })).rejects.toThrow();
  });

  it("marks the project failed if the job cannot be queued", async () => {
    const { db, tables } = fakeDb({ projects: [project()] });
    await expect(
      startRender({
        db,
        queue: { send: async () => { throw new Error("database down"); } },
        ...owned,
        projectId: "p1",
        clipSeconds: 30,
        clipCount: 2,
        withCaptions: false,
      }),
    ).rejects.toThrow("database down");
    expect(tables.clipProject[0]).toMatchObject({ status: "failed", error: "database down" });
  });

  it("does not let another user start a project", async () => {
    const { db } = fakeDb({ projects: [project()] });
    await expect(
      startRender({ db, queue: { send: async () => "x" }, ownerId: "user-2", projectId: "p1", clipSeconds: 30, clipCount: 2, withCaptions: false }),
    ).rejects.toThrow("project not found");
  });
});

describe("renaming and details", () => {
  it("renames a project and a clip, and saves a clip's title and description", async () => {
    const { db, tables } = fakeDb({ projects: [project()], clips: [clip()] });
    await renameProject({ db, ...owned, projectId: "p1", name: "  Grocery run  " });
    await renameClip({ db, ...owned, clipId: "c1", name: "Best moment" });
    await setClipDetails({ db, ...owned, clipId: "c1", title: " New title ", description: "Text #shorts" });

    expect(tables.clipProject[0].name).toBe("Grocery run");
    expect(tables.clip[0]).toMatchObject({ name: "Best moment", title: "New title", description: "Text #shorts" });
  });

  it("rejects an empty clip title", async () => {
    const { db } = fakeDb({ projects: [project()], clips: [clip()] });
    await expect(setClipDetails({ db, ...owned, clipId: "c1", title: " ", description: "" })).rejects.toThrow();
  });
});

describe("deleteProject", () => {
  it("removes the source and every clip file, then the project", async () => {
    const { db, tables } = fakeDb({ projects: [project()], clips: [clip({ id: "c1" }), clip({ id: "c2", storageKey: "clips/p1/c2.mp4" })] });
    const files = fakeStore();
    await deleteProject({ db, store: files.store, ...owned, projectId: "p1" });

    expect(files.removed).toEqual(["clip-sources/p1.mp4", "clips/p1/c1.mp4", "clips/p1/c2.mp4"]);
    expect(tables.clipProject).toEqual([]);
  });

  it("refuses while the project is rendering", async () => {
    const { db, tables } = fakeDb({ projects: [project({ status: "rendering" })] });
    await expect(deleteProject({ db, store: fakeStore().store, ...owned, projectId: "p1" })).rejects.toThrow("rendering");
    expect(tables.clipProject).toHaveLength(1);
  });
});

describe("copyProject and clip operations", () => {
  it("copies the source and every clip into a new project with new keys", async () => {
    const { db, tables } = fakeDb({ projects: [project()], clips: [clip()] });
    const files = fakeStore();
    const copy = await copyProject({ db, store: files.store, ...owned, projectId: "p1" });

    expect(copy.name).toBe("Grocery store challenge copy");
    expect(files.copies[0]).toEqual(["clip-sources/p1.mp4", `clip-sources/${copy.id}.mp4`]);
    const copiedClip = tables.clip.find((row) => row.projectId === copy.id);
    expect(copiedClip).toMatchObject({ name: "clip-001", title: "Wait for it" });
    expect(String(copiedClip?.storageKey)).toMatch(new RegExp(`^clips/${copy.id}/`));
  });

  it("copies one clip under a new key with a copy name", async () => {
    const { db, tables } = fakeDb({ projects: [project()], clips: [clip()] });
    const files = fakeStore();
    await copyClip({ db, store: files.store, ...owned, clipId: "c1" });

    expect(files.copies).toHaveLength(1);
    expect(tables.clip.map((row) => row.name)).toEqual(["clip-001", "clip-001 copy"]);
  });

  it("deletes one clip's file and row, and refuses while rendering", async () => {
    const { db, tables } = fakeDb({ projects: [project()], clips: [clip()] });
    const files = fakeStore();
    await deleteClip({ db, store: files.store, ...owned, clipId: "c1" });
    expect(files.removed).toEqual(["clips/p1/c1.mp4"]);
    expect(tables.clip).toEqual([]);

    const busy = fakeDb({ projects: [project({ status: "rendering" })], clips: [clip()] });
    await expect(deleteClip({ db: busy.db, store: fakeStore().store, ...owned, clipId: "c1" })).rejects.toThrow("rendering");
  });
});

describe("deleteClips", () => {
  const threeClips = () => [
    clip({ id: "c1" }),
    clip({ id: "c2", name: "clip-002", storageKey: "clips/p1/c2.mp4" }),
    clip({ id: "c3", storageKey: "clips/p1/c3.mp4" }),
  ];

  it("removes the files, then the rows, of every clip picked", async () => {
    const { db, tables } = fakeDb({ projects: [project()], clips: threeClips() });
    const files = fakeStore();
    const count = await deleteClips({ db, store: files.store, ...owned, clipIds: ["c1", "c2", "c1"] });

    expect(count).toBe(2);
    expect(files.removed).toEqual(["clips/p1/c1.mp4", "clips/p1/c2.mp4"]);
    expect(tables.clip.map((row) => row.id)).toEqual(["c3"]);
  });

  it("removes nothing while a project is rendering", async () => {
    const { db, tables } = fakeDb({ projects: [project({ status: "rendering" })], clips: threeClips() });
    const files = fakeStore();
    await expect(deleteClips({ db, store: files.store, ...owned, clipIds: ["c1", "c2"] })).rejects.toThrow("rendering");
    expect(files.removed).toEqual([]);
    expect(tables.clip).toHaveLength(3);
  });

  it("removes nothing when a clip is unknown or someone else's, or none is picked", async () => {
    const { db, tables } = fakeDb({
      projects: [project(), project({ id: "p2", ownerId: "user-2" })],
      clips: [clip({ id: "c1" }), clip({ id: "theirs", projectId: "p2", storageKey: "clips/p2/theirs.mp4" })],
    });
    const files = fakeStore();
    await expect(deleteClips({ db, store: files.store, ...owned, clipIds: ["c1", "theirs"] })).rejects.toThrow("clip not found");
    await expect(deleteClips({ db, store: files.store, ...owned, clipIds: ["c1", "nope"] })).rejects.toThrow("clip not found");
    await expect(deleteClips({ db, store: files.store, ...owned, clipIds: [] })).rejects.toThrow("select at least one clip");
    expect(files.removed).toEqual([]);
    expect(tables.clip).toHaveLength(2);
  });
});

describe("moveClipsToProject and copyClipsToProject", () => {
  const seed = () => ({
    projects: [project(), project({ id: "p2", name: "Beach day" })],
    clips: [
      clip({ id: "c1" }),
      clip({ id: "c2", name: "clip-002", storageKey: "clips/p1/c2.mp4", aiGenerated: true }),
      clip({ id: "t1", projectId: "p2", name: "clip-001", storageKey: "clips/p2/t1.mp4" }),
      clip({ id: "t2", projectId: "p2", name: "clip-001 (2)", storageKey: "clips/p2/t2.mp4" }),
    ],
  });

  it("moves each clip's file to a key under the other project, then the row, then removes the old file", async () => {
    const { db, tables } = fakeDb(seed());
    const files = fakeStore();
    const moved = await moveClipsToProject({ db, store: files.store, ...owned, clipIds: ["c1", "c2"], projectId: "p2" });

    expect(moved).toEqual({ projectName: "Beach day", count: 2 });
    expect(files.copies).toEqual([
      ["clips/p1/c1.mp4", "clips/p2/c1.mp4"],
      ["clips/p1/c2.mp4", "clips/p2/c2.mp4"],
    ]);
    expect(files.removed).toEqual(["clips/p1/c1.mp4", "clips/p1/c2.mp4"]);
    // clip-001 and clip-001 (2) are taken there, so the moved clip-001 becomes clip-001 (3).
    expect(tables.clip.find((row) => row.id === "c1")).toMatchObject({ projectId: "p2", name: "clip-001 (3)", storageKey: "clips/p2/c1.mp4" });
    expect(tables.clip.find((row) => row.id === "c2")).toMatchObject({ projectId: "p2", name: "clip-002", aiGenerated: true });
    expect(tables.clip.filter((row) => row.projectId === "p1")).toEqual([]);
  });

  it("names clashing clips (2), then (3), when several with one name arrive together", async () => {
    const { db, tables } = fakeDb({
      projects: [project(), project({ id: "p2" }), project({ id: "p3" })],
      clips: [
        clip({ id: "c1" }),
        clip({ id: "d1", projectId: "p3", storageKey: "clips/p3/d1.mp4" }),
        clip({ id: "t1", projectId: "p2", storageKey: "clips/p2/t1.mp4" }),
      ],
    });
    const files = fakeStore();
    await moveClipsToProject({ db, store: files.store, ...owned, clipIds: ["c1", "d1"], projectId: "p2" });

    const names = Object.fromEntries(tables.clip.map((row) => [row.id, [row.projectId, row.name]]));
    expect(names).toEqual({ t1: ["p2", "clip-001"], c1: ["p2", "clip-001 (2)"], d1: ["p2", "clip-001 (3)"] });
  });

  it("refuses a rendering or someone else's project, and the project the clips are already in", async () => {
    const cases = [
      { projects: [project(), project({ id: "p2", status: "rendering" })], projectId: "p2", error: "rendering" },
      { projects: [project({ status: "rendering" }), project({ id: "p2" })], projectId: "p2", error: "rendering" },
      { projects: [project(), project({ id: "p2", ownerId: "user-2" })], projectId: "p2", error: "project not found" },
      { projects: [project()], projectId: "p1", error: "pick another project" },
    ];
    for (const { projects, projectId, error } of cases) {
      const { db, tables } = fakeDb({ projects, clips: [clip()] });
      const files = fakeStore();
      await expect(moveClipsToProject({ db, store: files.store, ...owned, clipIds: ["c1"], projectId })).rejects.toThrow(error);
      await expect(copyClipsToProject({ db, store: files.store, ...owned, clipIds: ["c1"], projectId })).rejects.toThrow(error);
      expect(files.copies).toEqual([]);
      expect(tables.clip).toEqual([clip()]);
    }
  });

  it("copies clips under new keys in the other project, keeping their details, and leaves the originals", async () => {
    const { db, tables } = fakeDb(seed());
    const files = fakeStore();
    const copied = await copyClipsToProject({ db, store: files.store, ...owned, clipIds: ["c1", "c2"], projectId: "p2" });

    expect(copied).toEqual({ projectName: "Beach day", count: 2 });
    expect(files.removed).toEqual([]);
    expect(tables.clip.filter((row) => row.projectId === "p1").map((row) => row.id)).toEqual(["c1", "c2"]);
    const copies = tables.clip.filter((row) => row.projectId === "p2" && !["t1", "t2"].includes(row.id));
    expect(copies).toMatchObject([
      { name: "clip-001 (3)", start: 5, length: 15, title: "Wait for it", description: "Watch to the end", aiGenerated: false },
      { name: "clip-002", title: "Wait for it", description: "Watch to the end", aiGenerated: true },
    ]);
    expect(files.copies).toEqual(copies.map((row, index) => [`clips/p1/c${index + 1}.mp4`, row.storageKey]));
    for (const row of copies) {
      expect(row.id).not.toMatch(/^c\d$/);
      expect(row.storageKey).toBe(`clips/p2/${row.id}.mp4`);
    }
  });
});

describe("a clip's posted-elsewhere links", () => {
  const links = [{ id: "l1", clipId: "c1", url: "https://youtube.com/shorts/abc" }];
  const seed = () => ({ projects: [project(), project({ id: "p2", name: "Beach day" })], clips: [clip()], clipLinks: structuredClone(links) });

  it("stay with the clip that was posted: no copy gets them", async () => {
    for (const copy of [
      (db: PrismaClient, store: ClipStore) => copyClip({ db, store, ...owned, clipId: "c1" }),
      (db: PrismaClient, store: ClipStore) => copyProject({ db, store, ...owned, projectId: "p1" }),
      (db: PrismaClient, store: ClipStore) => copyClipsToProject({ db, store, ...owned, clipIds: ["c1"], projectId: "p2" }),
    ]) {
      const { db, tables } = fakeDb(seed());
      await copy(db, fakeStore().store);
      expect(tables.clip).toHaveLength(2);
      expect(tables.clipLink).toEqual(links);
    }
  });

  it("move with the clip, which keeps its row", async () => {
    const { db, tables } = fakeDb(seed());
    await moveClipsToProject({ db, store: fakeStore().store, ...owned, clipIds: ["c1"], projectId: "p2" });
    expect(tables.clip).toEqual([expect.objectContaining({ id: "c1", projectId: "p2" })]);
    expect(tables.clipLink).toEqual(links);
  });
});

describe("scheduleClips", () => {
  const account = { id: "acc-1", ownerId: "user-1", status: "active" };
  const HOUR = 60 * 60 * 1000;

  it("schedules one post per clip, spaced by the gap, under one rights confirmation", async () => {
    const { db, tables } = fakeDb({
      projects: [project()],
      clips: [clip({ id: "c1" }), clip({ id: "c2", storageKey: "clips/p1/c2.mp4" })],
      accounts: [account],
    });
    const files = fakeStore();
    const first = Date.now() + 3 * HOUR;
    await scheduleClips({
      db,
      store: files.store,
      queue: { send: async () => "job-1", cancel: async () => {} },
      ...owned,
      clipIds: ["c1", "c2"],
      accountIds: ["acc-1"],
      firstScheduledAt: new Date(first).toISOString(),
      gapHours: 24,
      aiGenerated: false,
      rightsConfirmed: true,
      audioSource: "original",
      now: new Date(),
    });

    expect(tables.post.map((post) => new Date(post.scheduledAt as string).getTime())).toEqual([first, first + 24 * HOUR]);
    expect(tables.auditLog).toHaveLength(2);
  });

  it("labels clips made with AI as AI-generated, and the others only when the box is ticked", async () => {
    const schedule = async (aiGenerated: boolean) => {
      const { db, tables } = fakeDb({
        projects: [project()],
        clips: [clip({ id: "c1", aiGenerated: true }), clip({ id: "c2", storageKey: "clips/p1/c2.mp4" })],
        accounts: [account],
      });
      await scheduleClips({
        db,
        store: fakeStore().store,
        queue: { send: async () => "job", cancel: async () => {} },
        ...owned,
        clipIds: ["c1", "c2"],
        accountIds: ["acc-1"],
        firstScheduledAt: new Date(Date.now() + 3 * HOUR).toISOString(),
        gapHours: 24,
        aiGenerated,
        rightsConfirmed: true,
        audioSource: "original",
        now: new Date(),
      });
      return tables.post.map((post) => post.aiGenerated);
    };

    expect(await schedule(false)).toEqual([true, false]);
    expect(await schedule(true)).toEqual([true, true]);
  });

  it("adds the credit line of a clip's CC BY music to its caption", async () => {
    const { db, tables } = fakeDb({
      projects: [project()],
      clips: [clip({ id: "c1", musicTrack: "km-vibe-ace" }), clip({ id: "c2", storageKey: "clips/p1/c2.mp4", musicTrack: "oga-dark-shrine" })],
      accounts: [account],
    });
    await scheduleClips({
      db,
      store: fakeStore().store,
      queue: { send: async () => "job", cancel: async () => {} },
      ...owned,
      clipIds: ["c1", "c2"],
      accountIds: ["acc-1"],
      firstScheduledAt: new Date(Date.now() + 3 * HOUR).toISOString(),
      gapHours: 24,
      aiGenerated: false,
      rightsConfirmed: true,
      audioSource: "licensed",
      now: new Date(),
    });
    expect(tables.post.map((post) => post.caption)).toEqual([
      'Watch to the end\n\n"Vibe Ace" Kevin MacLeod (incompetech.com) Licensed under Creative Commons: By Attribution 4.0 License http://creativecommons.org/licenses/by/4.0/',
      "Watch to the end",
    ]);
  });

  it("creates nothing when the rights are not confirmed or a clip is not in the owner's projects", async () => {
    const { db, tables } = fakeDb({ projects: [project()], clips: [clip()], accounts: [account] });
    const firstScheduledAt = new Date(Date.now() + 3 * HOUR).toISOString();
    const base = { db, store: fakeStore().store, queue: { send: async () => "x", cancel: async () => {} }, ...owned };

    await expect(
      scheduleClips({ ...base, clipIds: ["c1"], accountIds: ["acc-1"], firstScheduledAt, gapHours: 24, aiGenerated: false, rightsConfirmed: false, audioSource: "original", now: new Date() }),
    ).rejects.toThrow(/confirm/);
    await expect(
      scheduleClips({ ...base, clipIds: ["c1", "missing"], accountIds: ["acc-1"], firstScheduledAt, gapHours: 24, aiGenerated: false, rightsConfirmed: true, audioSource: "original", now: new Date() }),
    ).rejects.toThrow("clip not found");

    expect(tables.post).toEqual([]);
    expect(tables.media).toEqual([]);
  });

  it("creates nothing when a later clip's caption breaks the Instagram limits", async () => {
    const hashtags = Array.from({ length: 31 }, (_, index) => `#tag${index}`).join(" ");
    const { db, tables } = fakeDb({
      projects: [project()],
      clips: [clip({ id: "c1" }), clip({ id: "c2", name: "clip-002", description: hashtags })],
      accounts: [account],
    });
    const files = fakeStore();
    const queued: string[] = [];
    await expect(
      scheduleClips({
        db,
        store: files.store,
        queue: { send: async (postId) => (queued.push(postId), "job"), cancel: async () => {} },
        ...owned,
        clipIds: ["c1", "c2"],
        accountIds: ["acc-1"],
        firstScheduledAt: new Date(Date.now() + 3 * HOUR).toISOString(),
        gapHours: 24,
        aiGenerated: false,
        rightsConfirmed: true,
        audioSource: "original",
        now: new Date(),
      }),
    ).rejects.toThrow("clip-002: caption may have at most 30 hashtags");

    expect(files.copies).toEqual([]);
    expect(queued).toEqual([]);
    expect(tables.post).toEqual([]);
  });

  it("rolls back every post, cancels the jobs and removes the copies when a later clip fails", async () => {
    const { db, tables } = fakeDb({
      projects: [project()],
      clips: [clip({ id: "c1" }), clip({ id: "c2", storageKey: "clips/p1/c2.mp4" })],
      accounts: [account],
    });
    const created = db.post.create;
    let calls = 0;
    db.post.create = (async (args: Parameters<typeof created>[0]) => {
      calls += 1;
      if (calls === 2) throw new Error("connection lost");
      return created(args);
    }) as unknown as typeof created;
    const files = fakeStore();
    const canceled: string[] = [];
    let job = 0;
    await expect(
      scheduleClips({
        db,
        store: files.store,
        queue: { send: async () => `job-${++job}`, cancel: async (jobId) => void canceled.push(jobId) },
        ...owned,
        clipIds: ["c1", "c2"],
        accountIds: ["acc-1"],
        firstScheduledAt: new Date(Date.now() + 3 * HOUR).toISOString(),
        gapHours: 24,
        aiGenerated: false,
        rightsConfirmed: true,
        audioSource: "original",
        now: new Date(),
      }),
    ).rejects.toThrow("connection lost");

    expect(tables.post).toEqual([]);
    expect(tables.media).toEqual([]);
    expect(tables.auditLog).toEqual([]);
    expect(canceled).toEqual(["job-1", "job-2"]);
    expect(files.removed).toEqual(files.copies.map(([, to]) => to));
    expect(files.removed).toHaveLength(2);
  });
});

describe("scheduleClip", () => {
  const scheduledAt = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
  const account = { id: "acc-1", ownerId: "user-1", status: "active" };

  it("copies the clip to the account's reel key, creates the media, and schedules the post", async () => {
    const { db, tables } = fakeDb({ projects: [project()], clips: [clip()], accounts: [account] });
    const files = fakeStore();
    const queued: string[] = [];
    await scheduleClip({
      db,
      store: files.store,
      queue: { send: async (postId) => (queued.push(postId), "job-1"), cancel: async () => {} },
      ...owned,
      clipId: "c1",
      accountIds: ["acc-1"],
      caption: "Wait for it",
      scheduledAt,
      aiGenerated: false,
      rightsConfirmed: true,
      audioSource: "original",
      now: new Date(),
    });

    const media = tables.media[0];
    expect(files.copies).toEqual([["clips/p1/c1.mp4", `reels/${media.id}.mp4`]]);
    expect(media).toMatchObject({ accountId: "acc-1", status: "ready", reelKey: `reels/${media.id}.mp4` });
    expect(tables.post[0]).toMatchObject({ accountId: "acc-1", mediaId: media.id });
    expect(queued).toHaveLength(1);
  });

  it("labels a clip made with AI as AI-generated even when the form says it is not, and others as the form says", async () => {
    const schedule = async (clipAiGenerated: boolean, aiGenerated: boolean) => {
      const { db } = fakeDb({ projects: [project()], clips: [clip({ aiGenerated: clipAiGenerated })], accounts: [account] });
      const post = await scheduleClip({
        db,
        store: fakeStore().store,
        queue: { send: async () => "job-1", cancel: async () => {} },
        ...owned,
        clipId: "c1",
        accountIds: ["acc-1"],
        caption: "Wait for it",
        scheduledAt,
        aiGenerated,
        rightsConfirmed: true,
        audioSource: "original",
        now: new Date(),
      });
      return post.posts[0].aiGenerated;
    };

    expect(await schedule(true, false)).toBe(true);
    expect(await schedule(false, false)).toBe(false);
    expect(await schedule(false, true)).toBe(true);
  });

  it("refuses a caption Instagram would reject, and copies or creates nothing", async () => {
    const { db, tables } = fakeDb({ projects: [project()], clips: [clip()], accounts: [account] });
    const files = fakeStore();
    await expect(
      scheduleClip({
        db,
        store: files.store,
        queue: { send: async () => "x", cancel: async () => {} },
        ...owned,
        clipId: "c1",
        accountIds: ["acc-1"],
        caption: "x".repeat(2201),
        scheduledAt,
        aiGenerated: false,
        rightsConfirmed: true,
        audioSource: "original",
        now: new Date(),
      }),
    ).rejects.toThrow("caption must be at most 2200 characters");

    expect(tables.media).toEqual([]);
    expect(files.copies).toEqual([]);
  });

  it("refuses a publish time that is not in the future", async () => {
    const { db, tables } = fakeDb({ projects: [project()], clips: [clip()], accounts: [account] });
    const now = new Date();
    await expect(
      scheduleClip({
        db,
        store: fakeStore().store,
        queue: { send: async () => "x", cancel: async () => {} },
        ...owned,
        clipId: "c1",
        accountIds: ["acc-1"],
        caption: "Wait for it",
        scheduledAt: now.toISOString(),
        aiGenerated: false,
        rightsConfirmed: true,
        audioSource: "original",
        now,
      }),
    ).rejects.toThrow(UserError);
    expect(tables.post).toEqual([]);
  });

  it("refuses to schedule without the rights confirmation, and copies or creates nothing", async () => {
    const { db, tables } = fakeDb({ projects: [project()], clips: [clip()], accounts: [account] });
    const files = fakeStore();
    await expect(
      scheduleClip({
        db,
        store: files.store,
        queue: { send: async () => "x", cancel: async () => {} },
        ...owned,
        clipId: "c1",
        accountIds: ["acc-1"],
        caption: "Wait for it",
        scheduledAt,
        aiGenerated: false,
        rightsConfirmed: false,
        audioSource: "original",
        now: new Date(),
      }),
    ).rejects.toThrow(/license/);
    expect(files.copies).toEqual([]);
    expect(tables.media).toEqual([]);
    expect(tables.post).toEqual([]);
  });

  it("records the audio source and project on the media, and logs the confirmation with a duplicate warning", async () => {
    const other = { id: "acc-2", ownerId: "user-1", status: "active" };
    const { db, tables } = fakeDb({
      projects: [project()],
      clips: [clip()],
      accounts: [account, other],
      media: [{ id: "m-old", accountId: "acc-2", sourceProjectId: "p1" }],
      posts: [{ id: "post-old", accountId: "acc-2", mediaId: "m-old", status: "published" }],
    });
    const post = await scheduleClip({
      db,
      store: fakeStore().store,
      queue: { send: async () => "job-1", cancel: async () => {} },
      ...owned,
      clipId: "c1",
      accountIds: ["acc-1"],
      caption: "Wait for it",
      scheduledAt,
      aiGenerated: false,
      rightsConfirmed: true,
      audioSource: "from_source",
      now: new Date(),
    });

    expect(tables.media.at(-1)).toMatchObject({ audioSource: "from_source", sourceProjectId: "p1", sourceClipId: "c1" });
    expect(tables.auditLog).toHaveLength(1);
    expect(tables.auditLog[0]).toMatchObject({ action: "rights_confirmed", targetType: "Post", targetId: post.posts[0].id });
    const logged = tables.auditLog[0].data as { siblingAccountCount: number; warnings: string[] };
    expect(logged.siblingAccountCount).toBe(1);
    expect(logged.warnings).toHaveLength(2);
  });

  it("refuses an account that is not active or belongs to someone else", async () => {
    const { db } = fakeDb({ projects: [project()], clips: [clip()], accounts: [{ ...account, status: "revoked" }] });
    await expect(
      scheduleClip({
        db,
        store: fakeStore().store,
        queue: { send: async () => "x", cancel: async () => {} },
        ...owned,
        clipId: "c1",
        accountIds: ["acc-1"],
        caption: "x",
        scheduledAt,
        aiGenerated: false,
        rightsConfirmed: true,
        audioSource: "original",
        now: new Date(),
      }),
    ).rejects.toThrow("account is not connected and active");
  });
});

describe("scheduling to YouTube", () => {
  const HOUR = 60 * 60 * 1000;
  const account = { id: "acc-1", ownerId: "user-1", status: "active" };
  const channel = { id: "yt-1", ownerId: "user-1", status: "active" };
  const scheduledAt = new Date(Date.now() + 3 * HOUR).toISOString();

  function queues() {
    const sent: Array<[string, string]> = [];
    const canceled: string[] = [];
    const make = (name: string) => ({
      send: async (postId: string) => (sent.push([name, postId]), `${name}-job-${sent.length}`),
      cancel: async (jobId: string) => void canceled.push(jobId),
    });
    return { instagram: make("ig"), youtube: make("yt"), sent, canceled };
  }

  const target = (queue: ReturnType<typeof queues>["youtube"], overrides: Record<string, unknown> = {}) => ({
    queue,
    ytAccountIds: ["yt-1"],
    privacy: "unlisted",
    madeForKids: "no",
    ...overrides,
  });

  function scheduleOne(db: PrismaClient, q: ReturnType<typeof queues>, store: ClipStore, overrides: Record<string, unknown> = {}) {
    return scheduleClip({
      db,
      store,
      queue: q.instagram,
      ...owned,
      clipId: "c1",
      accountIds: [],
      youtube: target(q.youtube, { title: "Wait for it" }),
      caption: "Watch to the end",
      scheduledAt,
      aiGenerated: false,
      rightsConfirmed: true,
      audioSource: "original",
      now: new Date(),
      ...overrides,
    });
  }

  it("posts one clip to Instagram and YouTube together, each with its own copy and job", async () => {
    const { db, tables } = fakeDb({ projects: [project()], clips: [clip({ aiGenerated: true })], accounts: [account], channels: [channel] });
    const files = fakeStore();
    const q = queues();
    const result = await scheduleOne(db, q, files.store, { accountIds: ["acc-1"] });

    expect(result.posts).toHaveLength(1);
    const yt = tables.ytPost[0];
    expect(yt).toMatchObject({
      ytAccountId: "yt-1",
      title: "Wait for it",
      description: "Watch to the end\n\n#Shorts",
      privacy: "unlisted",
      madeForKids: false,
      aiGenerated: true,
      sourceClipId: "c1",
      videoKey: `youtube/${yt.id}.mp4`,
      queueJobId: "yt-job-2",
    });
    expect(files.copies).toContainEqual(["clips/p1/c1.mp4", `youtube/${yt.id}.mp4`]);
    expect(q.sent.map(([name]) => name)).toEqual(["ig", "yt"]);
    expect(tables.auditLog.map((log) => log.targetType)).toEqual(["Post", "YtPost"]);
  });

  it("posts several clips to YouTube only, titled by each clip's title or name, spaced by the gap", async () => {
    const { db, tables } = fakeDb({
      projects: [project()],
      clips: [clip(), clip({ id: "c2", title: null, name: "clip-002", storageKey: "clips/p1/c2.mp4" })],
      channels: [channel],
    });
    const q = queues();
    const first = Date.now() + 3 * HOUR;
    await scheduleClips({
      db,
      store: fakeStore().store,
      queue: q.instagram,
      ...owned,
      clipIds: ["c1", "c2"],
      accountIds: [],
      youtube: target(q.youtube, { privacy: "public", madeForKids: "yes" }),
      firstScheduledAt: new Date(first).toISOString(),
      gapHours: 2,
      aiGenerated: false,
      rightsConfirmed: true,
      audioSource: "original",
      now: new Date(),
    });

    expect(tables.post).toEqual([]);
    expect(tables.ytPost.map((post) => [post.title, (post.scheduledAt as Date).getTime(), post.madeForKids])).toEqual([
      ["Wait for it", first, true],
      ["clip-002", first + 2 * HOUR, true],
    ]);
  });

  it.each([
    ["no destination", { accountIds: [], youtube: undefined }, /at least one/],
    ["no made-for-kids answer", { youtube: "madeForKids" }, /made for kids/],
    ["an unknown privacy", { youtube: "privacy" }, /public, unlisted or private/],
    ["a title over 100 characters", { youtube: "title" }, /over 100 characters/],
  ])("refuses %s and copies or creates nothing", async (_name, change, error) => {
    const { db, tables } = fakeDb({ projects: [project()], clips: [clip()], accounts: [account], channels: [channel] });
    const files = fakeStore();
    const q = queues();
    const broken: Record<string, Record<string, unknown>> = {
      madeForKids: { madeForKids: "" },
      privacy: { privacy: "friends" },
      title: { title: "x".repeat(101) },
    };
    const overrides =
      typeof change.youtube === "string" ? { youtube: target(q.youtube, { title: "Wait for it", ...broken[change.youtube] }) } : change;
    await expect(scheduleOne(db, q, files.store, overrides)).rejects.toThrow(error);
    expect(tables.ytPost).toEqual([]);
    expect(files.copies).toEqual([]);
    expect(q.sent).toEqual([]);
  });

  it("refuses a clip longer than a Short can be", async () => {
    const { db, tables } = fakeDb({ projects: [project()], clips: [clip({ length: 181 })], channels: [channel] });
    await expect(scheduleOne(db, queues(), fakeStore().store)).rejects.toThrow("clip-001: a YouTube Short is at most 3 minutes long");
    expect(tables.ytPost).toEqual([]);
  });

  it("refuses a channel that is not connected or belongs to someone else", async () => {
    for (const other of [{ ...channel, status: "reauth_required" }, { ...channel, ownerId: "user-2" }]) {
      const { db } = fakeDb({ projects: [project()], clips: [clip()], channels: [other] });
      await expect(scheduleOne(db, queues(), fakeStore().store)).rejects.toThrow("the YouTube channel is not connected and active");
    }
  });

  it("cancels the jobs and removes the copies when the posts cannot be saved", async () => {
    const { db } = fakeDb({ projects: [project()], clips: [clip()], accounts: [account], channels: [channel] });
    (db as unknown as { ytPost: { create: () => Promise<never> } }).ytPost.create = async () => {
      throw new Error("database down");
    };
    const files = fakeStore();
    const q = queues();
    await expect(scheduleOne(db, q, files.store, { accountIds: ["acc-1"] })).rejects.toThrow("database down");
    expect(q.canceled).toEqual(["ig-job-1", "yt-job-2"]);
    expect(files.removed).toHaveLength(2);
  });
});

describe("scheduling to Facebook and TikTok", () => {
  const HOUR = 60 * 60 * 1000;
  const account = { id: "acc-1", ownerId: "user-1", status: "active" };
  const channel = { id: "yt-1", ownerId: "user-1", status: "active" };
  const page = { id: "fb-1", ownerId: "user-1", status: "active" };
  const tiktok = { id: "tt-1", ownerId: "user-1", status: "active" };
  const scheduledAt = new Date(Date.now() + 3 * HOUR).toISOString();

  function queues() {
    const sent: Array<[string, string]> = [];
    const canceled: string[] = [];
    const make = (name: string) => ({
      send: async (postId: string) => (sent.push([name, postId]), `${name}-job-${sent.length}`),
      cancel: async (jobId: string) => void canceled.push(jobId),
    });
    return { instagram: make("ig"), youtube: make("yt"), facebook: make("fb"), tiktok: make("tt"), sent, canceled };
  }

  const seeded = (clips: Row[] = [clip()]) =>
    fakeDb({ projects: [project()], clips, accounts: [account], channels: [channel], pages: [page], tiktoks: [tiktok] });

  function scheduleEverywhere(db: PrismaClient, q: ReturnType<typeof queues>, store: ClipStore, overrides: Record<string, unknown> = {}) {
    return scheduleClip({
      db,
      store,
      queue: q.instagram,
      ...owned,
      clipId: "c1",
      accountIds: ["acc-1"],
      youtube: { queue: q.youtube, ytAccountIds: ["yt-1"], privacy: "public", madeForKids: "no", title: "Wait for it" },
      facebook: { queue: q.facebook, fbPageIds: ["fb-1"] },
      tiktok: { queue: q.tiktok, ttAccountIds: ["tt-1"] },
      caption: "Watch to the end",
      scheduledAt,
      aiGenerated: false,
      rightsConfirmed: true,
      audioSource: "original",
      now: new Date(),
      ...overrides,
    });
  }

  it("posts one clip to Instagram, YouTube, a Facebook Page and a TikTok inbox together, each with its own copy and job", async () => {
    const { db, tables } = seeded([clip({ aiGenerated: true })]);
    const files = fakeStore();
    const q = queues();
    const result = await scheduleEverywhere(db, q, files.store);

    expect([result.posts.length, result.ytPosts.length, result.fbPosts.length, result.ttPosts.length]).toEqual([1, 1, 1, 1]);
    const fb = tables.fbPost[0];
    expect(fb).toMatchObject({
      fbPageId: "fb-1",
      description: "Watch to the end",
      aiGenerated: true,
      sourceClipId: "c1",
      videoKey: `facebook/${fb.id}.mp4`,
      queueJobId: "fb-job-3",
    });
    const tt = tables.ttPost[0];
    expect(tt).toMatchObject({
      ttAccountId: "tt-1",
      caption: "Watch to the end",
      aiGenerated: true,
      videoKey: `tiktok/${tt.id}.mp4`,
      queueJobId: "tt-job-4",
    });
    expect(files.copies).toContainEqual(["clips/p1/c1.mp4", `facebook/${fb.id}.mp4`]);
    expect(files.copies).toContainEqual(["clips/p1/c1.mp4", `tiktok/${tt.id}.mp4`]);
    expect(q.sent.map(([name]) => name)).toEqual(["ig", "yt", "fb", "tt"]);
    expect(tables.auditLog.map((log) => log.targetType)).toEqual(["Post", "YtPost", "FbPost", "TtPost"]);
  });

  it("schedules several clips to Facebook and TikTok only, spaced by the gap, with the credit-carrying caption", async () => {
    const { db, tables } = seeded([clip(), clip({ id: "c2", name: "clip-002", storageKey: "clips/p1/c2.mp4", description: "Second" })]);
    const q = queues();
    const first = Date.now() + 3 * HOUR;
    await scheduleClips({
      db,
      store: fakeStore().store,
      queue: q.instagram,
      ...owned,
      clipIds: ["c1", "c2"],
      accountIds: [],
      facebook: { queue: q.facebook, fbPageIds: ["fb-1"] },
      tiktok: { queue: q.tiktok, ttAccountIds: ["tt-1"] },
      firstScheduledAt: new Date(first).toISOString(),
      gapHours: 3,
      aiGenerated: true,
      rightsConfirmed: true,
      audioSource: "original",
      now: new Date(),
    });

    expect(tables.post).toEqual([]);
    expect(tables.fbPost.map((post) => [(post.scheduledAt as Date).getTime(), post.aiGenerated])).toEqual([
      [first, true],
      [first + 3 * HOUR, true],
    ]);
    expect(tables.ttPost.map((post) => post.caption)).toEqual([expect.any(String), "Second"]);
  });

  it("refuses a clip outside a Facebook Reel's 3 to 90 seconds and makes nothing anywhere", async () => {
    for (const length of [2, 91]) {
      const { db, tables } = seeded([clip({ length })]);
      const files = fakeStore();
      const q = queues();
      await expect(scheduleEverywhere(db, q, files.store)).rejects.toThrow("clip-001: a Facebook Reel is 3 to 90 seconds long");
      expect([tables.post, tables.ytPost, tables.fbPost, tables.ttPost]).toEqual([[], [], [], []]);
      expect(files.copies).toEqual([]);
      expect(q.sent).toEqual([]);
    }
  });

  it("refuses a Page or a TikTok account that is not connected or belongs to someone else", async () => {
    for (const [pages, tiktoks, error] of [
      [[{ ...page, status: "reauth_required" }], [tiktok], "the Facebook Page is not connected and active"],
      [[page], [{ ...tiktok, ownerId: "user-2" }], "the TikTok account is not connected and active"],
    ] as const) {
      const { db, tables } = fakeDb({ projects: [project()], clips: [clip()], accounts: [account], channels: [channel], pages: [...pages], tiktoks: [...tiktoks] });
      const q = queues();
      await expect(scheduleEverywhere(db, q, fakeStore().store)).rejects.toThrow(error);
      expect(tables.post).toEqual([]);
      expect(q.sent).toEqual([]);
    }
  });

  it("says to choose a destination when none is ticked", async () => {
    const { db } = seeded();
    await expect(
      scheduleEverywhere(db, queues(), fakeStore().store, {
        accountIds: [],
        youtube: undefined,
        facebook: { queue: queues().facebook, fbPageIds: [] },
        tiktok: undefined,
      }),
    ).rejects.toThrow("choose at least one Instagram account, YouTube channel, Facebook Page or TikTok account");
  });

  it("makes all or none: a TikTok post that cannot be saved undoes every post, job and copy", async () => {
    const { db, tables } = seeded();
    (db as unknown as { ttPost: { create: () => Promise<never> } }).ttPost.create = async () => {
      throw new Error("database down");
    };
    const files = fakeStore();
    const q = queues();
    await expect(scheduleEverywhere(db, q, files.store)).rejects.toThrow("database down");
    expect([tables.post, tables.ytPost, tables.fbPost, tables.media]).toEqual([[], [], [], []]);
    expect(q.canceled).toEqual(["ig-job-1", "yt-job-2", "fb-job-3", "tt-job-4"]);
    expect(files.removed).toHaveLength(4);
  });
});

describe("caption words and the kept cut", () => {
  const words = [
    { text: "hello", startMs: 0, endMs: 400, lineStart: true },
    { text: "um", startMs: 400, endMs: 600 },
    { text: "world", startMs: 600, endMs: 1000 },
  ];
  const captioned = (overrides: Partial<Row> = {}) =>
    clip({ words, baseKey: "clips/p1/c1.base.mp4", version: 1, recaptionId: null, recaptionError: "earlier", ...overrides });
  const captionProject = () => project({ withCaptions: true, captionPreset: "classic" });
  const fakeQueue = (fail = false) => {
    const sent: Array<[string, string]> = [];
    return {
      sent,
      queue: {
        send: async (clipId: string, recaptionId: string) => {
          if (fail) throw new Error("pg-boss is down");
          sent.push([clipId, recaptionId]);
          return "job-1";
        },
      },
    };
  };

  it("queues a re-render with the edited words, checked against the clip's", async () => {
    const { db, tables } = fakeDb({ projects: [captionProject()], clips: [captioned()] });
    const { queue, sent } = fakeQueue();
    const edited = [{ ...words[0], text: "Hello" }, { ...words[2], lineStart: true }];

    await startRecaption({ db, queue, ...owned, clipId: "c1", words: JSON.stringify(edited) });

    const row = tables.clip[0];
    expect(sent).toEqual([["c1", row.recaptionId]]);
    expect(row).toMatchObject({ recaptionWords: edited, recaptionStep: null, recaptionError: null, words });
  });

  it("refuses clips without kept words, one already re-rendering, a busy project and changed times", async () => {
    const { queue, sent } = fakeQueue();
    const body = JSON.stringify(words);
    const old = fakeDb({ projects: [captionProject()], clips: [clip({ words: null, baseKey: null, recaptionId: null })] });
    await expect(startRecaption({ db: old.db, queue, ...owned, clipId: "c1", words: body })).rejects.toThrow(
      "Captions can be edited on clips made after this update",
    );
    const running = fakeDb({ projects: [captionProject()], clips: [captioned({ recaptionId: "x1" })] });
    await expect(startRecaption({ db: running.db, queue, ...owned, clipId: "c1", words: body })).rejects.toThrow("already");
    const busy = fakeDb({ projects: [project({ status: "rendering", captionPreset: "classic" })], clips: [captioned()] });
    await expect(startRecaption({ db: busy.db, queue, ...owned, clipId: "c1", words: body })).rejects.toThrow("being made");
    const ok = fakeDb({ projects: [captionProject()], clips: [captioned()] });
    const moved = JSON.stringify([{ ...words[0], endMs: 500 }]);
    await expect(startRecaption({ db: ok.db, queue, ...owned, clipId: "c1", words: moved })).rejects.toThrow("do not match");
    expect(sent).toEqual([]);
    expect(ok.tables.clip[0].recaptionId).toBeNull();
  });

  it("clears the re-render when it cannot be queued", async () => {
    const { db, tables } = fakeDb({ projects: [captionProject()], clips: [captioned()] });
    await expect(
      startRecaption({ db, queue: fakeQueue(true).queue, ...owned, clipId: "c1", words: JSON.stringify(words) }),
    ).rejects.toThrow("pg-boss is down");
    expect(tables.clip[0]).toMatchObject({ recaptionId: null, recaptionError: "pg-boss is down" });
  });

  it("copies, moves and deletes the kept cut with its clip, and keeps the words on copies", async () => {
    const seed = () => ({ projects: [captionProject(), project({ id: "p2" })], clips: [captioned()] });

    const copying = fakeDb(seed());
    const copyFiles = fakeStore();
    const copy = await copyClip({ db: copying.db, store: copyFiles.store, ...owned, clipId: "c1" });
    expect(copyFiles.copies[1]).toEqual(["clips/p1/c1.base.mp4", `clips/p1/${copy.id}.base.mp4`]);
    expect(copying.tables.clip[1]).toMatchObject({ words, baseKey: `clips/p1/${copy.id}.base.mp4` });

    const moving = fakeDb(seed());
    const moveFiles = fakeStore();
    await moveClipsToProject({ db: moving.db, store: moveFiles.store, ...owned, clipIds: ["c1"], projectId: "p2" });
    expect(moveFiles.copies).toContainEqual(["clips/p1/c1.base.mp4", "clips/p2/c1.base.mp4"]);
    expect(moveFiles.removed).toEqual(["clips/p1/c1.mp4", "clips/p1/c1.base.mp4"]);
    expect(moving.tables.clip[0]).toMatchObject({ projectId: "p2", baseKey: "clips/p2/c1.base.mp4" });

    const deleting = fakeDb(seed());
    const deleteFiles = fakeStore();
    await deleteClip({ db: deleting.db, store: deleteFiles.store, ...owned, clipId: "c1" });
    expect(deleteFiles.removed).toEqual(["clips/p1/c1.mp4", "clips/p1/c1.base.mp4"]);

    const busy = fakeDb({ projects: [captionProject(), project({ id: "p2" })], clips: [captioned({ recaptionId: "x1" })] });
    await expect(deleteClip({ db: busy.db, store: fakeStore().store, ...owned, clipId: "c1" })).rejects.toThrow("re-rendered");
  });
});

describe("a clip's own sounds", () => {
  const sounds = [
    { time: 2.5, sound: "kenney-coin", volume: 60 },
    { time: 0.4, sound: "kenney-jump", volume: 30 },
  ];
  const kept = (overrides: Partial<Row> = {}) =>
    clip({ words: null, baseKey: "clips/p1/c1.base.mp4", length: 15, version: 1, recaptionId: null, recaptionError: "earlier", ...overrides });

  it("queues a re-render with the edited sounds, sorted, through the captions' re-render", async () => {
    const { db, tables } = fakeDb({ projects: [project()], clips: [kept()] });
    const sent: Array<[string, string]> = [];
    await startResound({
      db,
      queue: { send: async (clipId: string, recaptionId: string) => (sent.push([clipId, recaptionId]), "job-1") },
      ...owned,
      clipId: "c1",
      sounds: JSON.stringify(sounds),
    });
    const row = tables.clip[0];
    expect(sent).toEqual([["c1", row.recaptionId]]);
    expect(row).toMatchObject({ recaptionSounds: [sounds[1], sounds[0]], recaptionStep: null, recaptionError: null });
    expect(row.recaptionWords).toBeUndefined();
  });

  it("refuses clips without a kept cut, a busy clip or project, and sounds outside the clip", async () => {
    const queue = { send: async () => "job-1" };
    const body = JSON.stringify(sounds);
    const old = fakeDb({ projects: [project()], clips: [kept({ baseKey: null })] });
    await expect(startResound({ db: old.db, queue, ...owned, clipId: "c1", sounds: body })).rejects.toThrow("made after this update");
    const removed = fakeDb({ projects: [project()], clips: [kept({ baseKey: null, words: [] })] });
    await expect(startResound({ db: removed.db, queue, ...owned, clipId: "c1", sounds: body })).rejects.toThrow(BASE_CUT_REMOVED);
    const running = fakeDb({ projects: [project()], clips: [kept({ recaptionId: "x1" })] });
    await expect(startResound({ db: running.db, queue, ...owned, clipId: "c1", sounds: body })).rejects.toThrow("already");
    const busy = fakeDb({ projects: [project({ status: "rendering" })], clips: [kept()] });
    await expect(startResound({ db: busy.db, queue, ...owned, clipId: "c1", sounds: body })).rejects.toThrow("being made");
    const late = fakeDb({ projects: [project()], clips: [kept()] });
    const outside = JSON.stringify([{ time: 15, sound: "kenney-coin", volume: 60 }]);
    await expect(startResound({ db: late.db, queue, ...owned, clipId: "c1", sounds: outside })).rejects.toThrow("inside the clip");
    expect(late.tables.clip[0].recaptionId).toBeNull();
  });

  it("keeps the sounds and jump cuts on copies", async () => {
    const cuts = [1.2, 4.5];
    const { db, tables } = fakeDb({ projects: [project()], clips: [kept({ sounds, cuts })] });
    await copyClip({ db, store: fakeStore().store, ...owned, clipId: "c1" });
    expect(tables.clip[1]).toMatchObject({ sounds, cuts });
  });
});

describe("deleting a project's source video", () => {
  const at = new Date("2026-11-04T12:00:00Z");

  it("removes the video and keeps the clips, and the project then says why it cannot find highlights or make clips", async () => {
    const { db, tables } = fakeDb({ projects: [project()], clips: [clip()] });
    const files = fakeStore();
    await deleteProjectSource({ db, store: files.store, ...owned, projectId: "p1", now: at });

    expect(files.removed).toEqual(["clip-sources/p1.mp4"]);
    expect(tables.clipProject[0]).toMatchObject({ sourceKey: null, sourceDeletedAt: at, status: "done" });
    expect(tables.clip).toHaveLength(1);

    const queue = { send: async () => "job-1" };
    const making = await startRender({ db, queue, ...owned, projectId: "p1", clipSeconds: 30, clipCount: null, withCaptions: false }).catch(
      (err: unknown) => err,
    );
    expect(making).toBeInstanceOf(UserError);
    expect((making as Error).message).toBe(SOURCE_DELETED);
    await expect(
      startRender({ db, queue, ...owned, projectId: "p1", review: true, clipSeconds: 30, clipCount: null, withCaptions: false }),
    ).rejects.toThrow("source video was deleted on the Storage page");
    await expect(deleteProjectSource({ db, store: files.store, ...owned, projectId: "p1", now: at })).rejects.toThrow("already deleted");
  });

  it("refuses while clips are being made, highlights found or reviewed, and for projects without a video", async () => {
    const cases: Array<[Partial<Row>, string]> = [
      [{ status: "rendering" }, "being made"],
      [{ status: "picking" }, "being made"],
      [{ status: "review" }, "reviewing the highlights"],
      [{ status: "awaiting_source" }, "no stored source video"],
      [{ sourceKey: null, sourceUrl: "https://example.com/v" }, "no stored source video"],
      [{ aiVideos: true, sourceKey: null }, "no source video"],
    ];
    for (const [overrides, message] of cases) {
      const { db, tables } = fakeDb({ projects: [project(overrides)] });
      const files = fakeStore();
      await expect(deleteProjectSource({ db, store: files.store, ...owned, projectId: "p1", now: at })).rejects.toThrow(message);
      expect(files.removed).toEqual([]);
      expect(tables.clipProject[0].sourceDeletedAt).toBeUndefined();
    }
  });

  it("refuses another owner's project", async () => {
    const { db } = fakeDb({ projects: [project({ ownerId: "user-2" })] });
    await expect(deleteProjectSource({ db, store: fakeStore().store, ...owned, projectId: "p1", now: at })).rejects.toThrow("project not found");
  });

  it("carries over to a copy of the project", async () => {
    const { db, tables } = fakeDb({ projects: [project({ sourceKey: null, sourceDeletedAt: at })], clips: [clip()] });
    await copyProject({ db, store: fakeStore().store, ...owned, projectId: "p1" });
    expect(tables.clipProject[1]).toMatchObject({ sourceDeletedAt: at });
    expect(tables.clipProject[1].sourceKey).toBeUndefined();
  });
});

describe("a clip whose caption-edit copy the Storage page removed", () => {
  const words = [{ text: "hello", startMs: 0, endMs: 400, lineStart: true }];

  it("says why its captions cannot be edited, and its copies keep the words to say so too", async () => {
    const { db, tables } = fakeDb({
      projects: [project({ withCaptions: true, captionPreset: "classic" })],
      clips: [clip({ words, baseKey: null, recaptionId: null })],
    });
    const queue = { send: async () => "job-1" };
    await expect(startRecaption({ db, queue, ...owned, clipId: "c1", words: JSON.stringify(words) })).rejects.toThrow(BASE_CUT_REMOVED);

    await copyClip({ db, store: fakeStore().store, ...owned, clipId: "c1" });
    expect(tables.clip[1]).toMatchObject({ words, baseKey: null });
  });
});
