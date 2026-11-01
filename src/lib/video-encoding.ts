import type { PrismaClient } from "@/generated/prisma/client";
import type { VideoEncoder } from "@/clip-engine/encoder.js";
import type { WhisperBackend } from "@/clip-engine/whisper-backend.js";

const VIDEO_ENCODING_ID = 1;

export const VIDEO_ENCODER_LABELS: Record<VideoEncoder, string> = {
  nvenc: "NVIDIA GPU (NVENC)",
  amf: "AMD graphics (AMF)",
  x264: "CPU (x264)",
};

// Written by the worker at each start, so the web app can show which encoder makes the videos. The whisper build is
// found again at this run's first transcription, so the last run's answer is cleared.
export async function recordVideoEncoder(db: PrismaClient, encoder: VideoEncoder) {
  await db.videoEncoding.upsert({
    where: { id: VIDEO_ENCODING_ID },
    create: { id: VIDEO_ENCODING_ID, encoder },
    update: { encoder, transcriber: null, transcriberDevice: null },
  });
}

// Written by the worker at its first transcription since it started, which comes after recordVideoEncoder.
export async function recordWhisperBackend(db: PrismaClient, backend: WhisperBackend) {
  await db.videoEncoding.update({
    where: { id: VIDEO_ENCODING_ID },
    data: { transcriber: backend.kind, transcriberDevice: backend.kind === "vulkan" ? backend.device : null },
  });
}

// "Graphics (Vulkan): AMD Radeon(TM) Graphics", or "Processor".
export function transcriberLabel(encoding: { transcriber: "vulkan" | "cpu"; transcriberDevice: string | null }) {
  if (encoding.transcriber === "cpu") return "Processor";
  if (!encoding.transcriberDevice) throw new Error("The Vulkan transcriber was recorded without its device");
  return `Graphics (Vulkan): ${encoding.transcriberDevice}`;
}

// Null until the worker has started once.
export function getVideoEncoding(db: PrismaClient) {
  return db.videoEncoding.findUnique({ where: { id: VIDEO_ENCODING_ID } });
}
