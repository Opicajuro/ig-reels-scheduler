import { prisma } from "./prisma";

// Localirs runs for one person on their own PC, so there is no sign-in: everything belongs to the one owner, the
// first user row. Setup creates it on a new install; an existing install keeps the user that signed in before.
export async function getOwnerId(): Promise<string> {
  const owner = await prisma.user.findFirst({ orderBy: { createdAt: "asc" }, select: { id: true } });
  if (!owner) throw new Error("Localirs has no owner yet. Run the installer again to finish setup.");
  return owner.id;
}
