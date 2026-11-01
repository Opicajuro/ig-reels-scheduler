import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** @typedef {{ kind: "vulkan"; device: string } | { kind: "cpu" }} WhisperBackend */

// One second of silence as a 16 kHz mono 16-bit WAV, the format whisper-cli reads.
export function silentWav() {
  const samples = 16000;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + samples * 2, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24);
  wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(samples * 2, 40);
  return wav;
}

// whisper.cpp 1.9.5 logs the device it runs on as "whisper_backend_init_gpu: using Vulkan0 backend", and ggml-vulkan
// lists each device as "ggml_vulkan: 0 = AMD Radeon(TM) Graphics (AMD proprietary driver) | uma: 1 | fp16: 1 | ...",
// with the driver's name in the last brackets before "| uma:". Null when whisper did not pick a Vulkan device.
/** @param {string} stderr */
export function vulkanDevice(stderr) {
  const using = /^whisper_backend_init_gpu: using Vulkan(\d+) backend\r?$/m.exec(stderr);
  if (!using) return null;
  const listed = new RegExp(`^ggml_vulkan: ${using[1]} = (.+) \\([^()]*\\) \\| uma: `, "m").exec(stderr);
  return listed ? listed[1] : null;
}

/** @param {string} bin @param {string[]} args @returns {Promise<{ code: number | null; stderr: string }>} */
function run(bin, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true });
    let stderr = "";
    child.stdout.resume();
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

// Transcribes a second of silence with the Vulkan build and the real model, which only works when the graphics and
// their driver can run it. Without a usable card whisper-cli either fails or runs on the processor, and then only
// its log tells.
/** @param {{ vulkanBin: string; model: string }} paths @returns {Promise<WhisperBackend>} */
export async function detectWhisperBackend({ vulkanBin, model }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "whisper-backend-"));
  try {
    const wav = path.join(dir, "silence.wav");
    await writeFile(wav, silentWav());
    const test = await run(vulkanBin, ["-m", model, "-l", "en", "-f", wav]);
    const device = test.code === 0 ? vulkanDevice(test.stderr) : null;
    return device ? { kind: "vulkan", device } : { kind: "cpu" };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** @type {Promise<WhisperBackend> | undefined} */
let detected;

// Detected once per process, at the worker's first transcription; every one after that gets the same answer.
/** @param {{ vulkanBin: string; model: string }} paths */
export function whisperBackend(paths) {
  detected ??= detectWhisperBackend(paths);
  return detected;
}

// The binary that transcribes, and its thread count: the processor build uses every core, the Vulkan one runs on the
// graphics and keeps whisper-cli's default.
/** @param {WhisperBackend} backend @param {{ cpuBin: string; vulkanBin: string }} bins */
export function whisperCommand(backend, { cpuBin, vulkanBin }) {
  return backend.kind === "vulkan" ? { bin: vulkanBin, threads: null } : { bin: cpuBin, threads: os.cpus().length };
}
