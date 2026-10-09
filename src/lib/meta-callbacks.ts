import type { PrismaClient } from "@/generated/prisma/client";

export async function revokeAccount(db: PrismaClient, igUserId: string) {
  await db.igAccount.updateMany({
    where: { igUserId },
    data: { status: "revoked" },
  });
  await db.post.updateMany({
    where: { account: { igUserId }, status: "scheduled" },
    data: { status: "canceled" },
  });
}

export async function purgeUserData(db: PrismaClient, igUserId: string) {
  await db.igAccount.deleteMany({ where: { igUserId } });
}
