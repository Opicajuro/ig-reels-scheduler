import { execFile } from "node:child_process";
import { UserError } from "./user-error";

export type Gpu = { name: string; vramMiB: number; driver: string };

export type GpuCheck = { found: true; gpu: Gpu; ready: boolean; recommended: boolean } | { found: false; reason: string };

// Wan 2.2 5B runs in 12 GB with ComfyUI moving weights between the card and memory; 16 GB is comfortable. A 16 GB
// card reports a little under 16384 MiB, so "recommended" starts at 15 GB.
export const MIN_VRAM_MIB = 12 * 1024;
export const RECOMMENDED_VRAM_MIB = 15 * 1024;

export const NVIDIA_SMI_ARGS = ["--query-gpu=name,memory.total,driver_version", "--format=csv,noheader,nounits"];

// One line per card, such as "NVIDIA GeForce RTX 4080, 16376, 566.03". The first card is the one ComfyUI uses.
export function parseNvidiaSmi(stdout: string): Gpu {
  const line = stdout.split(/\r?\n/).find((row) => row.trim() !== "");
  if (!line) throw new Error("nvidia-smi listed no graphics card");
  const parts = line.split(",").map((part) => part.trim());
  const vramMiB = Number(parts[1]);
  if (parts.length !== 3 || !parts[0] || !Number.isInteger(vramMiB) || !parts[2]) {
    throw new Error(`nvidia-smi printed something unexpected: ${line.trim()}`);
  }
  return { name: parts[0], vramMiB, driver: parts[2] };
}

export function judgeGpu(gpu: Gpu): GpuCheck {
  return { found: true, gpu, ready: gpu.vramMiB >= MIN_VRAM_MIB, recommended: gpu.vramMiB >= RECOMMENDED_VRAM_MIB };
}

// Asks the NVIDIA driver about the graphics card. nvidia-smi comes with the driver, so a PC without it has no NVIDIA
// card (or no driver for it).
export function checkGpu(): Promise<GpuCheck> {
  return new Promise((resolve) => {
    execFile("nvidia-smi", NVIDIA_SMI_ARGS, { timeout: 15_000, windowsHide: true }, (err, stdout, stderr) => {
      if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
        resolve({ found: false, reason: "No NVIDIA graphics card found: this PC has no NVIDIA driver (nvidia-smi is missing)." });
        return;
      }
      if (err) {
        const detail = (stderr || stdout || err.message).trim().split(/\r?\n/)[0];
        resolve({ found: false, reason: `The NVIDIA driver did not answer: ${detail}` });
        return;
      }
      try {
        resolve(judgeGpu(parseNvidiaSmi(stdout)));
      } catch (parseError) {
        resolve({ found: false, reason: (parseError as Error).message });
      }
    });
  });
}

export function formatVram(vramMiB: number): string {
  return `${(vramMiB / 1024).toFixed(1)} GB`;
}

// The pages hide the AI video controls when the graphics card is not good enough; a form sent anyway gets this answer.
export async function requireReadyGpu() {
  const check = await checkGpu();
  if (!check.found) throw new UserError(check.reason);
  if (!check.ready) throw new UserError("this graphics card has too little video memory for AI videos (12 GB at least)");
}
