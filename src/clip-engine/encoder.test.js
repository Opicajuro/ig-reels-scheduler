import { afterEach, beforeEach, test, vi } from "vitest";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectVideoEncoder, listsAmf, listsNvenc, videoEncoderArgs } from "./encoder.js";

const ENCODER_LIST = `Encoders:
 V..... = Video
 ------
 V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (codec h264)
 V....D h264_amf             AMD AMF H.264 Encoder (codec h264)
 V....D h264_nvenc           NVIDIA NVENC H.264 encoder (codec h264)
 A....D aac                  AAC (Advanced Audio Coding)
`;
const X264_ONLY_LIST = ENCODER_LIST.split("\n").filter((line) => !/h264_(nvenc|amf)/.test(line)).join("\n");

let binDir;
let originalPath;

beforeEach(() => {
  binDir = mkdtempSync(path.join(os.tmpdir(), "fake-ffmpeg-"));
  originalPath = process.env.PATH;
});

afterEach(() => {
  process.env.PATH = originalPath;
  rmSync(binDir, { recursive: true, force: true });
});

// Puts an ffmpeg first on PATH that prints `list` for -encoders, exits with `nvencExit` or `amfExit` for the test
// encodes and notes their order in tests.txt, and writes the arguments of any other run to args.txt.
function fakeFfmpeg({ list, listExit = 0, nvencExit = 1, amfExit = 1 }) {
  writeFileSync(path.join(binDir, "list.txt"), list);
  const script = `#!/bin/sh
case "$*" in
  *-encoders*) cat "${binDir}/list.txt"; exit ${listExit} ;;
  *color=c=black*h264_nvenc*) echo nvenc >> "${binDir}/tests.txt"; exit ${nvencExit} ;;
  *color=c=black*h264_amf*) echo amf >> "${binDir}/tests.txt"; exit ${amfExit} ;;
  *) printf '%s\\n' "$@" > "${binDir}/args.txt" ;;
esac
`;
  const file = path.join(binDir, "ffmpeg");
  writeFileSync(file, script);
  chmodSync(file, 0o755);
  process.env.PATH = `${binDir}${path.delimiter}${originalPath}`;
}

function testEncodes() {
  return existsSync(path.join(binDir, "tests.txt"))
    ? readFileSync(path.join(binDir, "tests.txt"), "utf8").trim().split("\n")
    : [];
}

test("listsNvenc finds h264_nvenc in the encoder list", () => {
  assert.equal(listsNvenc(ENCODER_LIST), true);
  assert.equal(listsNvenc(X264_ONLY_LIST), false);
  assert.equal(listsNvenc(" V....D hevc_nvenc           NVIDIA NVENC hevc encoder (codec hevc)\n"), false);
});

test("listsAmf finds h264_amf in the encoder list", () => {
  assert.equal(listsAmf(ENCODER_LIST), true);
  assert.equal(listsAmf(X264_ONLY_LIST), false);
  assert.equal(listsAmf(" V....D hevc_amf             AMD AMF HEVC encoder (codec hevc)\n"), false);
});

test("detectVideoEncoder picks NVENC first when ffmpeg lists it and the test encode works", async () => {
  fakeFfmpeg({ list: ENCODER_LIST, nvencExit: 0, amfExit: 0 });
  assert.equal(await detectVideoEncoder(), "nvenc");
  assert.deepEqual(testEncodes(), ["nvenc"]);
});

test("detectVideoEncoder picks AMF when the NVENC test encode fails, as on a PC with AMD graphics", async () => {
  fakeFfmpeg({ list: ENCODER_LIST, nvencExit: 1, amfExit: 0 });
  assert.equal(await detectVideoEncoder(), "amf");
  assert.deepEqual(testEncodes(), ["nvenc", "amf"]);
});

test("detectVideoEncoder picks x264 when both test encodes fail", async () => {
  fakeFfmpeg({ list: ENCODER_LIST, nvencExit: 1, amfExit: 1 });
  assert.equal(await detectVideoEncoder(), "x264");
  assert.deepEqual(testEncodes(), ["nvenc", "amf"]);
});

test("detectVideoEncoder picks x264 without a test encode when ffmpeg has neither NVENC nor AMF", async () => {
  fakeFfmpeg({ list: X264_ONLY_LIST, nvencExit: 0, amfExit: 0 });
  assert.equal(await detectVideoEncoder(), "x264");
  assert.deepEqual(testEncodes(), []);
});

test("detectVideoEncoder fails when ffmpeg cannot list its encoders", async () => {
  fakeFfmpeg({ list: "", listExit: 1 });
  await assert.rejects(detectVideoEncoder(), /ffmpeg -encoders exited with 1/);
});

test("videoEncoderArgs gives x264 high profile yuv420p capped at 20 Mbps", () => {
  assert.deepEqual(videoEncoderArgs("x264", 21), [
    "-c:v", "libx264", "-profile:v", "high", "-preset", "veryfast", "-crf", "21",
    "-maxrate", "20M", "-bufsize", "40M", "-pix_fmt", "yuv420p",
  ]);
});

test("videoEncoderArgs gives NVENC high profile yuv420p constant quality capped at 20 Mbps", () => {
  assert.deepEqual(videoEncoderArgs("nvenc", 20), [
    "-c:v", "h264_nvenc", "-profile:v", "high", "-preset", "p5", "-tune", "hq", "-rc", "vbr", "-cq", "20", "-b:v", "0",
    "-maxrate", "20M", "-bufsize", "40M", "-pix_fmt", "yuv420p",
  ]);
});

test("videoEncoderArgs gives AMF high profile yuv420p constant quality (QVBR) capped at 20 Mbps", () => {
  assert.deepEqual(videoEncoderArgs("amf", 20), [
    "-c:v", "h264_amf", "-profile:v", "high", "-usage", "transcoding", "-quality", "quality",
    "-rc", "qvbr", "-qvbr_quality_level", "20", "-preanalysis", "1",
    "-maxrate", "20M", "-bufsize", "40M", "-pix_fmt", "yuv420p",
  ]);
});

test("renderClip encodes with NVENC when the detection found it", async () => {
  fakeFfmpeg({ list: ENCODER_LIST, nvencExit: 0 });
  vi.resetModules();
  const { renderClip } = await import("./ffmpeg.js");
  await renderClip({ input: "in.mp4", output: "out.mp4", start: 0, length: 15, overlay: null });
  const args = readFileSync(path.join(binDir, "args.txt"), "utf8").trim().split("\n");
  const at = args.indexOf("-c:v");
  assert.deepEqual(args.slice(at, at + videoEncoderArgs("nvenc", 21).length), videoEncoderArgs("nvenc", 21));
});

// With this PC's real ffmpeg: x264 without a usable NVIDIA card, NVENC with one.
test("renderClip makes High profile yuv420p H.264 with the encoder this PC has", async () => {
  const output = path.join(binDir, "clip.mp4");
  const input = path.join(binDir, "source.mp4");
  execFileSync("ffmpeg", [
    "-v", "error", "-y",
    "-f", "lavfi", "-i", "testsrc=duration=2:size=640x360:rate=30",
    "-c:v", "mpeg4", input,
  ]);
  vi.resetModules();
  const { renderClip } = await import("./ffmpeg.js");
  await renderClip({ input, output, start: 0, length: 1, overlay: null });
  const probe = JSON.parse(
    execFileSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", output], { encoding: "utf8" }),
  );
  const video = probe.streams.find((stream) => stream.codec_type === "video");
  assert.equal(video.codec_name, "h264");
  assert.equal(video.profile, "High");
  assert.equal(video.pix_fmt, "yuv420p");
});
