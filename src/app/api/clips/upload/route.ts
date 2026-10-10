import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { createUploadProject } from "@/lib/clip-projects";
import { presignUpload } from "@/lib/storage";

// Starts an upload: creates the project and returns a link the browser sends the video to.
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return new Response("sign in required", { status: 401 });

  const body = (await request.json()) as { name?: string; extension?: string };
  try {
    const { projectId, sourceKey, contentType } = await createUploadProject({
      db: prisma,
      ownerId: session.user.id,
      name: body.name ?? "",
      extension: body.extension ?? "",
    });
    const uploadUrl = await presignUpload(sourceKey, contentType);
    return Response.json({ projectId, uploadUrl, contentType }, { status: 201 });
  } catch (err) {
    return new Response(err instanceof Error ? err.message : "could not start the upload", { status: 400 });
  }
}
