import { getOwnerId } from "@/lib/owner";
import { prisma } from "@/lib/prisma";
import { createUploadProject } from "@/lib/clip-projects";
import { presignUpload } from "@/lib/storage";

// Starts an upload: creates the project and returns a link the browser sends the video to.
export async function POST(request: Request) {
  const ownerId = await getOwnerId();

  const body = (await request.json()) as { name?: string; extension?: string };
  try {
    const { projectId, sourceKey, contentType } = await createUploadProject({
      db: prisma,
      ownerId: ownerId,
      name: body.name ?? "",
      extension: body.extension ?? "",
    });
    const uploadUrl = await presignUpload(sourceKey, contentType);
    return Response.json({ projectId, uploadUrl, contentType }, { status: 201 });
  } catch (err) {
    return new Response(err instanceof Error ? err.message : "could not start the upload", { status: 400 });
  }
}
