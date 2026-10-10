import { copyFile, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import { captionPreset } from "./remotion/caption-presets.js";

const ENTRY_POINT = fileURLToPath(new URL("./remotion/index.jsx", import.meta.url));

export async function renderCaptionedClip({ clipPath, durationSeconds, captions, output, chromePath, preset }) {
  if (!chromePath) throw new Error("chromePath is required to render captions");
  captionPreset(preset);

  const publicDir = await mkdtemp(path.join(os.tmpdir(), "remotion-clip-"));
  await copyFile(clipPath, path.join(publicDir, "clip.mp4"));

  const serveUrl = await bundle({ entryPoint: ENTRY_POINT, publicDir });
  const inputProps = { captions, durationSeconds, preset };
  const composition = await selectComposition({
    serveUrl,
    id: "Captions",
    inputProps,
    browserExecutable: chromePath,
  });

  await renderMedia({
    composition,
    serveUrl,
    codec: "h264",
    outputLocation: output,
    inputProps,
    browserExecutable: chromePath,
  });
}
