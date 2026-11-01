import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";

const FIXTURE = fileURLToPath(new URL("../clip-engine/whisper-words.fixture.json", import.meta.url));
const VULKAN_LOG = [
  "ggml_vulkan: Found 1 Vulkan devices:",
  "ggml_vulkan: 0 = AMD Radeon(TM) 780M Graphics (AMD proprietary driver) | uma: 1 | fp16: 1 | bf16: 0 | warp size: 64",
  "whisper_backend_init_gpu: using Vulkan0 backend",
].join("\n");

let dir: string;
let media: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "whisper-lib-test-"));
  media = path.join(dir, "speech.wav");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=duration=1", media]);
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

// A whisper-cli named `name` that prints `log` to stderr and exits with `exit`. A run with -of (a transcription, not
// the detection) notes its arguments in <name>-args.txt and writes the fixture's words where -of says.
function fakeWhisper(name: string, log: string, exit = 0) {
  writeFileSync(path.join(dir, `${name}.log`), log);
  const file = path.join(dir, name);
  writeFileSync(
    file,
    [
      "#!/bin/sh",
      `args=$(printf '%s\\n' "$@")`,
      "prefix=",
      "while [ $# -gt 0 ]; do",
      '  case "$1" in -of) prefix="$2"; shift;; esac',
      "  shift",
      "done",
      'if [ -n "$prefix" ]; then',
      `  printf '%s\\n' "$args" > '${dir}/${name}-args.txt'`,
      `  cp '${FIXTURE}' "$prefix.json"`,
      "fi",
      `cat '${dir}/${name}.log' >&2`,
      `exit ${exit}`,
      "",
    ].join("\n"),
  );
  chmodSync(file, 0o755);
  return file;
}

function fakeDb() {
  const update = vi.fn(async () => ({}));
  return { db: { videoEncoding: { update } } as unknown as PrismaClient, update };
}

function transcriptionArgs(name: string) {
  const file = path.join(dir, `${name}-args.txt`);
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n") : null;
}

describe("transcribeWithWhisper", () => {
  it("transcribes with the Vulkan build, without a thread count, when it runs on a Vulkan device", async () => {
    vi.stubEnv("WHISPER_CPU", fakeWhisper("cpu", ""));
    vi.stubEnv("WHISPER_VULKAN", fakeWhisper("vulkan", VULKAN_LOG));
    vi.stubEnv("WHISPER_MODEL", "model.bin");
    const { db, update } = fakeDb();
    const { transcribeWithWhisper } = await import("./whisper");

    const words = await transcribeWithWhisper(db, media, dir);
    await transcribeWithWhisper(db, media, dir);

    expect(words).toHaveLength(22);
    expect(transcriptionArgs("cpu")).toBeNull();
    const args = transcriptionArgs("vulkan")!;
    expect(args).not.toContain("-t");
    expect(args).toEqual(expect.arrayContaining(["-m", "model.bin", "-l", "en", "-ml", "1", "-sow", "-oj"]));
    // Found and written down once per worker.
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { transcriber: "vulkan", transcriberDevice: "AMD Radeon(TM) 780M Graphics" },
    });
  });

  it("transcribes with the processor build on every core when the Vulkan build fails", async () => {
    vi.stubEnv("WHISPER_CPU", fakeWhisper("cpu", ""));
    vi.stubEnv("WHISPER_VULKAN", fakeWhisper("vulkan", VULKAN_LOG, 1));
    vi.stubEnv("WHISPER_MODEL", "model.bin");
    const { db, update } = fakeDb();
    const { transcribeWithWhisper } = await import("./whisper");

    await transcribeWithWhisper(db, media, dir);

    expect(transcriptionArgs("vulkan")).toBeNull();
    const args = transcriptionArgs("cpu")!;
    expect(args[args.indexOf("-t") + 1]).toBe(String(os.cpus().length));
    expect(args).toEqual(expect.arrayContaining(["-m", "model.bin", "-l", "en", "-ml", "1", "-sow", "-oj"]));
    expect(update).toHaveBeenCalledWith({ where: { id: 1 }, data: { transcriber: "cpu", transcriberDevice: null } });
  });
});
