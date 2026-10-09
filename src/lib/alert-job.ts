import type { PrismaClient } from "@/generated/prisma/client";
import { buildAlerts } from "./alerts";

export async function sendOwnerAlerts({
  db,
  now,
  send,
}: {
  db: PrismaClient;
  now: Date;
  send: (message: { to: string; subject: string; text: string }) => Promise<void>;
}): Promise<number> {
  const users = await db.user.findMany({
    include: { accounts: { include: { token: true } } },
  });

  let sent = 0;
  for (const user of users) {
    const failedPosts = await db.post.findMany({
      where: { status: "failed", account: { ownerId: user.id } },
      select: { id: true, lastError: true },
    });
    const alerts = buildAlerts({
      failedPosts,
      tokens: user.accounts.flatMap((account) =>
        account.token ? [{ username: account.username, expiresAt: account.token.expiresAt }] : [],
      ),
      accounts: user.accounts.map((account) => ({ username: account.username, status: account.status })),
      now,
    });
    if (alerts.length === 0) continue;

    await send({
      to: user.email,
      subject: `Scheduler alerts (${alerts.length})`,
      text: alerts.join("\n"),
    });
    sent++;
  }
  return sent;
}
