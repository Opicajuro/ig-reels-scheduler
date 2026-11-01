import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { kokoroSpeaker } from "./voice";

// Kokoro itself runs on the installed PC: its model ships with the installer. Here only its loading is checked.
describe("kokoroSpeaker", () => {
  it("loads the model from its folder only, never from the internet", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "voice-test-"));
    try {
      const speak = kokoroSpeaker(path.join(dir, "Kokoro-82M-v1.0-ONNX"));
      await expect(speak(["Hello."], "af_heart", dir)).rejects.toThrow(/allowRemoteModels=false. and file was not found locally at .*Kokoro-82M-v1.0-ONNX/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses a voice that is not one of the presets", async () => {
    await expect(kokoroSpeaker("/nowhere")(["Hello."], "zm_yunxi", "/tmp")).rejects.toThrow('unknown voice "zm_yunxi"');
  });
});
