import type { PrismaClient } from "@/generated/prisma/client";
import type { PublishQueue } from "./queues";
import { openSecret, sealSecret } from "./settings";
import { UserError } from "./user-error";
import { refreshYouTubeAccessToken, YouTubeAuthError, type GoogleClient } from "./youtube";

// Connecting a channel again (Reconnect) replaces its login and makes it active.
export async function saveYouTubeChannel(
  db: PrismaClient,
  key: Buffer,
  { ownerId, channelId, title, refreshToken }: { ownerId: string; channelId: string; title: string; refreshToken: string },
) {
  const existing = await db.ytAccount.findUnique({ where: { channelId } });
  if (existing && existing.ownerId !== ownerId) throw new Error("this YouTube channel is already connected to another user");
  const sealed = sealSecret(refreshToken, key);
  return db.ytAccount.upsert({
    where: { channelId },
    create: { ownerId, channelId, channelTitle: title, status: "active", refreshToken: sealed },
    update: { channelTitle: title, status: "active", refreshToken: sealed },
  });
}

// Keeps the history but forgets the login and cancels the channel's scheduled posts with their jobs. An upload that has
// already started finishes.
export async function disconnectYouTubeChannel(
  db: PrismaClient,
  queue: PublishQueue,
  { ownerId, ytAccountId }: { ownerId: string; ytAccountId: string },
) {
  const account = await db.ytAccount.findFirst({ where: { id: ytAccountId, ownerId } });
  if (!account) throw new UserError("channel not found");
  const posts = await db.ytPost.findMany({ where: { ytAccountId, status: "scheduled" } });
  await db.ytPost.updateMany({ where: { ytAccountId, status: "scheduled" }, data: { status: "canceled" } });
  await db.ytAccount.update({ where: { id: ytAccountId }, data: { status: "revoked", refreshToken: null } });
  for (const post of posts) if (post.queueJobId) await queue.cancel(post.queueJobId);
}

// A fresh access token from the channel's refresh token. A refresh token Google turns down marks the channel as needing
// reconnecting.
export async function youTubeAccessToken({
  db,
  key,
  client,
  ytAccountId,
  fetchFn = fetch,
}: {
  db: PrismaClient;
  key: Buffer;
  client: GoogleClient;
  ytAccountId: string;
  fetchFn?: typeof fetch;
}): Promise<string> {
  const account = await db.ytAccount.findUnique({ where: { id: ytAccountId } });
  if (!account?.refreshToken) throw new YouTubeAuthError(`no login stored for YouTube channel ${ytAccountId}`);
  try {
    return await refreshYouTubeAccessToken({ client, refreshToken: openSecret(account.refreshToken, key), fetchFn });
  } catch (err) {
    if (err instanceof YouTubeAuthError) {
      await db.ytAccount.update({ where: { id: ytAccountId }, data: { status: "reauth_required" } });
    }
    throw err;
  }
}
