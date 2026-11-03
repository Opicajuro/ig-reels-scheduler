import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { getOwnerId } from "@/lib/owner";
import { musicFile } from "@/lib/music-files";
import { TRACKS } from "@/lib/music-library";

const TYPES: Record<string, string> = { ".ogg": "audio/ogg", ".mp3": "audio/mpeg" };

// A built-in music track or sound effect, for the preview player. A Range request gets that part, so the player can
// seek.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  await getOwnerId();
  const { id } = await params;
  const track = TRACKS.find((item) => item.id === id);
  if (!track) return new Response("track not found", { status: 404 });
  const file = musicFile(track.id);
  const size = (await stat(file)).size;
  const type = TYPES[track.file.slice(track.file.lastIndexOf("."))];
  if (!type) throw new Error(`no media type for ${track.file}`);

  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("range") ?? "");
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : size - Number(range[2]);
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start < 0 || start > end) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    const body = Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream;
    return new Response(body, {
      status: 206,
      headers: {
        "Content-Type": type,
        "Content-Length": String(end - start + 1),
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Accept-Ranges": "bytes",
      },
    });
  }
  const body = Readable.toWeb(createReadStream(file)) as ReadableStream;
  return new Response(body, { headers: { "Content-Type": type, "Content-Length": String(size), "Accept-Ranges": "bytes" } });
}
