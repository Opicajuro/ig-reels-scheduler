import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import type { ClipStore } from "./clip-store";
import {
  copyClip,
  copyProject,
  createLinkProject,
  createUploadProject,
  deleteClip,
  deleteProject,
  markSourceUploaded,
  renameClip,
  renameProject,
  scheduleClip,
  setClipDetails,
  startRender,
} from "./clip-projects";

type Row = Record<string, unknown> & { id: string };

// Enough of Prisma for these functions. Nested filters such as { project: { ownerId } } go through `relations`.
function fakeDb(
  seed: { projects?: Row[]; clips?: Row[]; accounts?: Row[]; media?: Row[]; posts?: Row[] } = {},
) {
  const tables: Record<string, Row[]> = {
    clipProject: seed.projects ?? [],
    clip: seed.clips ?? [],
    igAccount: seed.accounts ?? [],
    media: seed.media ?? [],
    post: seed.posts ?? [],
  };
  const relations: Record<string, Record<string, (row: Row) => Row | undefined>> = {
    clip: { project: (clip) => tables.clipProject.find((project) => project.id === clip.projectId) },
    media: { account: (media) => tables.igAccount.find((account) => account.id === media.accountId) },
  };
  const matches = (table: string, row: Row, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([key, value]) => {
      const relation = relations[table]?.[key];
      if (relation && value && typeof value === "object") {
        const related = relation(row);
        return related !== undefined && matches(key === "project" ? "clipProject" : "igAccount", related, value as Record<string, unknown>);
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
    findMany: async ({ where = {} }: { where?: Record<string, unknown> } = {}) =>
      structuredClone(tables[table].filter((row) => matches(table, row, where))),
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
  });
  const db = {
    clipProject: model("clipProject"),
    clip: model("clip"),
    igAccount: model("igAccount"),
    media: { ...model("media") },
    post: model("post"),
  };
  return { db: db as unknown as PrismaClient, tables };
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
      now: new Date(),
    });

    const media = tables.media[0];
    expect(files.copies).toEqual([["clips/p1/c1.mp4", `reels/${media.id}.mp4`]]);
    expect(media).toMatchObject({ accountId: "acc-1", status: "ready", reelKey: `reels/${media.id}.mp4` });
    expect(tables.post[0]).toMatchObject({ accountId: "acc-1", mediaId: media.id });
    expect(queued).toHaveLength(1);
  });

  it("removes the copy and the media when the post cannot be scheduled", async () => {
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
        now: new Date(),
      }),
    ).rejects.toThrow("caption must be at most 2200 characters");

    expect(tables.media).toEqual([]);
    expect(files.removed).toHaveLength(1);
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
        now: new Date(),
      }),
    ).rejects.toThrow("account is not connected and active");
  });
});
