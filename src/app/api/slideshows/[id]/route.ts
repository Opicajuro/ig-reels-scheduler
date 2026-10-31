import { getOwnerId } from "@/lib/owner";
import { prisma } from "@/lib/prisma";

// A slideshow's state and current step, which the Clips page polls while its script is written or it is made.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ownerId = await getOwnerId();
  const { id } = await params;

  const job = await prisma.slideshowJob.findFirst({
    where: { id, ownerId },
    select: { status: true, step: true, error: true },
  });
  if (!job) return new Response("slideshow not found", { status: 404 });
  return Response.json(job);
}
