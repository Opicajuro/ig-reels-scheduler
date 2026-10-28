import { startImageUpload } from "@/lib/ai-video";
import { presignUpload } from "@/lib/storage";
import { UserError } from "@/lib/user-error";

// Starts the upload of an AI video's start picture: returns the storage key and a link the browser sends it to.
export async function POST(request: Request) {
  const body = (await request.json()) as { extension?: string };
  try {
    const { key, contentType } = startImageUpload(body.extension ?? "");
    const uploadUrl = await presignUpload(key, contentType);
    return Response.json({ key, uploadUrl, contentType }, { status: 201 });
  } catch (err) {
    if (err instanceof UserError) return new Response(err.message, { status: 400 });
    throw err;
  }
}
