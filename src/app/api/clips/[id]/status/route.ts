import { getOwnerId } from "@/lib/owner";
import { prisma } from "@/lib/prisma";

// A project's state, current render step, start time and finished clips, which the project page polls while clips
// are being made, and the step of each clip whose captions are being re-rendered.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ownerId = await getOwnerId();
  const { id } = await params;

  const project = await prisma.clipProject.findFirst({
    where: { id, ownerId },
    select: {
      status: true,
      renderStep: true,
      renderStartedAt: true,
      error: true,
      _count: { select: { clips: true } },
      clips: { where: { recaptionId: { not: null } }, select: { id: true, recaptionStep: true } },
    },
  });
  if (!project) return new Response("project not found", { status: 404 });
  const { _count, clips, ...state } = project;
  return Response.json({ ...state, clipsDone: _count.clips, recaptions: clips.map((clip) => ({ id: clip.id, step: clip.recaptionStep })) });
}
