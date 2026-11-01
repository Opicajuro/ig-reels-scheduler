import { prisma } from "@/lib/prisma";
import { getSlideshowEngine, isSlideshowEngineId } from "@/lib/slideshow-engines";

// A slideshow engine's install state, which Settings polls while it installs.
export async function GET(_request: Request, { params }: { params: Promise<{ engine: string }> }) {
  const { engine } = await params;
  if (!isSlideshowEngineId(engine)) return new Response("unknown engine", { status: 404 });
  const { status, step, percent, error } = await getSlideshowEngine(prisma, engine);
  return Response.json({ status, step, percent, error });
}
