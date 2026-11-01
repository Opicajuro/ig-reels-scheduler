import { getOwnerId } from "@/lib/owner";
import { prisma } from "@/lib/prisma";
import { listQueue } from "@/lib/work-queue";

// Everything running or waiting, which the Queue page polls.
export async function GET() {
  return Response.json(await listQueue({ db: prisma, ownerId: await getOwnerId(), now: new Date() }));
}
