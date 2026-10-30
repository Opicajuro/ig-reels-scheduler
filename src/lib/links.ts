import type { PrismaClient } from "@/generated/prisma/client";
import { parseLinkUrl } from "./platforms";
import { UserError } from "./user-error";

const MAX_GUIDE_TITLE = 120;

// Where a clip was posted outside Localirs. The clip must be in one of the owner's projects.
export async function addClipLink({ db, ownerId, clipId, url }: { db: PrismaClient; ownerId: string; clipId: string; url: unknown }) {
  const href = parseLinkUrl(url);
  const clip = await db.clip.findFirst({ where: { id: clipId, project: { ownerId } }, select: { id: true } });
  if (!clip) throw new UserError("clip not found");
  return db.clipLink.create({ data: { clipId: clip.id, url: href } });
}

export async function removeClipLink({ db, ownerId, linkId }: { db: PrismaClient; ownerId: string; linkId: string }) {
  const { count } = await db.clipLink.deleteMany({ where: { id: linkId, clip: { project: { ownerId } } } });
  if (count === 0) throw new UserError("link not found");
}

// The links of each clip asked for, by clip id. A clip without links is left out.
export async function linksByClip(db: PrismaClient, clipIds: string[]) {
  const links = await db.clipLink.findMany({
    where: { clipId: { in: clipIds } },
    orderBy: { createdAt: "asc" },
    select: { id: true, clipId: true, url: true },
  });
  const byClip = new Map<string, Array<{ id: string; url: string }>>();
  for (const link of links) byClip.set(link.clipId, [...(byClip.get(link.clipId) ?? []), { id: link.id, url: link.url }]);
  return byClip;
}

// The owner's own social profiles.
export async function addProfileLink({ db, ownerId, url }: { db: PrismaClient; ownerId: string; url: unknown }) {
  return db.profileLink.create({ data: { ownerId, url: parseLinkUrl(url) } });
}

export async function removeProfileLink({ db, ownerId, linkId }: { db: PrismaClient; ownerId: string; linkId: string }) {
  const { count } = await db.profileLink.deleteMany({ where: { id: linkId, ownerId } });
  if (count === 0) throw new UserError("link not found");
}

// A video guide for the Help page: a title and its link.
export async function addGuideLink({
  db,
  ownerId,
  title,
  url,
}: {
  db: PrismaClient;
  ownerId: string;
  title: unknown;
  url: unknown;
}) {
  const name = typeof title === "string" ? title.trim() : "";
  if (!name) throw new UserError("give the guide a title");
  if (name.length > MAX_GUIDE_TITLE) throw new UserError(`the title is longer than ${MAX_GUIDE_TITLE} characters`);
  return db.guideLink.create({ data: { ownerId, title: name, url: parseLinkUrl(url) } });
}

export async function removeGuideLink({ db, ownerId, linkId }: { db: PrismaClient; ownerId: string; linkId: string }) {
  const { count } = await db.guideLink.deleteMany({ where: { id: linkId, ownerId } });
  if (count === 0) throw new UserError("link not found");
}
