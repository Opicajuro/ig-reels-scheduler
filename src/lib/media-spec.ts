import { videoEncoderArgs, type VideoEncoder } from "@/clip-engine/encoder.js";

const MIN_DURATION_SECONDS = 3;
const MAX_DURATION_SECONDS = 900;
const MIN_FPS = 23;
const MAX_FPS = 60;

type ProbeStream = {
  codec_type?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
};

export type ProbeResult = {
  format: { format_name: string; duration: string };
  streams: ProbeStream[];
};

export function buildReelTranscodeArgs(input: string, output: string, encoder: VideoEncoder): string[] {
  return [
    "-y",
    "-i", input,
    "-vf", "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,fps=30,format=yuv420p",
    ...videoEncoderArgs(encoder, 20),
    "-g", "60", "-keyint_min", "60", "-sc_threshold", "0",
    "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2", "-movflags", "+faststart",
    output,
  ];
}

function frameRate(rate: string): number {
  const [num, den] = rate.split("/").map(Number);
  return num / den;
}

export function checkReelSpec(probe: ProbeResult): string[] {
  const problems: string[] = [];
  const video = probe.streams.find((stream) => stream.codec_type === "video");
  const hasAudio = probe.streams.some((stream) => stream.codec_type === "audio");
  const duration = Number(probe.format.duration);

  if (!/mp4|mov/.test(probe.format.format_name)) problems.push("container must be MP4 or MOV");
  if (!video) {
    problems.push("no video stream");
  } else {
    if (video.width !== 1080 || video.height !== 1920) problems.push("resolution must be 1080x1920");
    const fps = frameRate(video.r_frame_rate ?? "0/1");
    if (fps < MIN_FPS || fps > MAX_FPS) problems.push(`frame rate must be between ${MIN_FPS} and ${MAX_FPS} fps`);
  }
  if (!hasAudio) problems.push("no audio stream");
  if (duration < MIN_DURATION_SECONDS || duration > MAX_DURATION_SECONDS) {
    problems.push(`duration must be between ${MIN_DURATION_SECONDS} and ${MAX_DURATION_SECONDS} seconds`);
  }
  return problems;
}
