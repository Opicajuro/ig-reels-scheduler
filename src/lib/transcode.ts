import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildReelTranscodeArgs, checkReelSpec, type ProbeResult } from "./media-spec";

const execFileAsync = promisify(execFile);

export async function transcodeToReel({
  inputPath,
  outputPath,
}: {
  inputPath: string;
  outputPath: string;
}): Promise<{ durationSeconds: number; width: number; height: number }> {
  await execFileAsync("ffmpeg", ["-v", "error", ...buildReelTranscodeArgs(inputPath, outputPath)]);

  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error", "-print_format", "json", "-show_format", "-show_streams", outputPath,
  ]);
  const probe = JSON.parse(stdout) as ProbeResult & { streams: Array<{ width?: number; height?: number }> };

  const problems = checkReelSpec(probe);
  if (problems.length > 0) throw new Error(problems.join("; "));

  const video = probe.streams.find((stream) => stream.codec_type === "video");
  return {
    durationSeconds: Number(probe.format.duration),
    width: video?.width as number,
    height: video?.height as number,
  };
}
