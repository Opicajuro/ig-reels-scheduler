import { writeFile } from "node:fs/promises";
import path from "node:path";
import { isVoicePreset } from "./slideshow-options";

// The slideshow voice: Kokoro-82M through kokoro-js, on the processor (onnxruntime-node), English only. The model files
// ship with the installer (installer/tools.json) and setup writes their folder to .env as KOKORO_MODEL; the voices are
// in the kokoro-js package itself. Nothing is fetched from the internet.

export type SpokenLine = { file: string; seconds: number };
export type Speak = (lines: string[], voice: string, dir: string) => Promise<SpokenLine[]>;

// Writes each line as a WAV file in dir and returns its length.
export function kokoroSpeaker(modelDir: string): Speak {
  return async (lines, voice, dir) => {
    if (!isVoicePreset(voice)) throw new Error(`unknown voice "${voice}"`);
    const { env } = await import("@huggingface/transformers");
    const { KokoroTTS } = await import("kokoro-js");
    env.allowRemoteModels = false;
    env.allowLocalModels = true;
    env.localModelPath = path.dirname(modelDir);
    const tts = await KokoroTTS.from_pretrained(path.basename(modelDir), { dtype: "q8", device: "cpu" });
    const spoken: SpokenLine[] = [];
    for (const [index, line] of lines.entries()) {
      const audio = await tts.generate(line, { voice });
      const file = path.join(dir, `line-${index}.wav`);
      await writeFile(file, Buffer.from(audio.toWav()));
      spoken.push({ file, seconds: audio.audio.length / audio.sampling_rate });
    }
    return spoken;
  };
}
