import { getAiEngine } from "@/lib/ai-engine";
import { prisma } from "@/lib/prisma";

// The AI engine's install state, which /ai polls while it installs.
export async function GET() {
  const { status, step, percent, error } = await getAiEngine(prisma);
  return Response.json({ status, step, percent, error });
}
