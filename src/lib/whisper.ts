import type { PrismaClient } from "@/generated/prisma/client";
import { transcribeToWords } from "@/clip-engine/transcribe.js";
import { whisperBackend, whisperCommand } from "@/clip-engine/whisper-backend.js";
import { requireEnv } from "./env";
import { recordWhisperBackend } from "./video-encoding";

let recorded: Promise<void> | undefined;

// Transcribes with the whisper.cpp build this worker found at its first transcription: the Vulkan one when it runs on
// the graphics, otherwise the processor one. That first answer is written down for Settings.
export async function transcribeWithWhisper(db: PrismaClient, mediaPath: string, workDir: string) {
  const model = requireEnv("WHISPER_MODEL");
  const bins = { cpuBin: requireEnv("WHISPER_CPU"), vulkanBin: requireEnv("WHISPER_VULKAN") };
  const backend = await whisperBackend({ vulkanBin: bins.vulkanBin, model });
  recorded ??= recordWhisperBackend(db, backend).catch((err) => {
    recorded = undefined;
    throw err;
  });
  await recorded;
  const { bin, threads } = whisperCommand(backend, bins);
  return transcribeToWords({ mediaPath, workDir, whisperBin: bin, threads, model });
}
