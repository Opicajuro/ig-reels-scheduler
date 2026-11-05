import { getOwnerId } from "@/lib/owner";
import { prisma } from "@/lib/prisma";

// A project's state, current render step, start time and finished clips, which the project page polls while clips
// are being made, the step of each clip whose captions are being re-rendered, and of each clip whose title the
// script writer is writing.
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
      clips: {
        where: { OR: [{ recaptionId: { not: null } }, { aiWriteId: { not: null } }] },
        select: { id: true, recaptionId: true, recaptionStep: true, aiWriteId: true, aiWriteStep: true },
      },
    },
  });
  if (!project) return new Response("project not found", { status: 404 });
  const { _count, clips, ...state } = project;
  return Response.json({
    ...state,
    clipsDone: _count.clips,
    recaptions: clips.flatMap((clip) => (clip.recaptionId ? [{ id: clip.id, step: clip.recaptionStep }] : [])),
    writers: clips.flatMap((clip) => (clip.aiWriteId ? [{ id: clip.id, step: clip.aiWriteStep }] : [])),
  });
}
