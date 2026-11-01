import { afterEach, beforeEach, test } from "vitest";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectWhisperBackend, silentWav, vulkanDevice, whisperCommand } from "./whisper-backend.js";

// What whisper-cli 1.9.5's Vulkan build logs on a PC with AMD graphics, cut to the lines that matter here.
const VULKAN_LOG = [
  "ggml_vulkan: Found 1 Vulkan devices:",
  "ggml_vulkan: 0 = AMD Radeon(TM) 780M Graphics (AMD proprietary driver) | uma: 1 | fp16: 1 | bf16: 0 | fp4: 0 | warp size: 64 | shared memory: 32768 | int dot: 1 | matrix cores: none",
  "whisper_init_with_params_no_state: use gpu    = 1",
  "whisper_backend_init_gpu: device 0: CPU (type: 0)",
  "whisper_backend_init_gpu: device 1: Vulkan0 (type: 2)",
  "whisper_backend_init_gpu: found GPU device 1: Vulkan0 (type: 2, cnt: 0)",
  "whisper_backend_init_gpu: using Vulkan0 backend",
  "",
].join("\n");
// The same build where the Vulkan backend did not load: whisper runs on the processor.
const CPU_LOG = [
  "whisper_init_with_params_no_state: use gpu    = 1",
  "whisper_backend_init_gpu: device 0: CPU (type: 0)",
  "whisper_backend_init_gpu: no GPU found",
  "",
].join("\n");

let dir;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "fake-whisper-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// A whisper-cli that prints `log` to stderr and exits with `exit`, after noting its arguments and the size of the WAV
// it was given.
function fakeWhisper(log, exit) {
  writeFileSync(path.join(dir, "log.txt"), log);
  const file = path.join(dir, "whisper-cli");
  writeFileSync(
    file,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$@" > '${dir}/args.txt'`,
      'while [ $# -gt 0 ]; do case "$1" in -f) wc -c < "$2" > ' + `'${dir}/wav-size.txt'` + "; shift;; esac; shift; done",
      `cat '${dir}/log.txt' >&2`,
      `exit ${exit}`,
      "",
    ].join("\n"),
  );
  chmodSync(file, 0o755);
  return file;
}

test("the Vulkan build is used when it transcribes a second of silence on a Vulkan device", async () => {
  const vulkanBin = fakeWhisper(VULKAN_LOG, 0);
  const backend = await detectWhisperBackend({ vulkanBin, model: "ggml-large-v3-turbo-q5_0.bin" });
  assert.deepEqual(backend, { kind: "vulkan", device: "AMD Radeon(TM) 780M Graphics" });

  const args = readFileSync(path.join(dir, "args.txt"), "utf8").trim().split("\n");
  assert.equal(args[args.indexOf("-m") + 1], "ggml-large-v3-turbo-q5_0.bin");
  assert.equal(Number(readFileSync(path.join(dir, "wav-size.txt"), "utf8").trim()), 44 + 16000 * 2);
});

test("the processor build is used when the Vulkan build fails", async () => {
  const vulkanBin = fakeWhisper(VULKAN_LOG, 1);
  assert.deepEqual(await detectWhisperBackend({ vulkanBin, model: "model.bin" }), { kind: "cpu" });
});

test("the processor build is used when the Vulkan build works but names no Vulkan device", async () => {
  const vulkanBin = fakeWhisper(CPU_LOG, 0);
  assert.deepEqual(await detectWhisperBackend({ vulkanBin, model: "model.bin" }), { kind: "cpu" });
});

test("a Vulkan whisper that cannot be started is an error, not the processor", async () => {
  await assert.rejects(detectWhisperBackend({ vulkanBin: path.join(dir, "missing"), model: "model.bin" }), /ENOENT/);
});

test("vulkanDevice names the device whisper uses, from Windows' CRLF log too", () => {
  const twoDevices = [
    "ggml_vulkan: 0 = Intel(R) UHD Graphics (Intel Corporation) | uma: 1 | fp16: 1 | bf16: 0 | warp size: 32",
    "ggml_vulkan: 1 = NVIDIA GeForce RTX 4060 Laptop GPU (NVIDIA) | uma: 0 | fp16: 1 | bf16: 1 | warp size: 32",
    "whisper_backend_init_gpu: using Vulkan1 backend",
    "",
  ].join("\r\n");
  assert.equal(vulkanDevice(twoDevices), "NVIDIA GeForce RTX 4060 Laptop GPU");
  assert.equal(vulkanDevice(VULKAN_LOG.replace(/^ggml_vulkan: 0 = .*$/m, "")), null);
});

test("silentWav is one second of 16 kHz mono 16-bit PCM", () => {
  const wav = silentWav();
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.readUInt32LE(40), 16000 * 2);
});

test("whisperCommand gives the processor build every core and the Vulkan build no thread count", () => {
  const bins = { cpuBin: "cpu/whisper-cli", vulkanBin: "vulkan/whisper-cli" };
  assert.deepEqual(whisperCommand({ kind: "vulkan", device: "GPU" }, bins), { bin: "vulkan/whisper-cli", threads: null });
  assert.deepEqual(whisperCommand({ kind: "cpu" }, bins), { bin: "cpu/whisper-cli", threads: os.cpus().length });
});
