import { getOwnerId } from "@/lib/owner";
import { prisma } from "@/lib/prisma";

// An AI video's state and current step, which /ai polls while it is being made.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ownerId = await getOwnerId();
  const { id } = await params;

  const job = await prisma.aiVideoJob.findFirst({
    where: { id, ownerId },
    select: { status: true, step: true, error: true },
  });
  if (!job) return new Response("AI video not found", { status: 404 });
  return Response.json(job);
}
