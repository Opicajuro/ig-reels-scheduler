import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import {
  addClipLink,
  addGuideLink,
  addProfileLink,
  linksByClip,
  removeClipLink,
  removeGuideLink,
  removeProfileLink,
} from "./links";
import { UserError } from "./user-error";

type Row = Record<string, unknown> & { id: string };

// Enough of Prisma for the link functions: a clip's owner is found through its project.
function fakeDb() {
  const tables: Record<string, Row[]> = {
    clipProject: [
      { id: "p1", ownerId: "owner" },
      { id: "p2", ownerId: "someone-else" },
    ],
    clip: [
      { id: "c1", projectId: "p1" },
      { id: "c2", projectId: "p2" },
    ],
    clipLink: [],
    profileLink: [],
    guideLink: [],
  };
  const ownerOfClip = (clipId: unknown) => {
    const clip = tables.clip.find((row) => row.id === clipId);
    return tables.clipProject.find((project) => project.id === clip?.projectId)?.ownerId;
  };
  const matches = (row: Row, where: Record<string, unknown>) =>
    Object.entries(where).every(([key, value]) => {
      if (key === "project") return tables.clipProject.find((p) => p.id === row.projectId)?.ownerId === (value as { ownerId: string }).ownerId;
      if (key === "clip") return ownerOfClip(row.clipId) === (value as { project: { ownerId: string } }).project.ownerId;
      if (value && typeof value === "object" && "in" in value) return (value.in as unknown[]).includes(row[key]);
      return row[key] === value;
    });
  let created = 0;
  const model = (table: string) => ({
    findFirst: async ({ where }: { where: Record<string, unknown> }) => tables[table].find((row) => matches(row, where)) ?? null,
    findMany: async ({ where }: { where: Record<string, unknown> }) => tables[table].filter((row) => matches(row, where)),
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const row = { id: `${table}-${++created}`, createdAt: new Date(created), ...data } as Row;
      tables[table].push(row);
      return row;
    },
    deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
      const kept = tables[table].filter((row) => !matches(row, where));
      const count = tables[table].length - kept.length;
      tables[table] = kept;
      return { count };
    },
  });
  const db = {
    clip: model("clip"),
    clipLink: model("clipLink"),
    profileLink: model("profileLink"),
    guideLink: model("guideLink"),
  } as unknown as PrismaClient;
  return { db, tables };
}

describe("clip links", () => {
  it("adds a link to the owner's clip and removes it again", async () => {
    const { db, tables } = fakeDb();
    const link = await addClipLink({ db, ownerId: "owner", clipId: "c1", url: " https://youtube.com/shorts/abc " });
    expect(tables.clipLink).toEqual([expect.objectContaining({ clipId: "c1", url: "https://youtube.com/shorts/abc" })]);
    expect((await linksByClip(db, ["c1", "c2"])).get("c1")).toEqual([{ id: link.id, url: "https://youtube.com/shorts/abc" }]);

    await removeClipLink({ db, ownerId: "owner", linkId: link.id });
    expect(tables.clipLink).toEqual([]);
  });

  it("refuses a link that is not http or https, and adds nothing", async () => {
    const { db, tables } = fakeDb();
    await expect(addClipLink({ db, ownerId: "owner", clipId: "c1", url: "javascript:alert(1)" })).rejects.toThrow(UserError);
    expect(tables.clipLink).toEqual([]);
  });

  it("does not add to or remove from someone else's clip", async () => {
    const { db, tables } = fakeDb();
    await expect(addClipLink({ db, ownerId: "owner", clipId: "c2", url: "https://tiktok.com/@me/video/1" })).rejects.toThrow(
      "clip not found",
    );
    const theirs = await addClipLink({ db, ownerId: "someone-else", clipId: "c2", url: "https://tiktok.com/@me/video/1" });
    await expect(removeClipLink({ db, ownerId: "owner", linkId: theirs.id })).rejects.toThrow("link not found");
    expect(tables.clipLink).toHaveLength(1);
  });
});

describe("profile and guide links", () => {
  it("adds and removes the owner's profiles, and leaves someone else's alone", async () => {
    const { db, tables } = fakeDb();
    const mine = await addProfileLink({ db, ownerId: "owner", url: "https://www.youtube.com/@me" });
    const theirs = await addProfileLink({ db, ownerId: "someone-else", url: "https://kick.com/them" });
    await expect(addProfileLink({ db, ownerId: "owner", url: "ftp://example.com" })).rejects.toThrow(UserError);

    await expect(removeProfileLink({ db, ownerId: "owner", linkId: theirs.id })).rejects.toThrow("link not found");
    await removeProfileLink({ db, ownerId: "owner", linkId: mine.id });
    expect(tables.profileLink).toEqual([expect.objectContaining({ id: theirs.id })]);
  });

  it("adds a guide with a trimmed title, and needs a title and a web link", async () => {
    const { db, tables } = fakeDb();
    const guide = await addGuideLink({ db, ownerId: "owner", title: "  Making clips ", url: "https://youtu.be/guide" });
    expect(guide).toMatchObject({ ownerId: "owner", title: "Making clips", url: "https://youtu.be/guide" });
    await expect(addGuideLink({ db, ownerId: "owner", title: " ", url: "https://youtu.be/guide" })).rejects.toThrow(UserError);
    await expect(addGuideLink({ db, ownerId: "owner", title: "x".repeat(121), url: "https://youtu.be/guide" })).rejects.toThrow(
      UserError,
    );
    await expect(addGuideLink({ db, ownerId: "owner", title: "Bad", url: "file:///C:/guide.mp4" })).rejects.toThrow(UserError);

    await expect(removeGuideLink({ db, ownerId: "someone-else", linkId: guide.id })).rejects.toThrow("link not found");
    await removeGuideLink({ db, ownerId: "owner", linkId: guide.id });
    expect(tables.guideLink).toEqual([]);
  });
});
