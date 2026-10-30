import type { PrismaClient } from "@/generated/prisma/client";
import type { VideoEncoder } from "@/clip-engine/encoder.js";

const VIDEO_ENCODING_ID = 1;

export const VIDEO_ENCODER_LABELS: Record<VideoEncoder, string> = {
  nvenc: "NVIDIA GPU (NVENC)",
  x264: "CPU (x264)",
};

// Written by the worker at each start, so the web app can show which encoder makes the videos.
export async function recordVideoEncoder(db: PrismaClient, encoder: VideoEncoder) {
  await db.videoEncoding.upsert({
    where: { id: VIDEO_ENCODING_ID },
    create: { id: VIDEO_ENCODING_ID, encoder },
    update: { encoder },
  });
}

// Null until the worker has started once.
export function getVideoEncoding(db: PrismaClient) {
  return db.videoEncoding.findUnique({ where: { id: VIDEO_ENCODING_ID } });
}
