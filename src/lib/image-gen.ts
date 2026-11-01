import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";

// The picture maker: stable-diffusion.cpp's sd-cli with Z-Image Turbo. One run draws one picture at 768×1344 (9:16 to
// the nearest multiple of 16 the model takes) in Z-Image Turbo's 8 steps without guidance; the slideshow scales it to
// 1080×1920.

export const PICTURE_WIDTH = 768;
export const PICTURE_HEIGHT = 1344;
const STEPS = 8;

export type PictureModels = { cli: string; diffusion: string; llm: string; vae: string };
export type DrawPicture = (prompt: string, output: string) => Promise<void>;

export function pictureArgs({ models, prompt, output, seed }: { models: PictureModels; prompt: string; output: string; seed: number }) {
  return [
    "--diffusion-model", models.diffusion,
    "--llm", models.llm,
    "--vae", models.vae,
    "-p", prompt,
    "--cfg-scale", "1.0",
    "--steps", String(STEPS),
    "-W", String(PICTURE_WIDTH),
    "-H", String(PICTURE_HEIGHT),
    "-s", String(seed),
    // The text encoder and the model wait in RAM while the other runs, so 4 GB of video memory is enough.
    "--offload-to-cpu",
    "-o", output,
  ];
}

// Draws one picture to output (a .png). Throws with the end of sd-cli's output when it fails or writes nothing.
export function drawPicture({ models, prompt, output, seed }: { models: PictureModels; prompt: string; output: string; seed: number }) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(models.cli, pictureArgs({ models, prompt, output, seed }), { windowsHide: true });
    let log = "";
    const keep = (chunk: Buffer) => {
      log = (log + chunk.toString()).slice(-4000);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.on("error", reject);
    child.on("close", async (code) => {
      const tail = log.trim().split(/\r?\n/).slice(-5).join("\n");
      if (code !== 0) {
        reject(new Error(`the picture maker exited with ${code}:\n${tail}`));
        return;
      }
      const written = await stat(output).then(
        (info) => info.size > 0,
        () => false,
      );
      if (written) resolve();
      else reject(new Error(`the picture maker wrote no picture:\n${tail}`));
    });
  });
}
