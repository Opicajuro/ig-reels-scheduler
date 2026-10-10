import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { parseSrt } from "@remotion/captions";

const execFileAsync = promisify(execFile);

export async function transcribeToCaptions({ mediaPath, workDir, whisperBin, model }) {
  const wav = path.join(workDir, "audio.wav");
  await execFileAsync("ffmpeg", ["-v", "error", "-y", "-i", mediaPath, "-vn", "-ar", "16000", "-ac", "1", wav]);

  const prefix = path.join(workDir, "transcript");
  await execFileAsync(whisperBin, ["-m", model, "-f", wav, "-osrt", "-of", prefix]);

  const srt = await readFile(`${prefix}.srt`, "utf8");
  return parseSrt({ input: srt }).captions;
}
