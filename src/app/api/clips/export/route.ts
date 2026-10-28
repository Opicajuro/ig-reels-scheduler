import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getOwnerId } from "@/lib/owner";
import { writePostingZip } from "@/lib/clip-export";
import { s3ClipStore } from "@/lib/clip-store";
import { prisma } from "@/lib/prisma";

const MAX_CLIPS = 20;

function validTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

// Builds a ZIP with the chosen clips and a sheet giving each one's post time, title and description.
export async function POST(request: Request) {
  const ownerId = await getOwnerId();

  const body = (await request.json()) as {
    projectId?: string;
    clips?: Array<{ clipId?: string; postAt?: string }>;
    timeZone?: string;
  };
  const picks = body.clips ?? [];
  if (!body.projectId) return new Response("projectId is required", { status: 400 });
  if (picks.length === 0 || picks.length > MAX_CLIPS) {
    return new Response(`choose from 1 to ${MAX_CLIPS} clips`, { status: 400 });
  }
  if (!body.timeZone || !validTimeZone(body.timeZone)) return new Response("timeZone is not recognised", { status: 400 });
  const times = picks.map((pick) => new Date(pick.postAt ?? ""));
  if (times.some((time) => Number.isNaN(time.getTime()))) return new Response("every clip needs a valid post time", { status: 400 });

  const ids = picks.map((pick) => pick.clipId ?? "");
  const project = await prisma.clipProject.findFirst({ where: { id: body.projectId, ownerId: ownerId } });
  if (!project) return new Response("project not found", { status: 404 });
  const rows = await prisma.clip.findMany({ where: { id: { in: ids }, projectId: project.id } });
  if (rows.length !== ids.length) return new Response("clip not found", { status: 404 });

  const byId = new Map(rows.map((row) => [row.id, row]));
  const items = ids.map((id, index) => {
    const row = byId.get(id)!;
    return {
      name: row.name,
      storageKey: row.storageKey,
      title: row.title,
      description: row.description,
      postAt: times[index],
    };
  });

  const workDir = await mkdtemp(path.join(os.tmpdir(), "posting-"));
  try {
    const zipPath = await writePostingZip({
      store: s3ClipStore,
      workDir,
      projectName: project.name,
      items,
      timeZone: body.timeZone,
    });
    const zip = await readFile(zipPath);
    const fileName = `posting-${project.name.replace(/[^A-Za-z0-9 _-]/g, "_")}.zip`;
    return new Response(zip, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${fileName}"`,
      },
    });
  } catch (err) {
    return new Response(err instanceof Error ? err.message : "could not build the posting ZIP", { status: 500 });
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
