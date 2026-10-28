import type { PrismaClient } from "@/generated/prisma/client";
import { buildAlerts } from "./alerts";

// The daily email to the owner listing what needs attention. Returns whether there was anything to send.
export async function sendOwnerAlerts({
  db,
  ownerId,
  now,
  send,
}: {
  db: PrismaClient;
  ownerId: string;
  now: Date;
  send: (message: { subject: string; text: string }) => Promise<void>;
}): Promise<boolean> {
  const [failedPosts, accounts] = await Promise.all([
    db.post.findMany({ where: { status: "failed", account: { ownerId } }, select: { id: true, lastError: true } }),
    db.igAccount.findMany({ where: { ownerId }, include: { token: true } }),
  ]);
  const alerts = buildAlerts({
    failedPosts,
    tokens: accounts.flatMap((account) =>
      account.token ? [{ username: account.username, expiresAt: account.token.expiresAt }] : [],
    ),
    accounts: accounts.map((account) => ({ username: account.username, status: account.status })),
    now,
  });
  if (alerts.length === 0) return false;

  await send({ subject: `Scheduler alerts (${alerts.length})`, text: alerts.join("\n") });
  return true;
}
