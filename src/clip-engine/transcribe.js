import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Transcribes the English speech in the media into words, each with its time in ms. No voice detection (--vad):
// whisper.cpp 1.9.5 maps a VAD segment's times back to the video by interpolating across each cut-out silence, which
// squeezes to 0.1 s, so a word stamped a few ms early there lands seconds before it is said.
export async function transcribeToWords({ mediaPath, workDir, whisperBin, model }) {
  const wav = path.join(workDir, "audio.wav");
  await execFileAsync("ffmpeg", ["-v", "error", "-y", "-i", mediaPath, "-vn", "-ar", "16000", "-ac", "1", wav]);

  const prefix = path.join(workDir, "transcript");
  // -ml 1 -sow makes every segment one word, with its punctuation; -oj writes them as JSON.
  await execFileAsync(whisperBin, [
    "-m", model,
    "-l", "en",
    "-t", String(os.cpus().length),
    "-ml", "1", "-sow",
    "-oj", "-of", prefix,
    "-f", wav,
  ]);

  return wordsFromWhisperJson(JSON.parse(await readFile(`${prefix}.json`, "utf8")));
}

// whisper's JSON lists the segments in "transcription", each with its text and its "offsets" in ms.
export function wordsFromWhisperJson(json) {
  const words = json.transcription
    .map((segment) => ({ text: segment.text.trim(), startMs: segment.offsets.from, endMs: segment.offsets.to }))
    .filter((word) => word.text !== "");
  // A word ends by the time the next one starts, so its caption never overlaps the next.
  return words.map((word, index) => ({ ...word, endMs: Math.min(word.endMs, words[index + 1]?.startMs ?? word.endMs) }));
}
