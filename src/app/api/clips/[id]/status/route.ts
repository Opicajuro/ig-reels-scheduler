import { getOwnerId } from "@/lib/owner";
import { prisma } from "@/lib/prisma";

// A project's state and current render step, which the project page polls while clips are being made.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ownerId = await getOwnerId();
  const { id } = await params;

  const project = await prisma.clipProject.findFirst({
    where: { id, ownerId },
    select: { status: true, renderStep: true, error: true },
  });
  if (!project) return new Response("project not found", { status: 404 });
  return Response.json(project);
}
