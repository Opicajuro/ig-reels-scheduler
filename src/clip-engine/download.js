import { spawn } from "node:child_process";
import path from "node:path";

export function downloadVideo(url, dir) {
  return new Promise((resolve, reject) => {
    const child = spawn("yt-dlp", [
      "--no-playlist",
      "--quiet",
      "--no-warnings",
      "--no-simulate",
      "--max-filesize", "2G",
      "-f", "bv*+ba/b",
      "--remux-video", "mp4",
      "-o", path.join(dir, "source.%(ext)s"),
      "--print", "after_move:%(title)s",
      "--",
      url,
    ]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        const tail = stderr.trim().split("\n").slice(-5).join("\n");
        reject(new Error(`yt-dlp exited with ${code}: ${tail}`));
        return;
      }
      resolve(stdout.trim().split("\n").pop());
    });
  });
}
