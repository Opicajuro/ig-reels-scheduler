import type { PrismaClient } from "@/generated/prisma/client";
import type { ManagedPage } from "./facebook";
import type { PublishQueue } from "./queues";
import { openSecret, sealSecret } from "./settings";
import { UserError } from "./user-error";

// Saves the Pages the person picked. Connecting a Page again (Reconnect) replaces its token and makes it active.
export async function saveFacebookPages(
  db: PrismaClient,
  key: Buffer,
  { ownerId, pages, pageIds }: { ownerId: string; pages: ManagedPage[]; pageIds: string[] },
) {
  const picked = pages.filter((page) => pageIds.includes(page.pageId));
  if (picked.length === 0) throw new UserError("pick at least one Page");
  for (const page of picked) {
    const existing = await db.fbPage.findUnique({ where: { pageId: page.pageId } });
    if (existing && existing.ownerId !== ownerId) throw new UserError(`${page.name} is already connected to another user`);
  }
  const saved = [];
  for (const page of picked) {
    const pageToken = sealSecret(page.accessToken, key);
    saved.push(
      await db.fbPage.upsert({
        where: { pageId: page.pageId },
        create: { ownerId, pageId: page.pageId, name: page.name, status: "active", pageToken },
        update: { name: page.name, status: "active", pageToken },
      }),
    );
  }
  return saved;
}

// Keeps the history but forgets the Page token and cancels the Page's scheduled posts with their jobs. An upload that
// has already started finishes.
export async function disconnectFacebookPage(
  db: PrismaClient,
  queue: PublishQueue,
  { ownerId, fbPageId }: { ownerId: string; fbPageId: string },
) {
  const page = await db.fbPage.findFirst({ where: { id: fbPageId, ownerId } });
  if (!page) throw new UserError("Page not found");
  const posts = await db.fbPost.findMany({ where: { fbPageId, status: "scheduled" } });
  await db.fbPost.updateMany({ where: { fbPageId, status: "scheduled" }, data: { status: "canceled" } });
  await db.fbPage.update({ where: { id: fbPageId }, data: { status: "revoked", pageToken: null } });
  for (const post of posts) if (post.queueJobId) await queue.cancel(post.queueJobId);
}

export async function facebookPageToken({ db, key, fbPageId }: { db: PrismaClient; key: Buffer; fbPageId: string }): Promise<string> {
  const page = await db.fbPage.findUnique({ where: { id: fbPageId } });
  if (!page?.pageToken) throw new Error(`no token stored for Facebook Page ${fbPageId}`);
  return openSecret(page.pageToken, key);
}
