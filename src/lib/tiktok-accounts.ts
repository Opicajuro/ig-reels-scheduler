import type { PrismaClient } from "@/generated/prisma/client";
import type { PublishQueue } from "./queues";
import { openSecret, sealSecret } from "./settings";
import { refreshTikTokTokens, TikTokAuthError, type TikTokApp, type TikTokTokens } from "./tiktok";
import { UserError } from "./user-error";

// An access token is refreshed when it has less than this left, so an upload never starts with one about to expire.
const REFRESH_MARGIN_MS = 30 * 60 * 1000;

function sealedTokens(tokens: TikTokTokens, key: Buffer) {
  return {
    refreshToken: sealSecret(tokens.refreshToken, key),
    accessToken: sealSecret(tokens.accessToken, key),
    accessExpiresAt: tokens.accessExpiresAt,
  };
}

// Connecting an account again (Reconnect) replaces its login and makes it active.
export async function saveTikTokAccount(
  db: PrismaClient,
  key: Buffer,
  { ownerId, displayName, tokens }: { ownerId: string; displayName: string; tokens: TikTokTokens },
) {
  const existing = await db.ttAccount.findUnique({ where: { openId: tokens.openId } });
  if (existing && existing.ownerId !== ownerId) throw new Error("this TikTok account is already connected to another user");
  const sealed = sealedTokens(tokens, key);
  return db.ttAccount.upsert({
    where: { openId: tokens.openId },
    create: { ownerId, openId: tokens.openId, displayName, status: "active", ...sealed },
    update: { displayName, status: "active", ...sealed },
  });
}

// Keeps the history but forgets the login and cancels the account's scheduled posts with their jobs. An upload that has
// already started finishes.
export async function disconnectTikTokAccount(
  db: PrismaClient,
  queue: PublishQueue,
  { ownerId, ttAccountId }: { ownerId: string; ttAccountId: string },
) {
  const account = await db.ttAccount.findFirst({ where: { id: ttAccountId, ownerId } });
  if (!account) throw new UserError("account not found");
  const posts = await db.ttPost.findMany({ where: { ttAccountId, status: "scheduled" } });
  await db.ttPost.updateMany({ where: { ttAccountId, status: "scheduled" }, data: { status: "canceled" } });
  await db.ttAccount.update({
    where: { id: ttAccountId },
    data: { status: "revoked", refreshToken: null, accessToken: null, accessExpiresAt: null },
  });
  for (const post of posts) if (post.queueJobId) await queue.cancel(post.queueJobId);
}

// Refreshes running in this process, by account: TikTok may replace the refresh token, so two refreshes with the same
// one must not race.
const refreshing = new Map<string, Promise<string>>();

// The stored access token while it has time left, otherwise a fresh one, whose refresh token replaces the stored one. A
// refresh token TikTok turns down marks the account as needing reconnecting.
export async function tikTokAccessToken({
  db,
  key,
  app,
  ttAccountId,
  now,
  fetchFn = fetch,
}: {
  db: PrismaClient;
  key: Buffer;
  app: Pick<TikTokApp, "clientKey" | "clientSecret">;
  ttAccountId: string;
  now: Date;
  fetchFn?: typeof fetch;
}): Promise<string> {
  const account = await db.ttAccount.findUnique({ where: { id: ttAccountId } });
  if (!account?.refreshToken) throw new TikTokAuthError(`no login stored for TikTok account ${ttAccountId}`);
  if (account.accessToken && account.accessExpiresAt && account.accessExpiresAt.getTime() - now.getTime() > REFRESH_MARGIN_MS) {
    return openSecret(account.accessToken, key);
  }
  const running = refreshing.get(ttAccountId);
  if (running) return running;
  const refresh = (async () => {
    try {
      const tokens = await refreshTikTokTokens({ app, refreshToken: openSecret(account.refreshToken as string, key), now, fetchFn });
      await db.ttAccount.update({ where: { id: ttAccountId }, data: sealedTokens(tokens, key) });
      return tokens.accessToken;
    } catch (err) {
      if (err instanceof TikTokAuthError) {
        await db.ttAccount.update({ where: { id: ttAccountId }, data: { status: "reauth_required" } });
      }
      throw err;
    } finally {
      refreshing.delete(ttAccountId);
    }
  })();
  refreshing.set(ttAccountId, refresh);
  return refresh;
}
