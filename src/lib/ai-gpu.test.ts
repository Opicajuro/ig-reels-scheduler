import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { aiGpuShortfall, checkGpu, judgeGpu, parseNvidiaSmi } from "./ai-gpu";

describe("parseNvidiaSmi", () => {
  it("reads the name, video memory and driver of the first card", () => {
    expect(parseNvidiaSmi("NVIDIA GeForce RTX 4080, 16376, 566.03\r\nNVIDIA GeForce GTX 1050, 2048, 566.03\r\n")).toEqual({
      name: "NVIDIA GeForce RTX 4080",
      vramMiB: 16376,
      driver: "566.03",
    });
  });

  it("fails on empty or unexpected output", () => {
    expect(() => parseNvidiaSmi("\n")).toThrow("no graphics card");
    expect(() => parseNvidiaSmi("No devices were found")).toThrow("unexpected");
    expect(() => parseNvidiaSmi("NVIDIA GeForce RTX 4080, [N/A], 566.03")).toThrow("unexpected");
  });
});

describe("judgeGpu", () => {
  it("needs 12 GB and recommends 16 GB", () => {
    const card = (vramMiB: number) => ({ name: "card", vramMiB, driver: "1" });
    expect(judgeGpu(card(8192))).toMatchObject({ ready: false, recommended: false });
    expect(judgeGpu(card(12282))).toMatchObject({ ready: false });
    expect(judgeGpu(card(12288))).toMatchObject({ ready: true, recommended: false });
    expect(judgeGpu(card(16376))).toMatchObject({ ready: true, recommended: true });
  });
});

describe("aiGpuShortfall", () => {
  it("adds nothing to the note when there is simply no NVIDIA card", () => {
    expect(aiGpuShortfall({ found: false, noNvidia: true, reason: "No NVIDIA graphics card found" })).toBeNull();
  });

  it("gives the driver's problem or the card's video memory otherwise", () => {
    expect(aiGpuShortfall({ found: false, noNvidia: false, reason: "The NVIDIA driver did not answer: x" })).toBe(
      "The NVIDIA driver did not answer: x",
    );
    expect(aiGpuShortfall(judgeGpu({ name: "NVIDIA GeForce RTX 3060 Ti", vramMiB: 8192, driver: "1" }))).toBe(
      "The NVIDIA GeForce RTX 3060 Ti here has 8.0 GB of video memory.",
    );
  });

  it("fails for a card that is good enough", () => {
    expect(() => aiGpuShortfall(judgeGpu({ name: "card", vramMiB: 16376, driver: "1" }))).toThrow("good enough");
  });
});

describe("checkGpu", () => {
  let dir: string;
  let path0: string | undefined;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "ai-gpu-test-"));
    path0 = process.env.PATH;
  });

  afterAll(async () => {
    process.env.PATH = path0;
    await rm(dir, { recursive: true, force: true });
  });

  it("says there is no NVIDIA card when nvidia-smi is missing", async () => {
    process.env.PATH = path.join(dir, "empty");
    expect(await checkGpu()).toEqual({
      found: false,
      noNvidia: true,
      reason: expect.stringContaining("No NVIDIA graphics card found"),
    });
  });

  it("runs nvidia-smi with the query and reads its answer", async () => {
    const script = path.join(dir, "nvidia-smi");
    await writeFile(script, '#!/bin/sh\n[ "$1 $2" = "--query-gpu=name,memory.total,driver_version --format=csv,noheader,nounits" ] || exit 9\necho "NVIDIA GeForce RTX 4080, 16376, 566.03"\n');
    await chmod(script, 0o755);
    process.env.PATH = dir;
    expect(await checkGpu()).toEqual({
      found: true,
      gpu: { name: "NVIDIA GeForce RTX 4080", vramMiB: 16376, driver: "566.03" },
      ready: true,
      recommended: true,
    });
  });

  it("reports a driver that fails", async () => {
    const script = path.join(dir, "nvidia-smi");
    await writeFile(script, "#!/bin/sh\necho 'NVIDIA-SMI has failed because it could not communicate with the NVIDIA driver.' >&2\nexit 9\n");
    await chmod(script, 0o755);
    process.env.PATH = dir;
    expect(await checkGpu()).toEqual({
      found: false,
      noNvidia: false,
      reason: expect.stringContaining("could not communicate with the NVIDIA driver"),
    });
  });
});
