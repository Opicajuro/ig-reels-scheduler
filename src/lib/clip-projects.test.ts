import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
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
  markSourceUploaded,
  moveClipsToProject,
  renameClip,
  renameProject,
  scheduleClip,
  scheduleClips,
  setClipDetails,
  startRender,
} from "./clip-projects";
import { UserError } from "./user-error";

type Row = Record<string, unknown> & { id: string };

// Enough of Prisma for these functions. Nested filters such as { project: { ownerId } } go through `relations`.
function fakeDb(
  seed: { projects?: Row[]; clips?: Row[]; accounts?: Row[]; media?: Row[]; posts?: Row[]; clipLinks?: Row[] } = {},
) {
  const tables: Record<string, Row[]> = {
    clipProject: seed.projects ?? [],
    clip: seed.clips ?? [],
    igAccount: seed.accounts ?? [],
    media: seed.media ?? [],
    post: seed.posts ?? [],
    clipLink: seed.clipLinks ?? [],
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

describe("startRender", () => {
  it("stores the options, marks the project rendering, and queues it", async () => {
    const { db, tables } = fakeDb({ projects: [project()] });
    const queued: string[] = [];
    await startRender({
      db,
      queue: { send: async (id) => (queued.push(id), "job-1") },
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
    expect(queued).toEqual(["p1"]);
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
      accountId: "acc-1",
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
        accountId: "acc-1",
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

  it("creates nothing when the rights are not confirmed or a clip is not in the owner's projects", async () => {
    const { db, tables } = fakeDb({ projects: [project()], clips: [clip()], accounts: [account] });
    const firstScheduledAt = new Date(Date.now() + 3 * HOUR).toISOString();
    const base = { db, store: fakeStore().store, queue: { send: async () => "x", cancel: async () => {} }, ...owned };

    await expect(
      scheduleClips({ ...base, clipIds: ["c1"], accountId: "acc-1", firstScheduledAt, gapHours: 24, aiGenerated: false, rightsConfirmed: false, audioSource: "original", now: new Date() }),
    ).rejects.toThrow(/confirm/);
    await expect(
      scheduleClips({ ...base, clipIds: ["c1", "missing"], accountId: "acc-1", firstScheduledAt, gapHours: 24, aiGenerated: false, rightsConfirmed: true, audioSource: "original", now: new Date() }),
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
        accountId: "acc-1",
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
        accountId: "acc-1",
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
      accountId: "acc-1",
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
        accountId: "acc-1",
        caption: "Wait for it",
        scheduledAt,
        aiGenerated,
        rightsConfirmed: true,
        audioSource: "original",
        now: new Date(),
      });
      return post.aiGenerated;
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
        accountId: "acc-1",
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
        accountId: "acc-1",
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
        accountId: "acc-1",
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
      accountId: "acc-1",
      caption: "Wait for it",
      scheduledAt,
      aiGenerated: false,
      rightsConfirmed: true,
      audioSource: "from_source",
      now: new Date(),
    });

    expect(tables.media.at(-1)).toMatchObject({ audioSource: "from_source", sourceProjectId: "p1", sourceClipId: "c1" });
    expect(tables.auditLog).toHaveLength(1);
    expect(tables.auditLog[0]).toMatchObject({ action: "rights_confirmed", targetType: "Post", targetId: post.id });
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
        accountId: "acc-1",
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
