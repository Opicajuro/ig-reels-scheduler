import os from "node:os";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import { captionPlacement, captionPreset } from "./remotion/caption-presets.js";

const ENTRY_POINT = fileURLToPath(new URL("./remotion/index.jsx", import.meta.url));

// Builds the caption composition once for a project. publicDir holds every clip to caption; bundling copies it,
// so the clips must be in it before this runs.
export function bundleCaptions(publicDir) {
  return bundle({ entryPoint: ENTRY_POINT, publicDir });
}

// Renders one clip from the bundle. src is the clip's file name in the bundle's publicDir.
export async function renderCaptions({
  serveUrl,
  src,
  durationSeconds,
  captions,
  output,
  chromePath,
  preset,
  position = "bottom",
  uppercase = false,
}) {
  if (!chromePath) throw new Error("chromePath is required to render captions");
  captionPreset(preset);
  captionPlacement(position);

  const inputProps = { src, captions, durationSeconds, preset, position, uppercase };
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
    // Same quality as clips without captions; Remotion's defaults (preset medium, half the cores) are much slower.
    x264Preset: "veryfast",
    crf: 21,
    concurrency: os.cpus().length,
    outputLocation: output,
    inputProps,
    browserExecutable: chromePath,
  });
}
