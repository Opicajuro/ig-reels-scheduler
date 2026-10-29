import os from "node:os";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import { openBrowser, renderStill, selectComposition } from "@remotion/renderer";
import { captionPlacement, captionPreset } from "./remotion/caption-presets.js";

const ENTRY_POINT = fileURLToPath(new URL("./remotion/index.jsx", import.meta.url));

// Builds the caption composition once for a project.
export function bundleCaptions() {
  return bundle({ entryPoint: ENTRY_POINT });
}

// Draws each caption as a transparent 1080x1920 PNG, all in one browser. stills is a list of
// { words, highlight, output }, as CaptionStill takes them.
export async function renderCaptionStills({
  serveUrl,
  stills,
  chromePath,
  preset,
  position = "bottom",
  uppercase = false,
}) {
  if (!chromePath) throw new Error("chromePath is required to render captions");
  captionPreset(preset);
  captionPlacement(position);

  const browser = await openBrowser("chrome", { browserExecutable: chromePath });
  try {
    // One page per core at a time; each loop takes the next still until none are left.
    let next = 0;
    const renderNext = async () => {
      while (next < stills.length) {
        const { words, highlight, output } = stills[next++];
        const inputProps = { words, highlight, preset, position, uppercase };
        const composition = await selectComposition({
          serveUrl,
          id: "CaptionStill",
          inputProps,
          puppeteerInstance: browser,
        });
        await renderStill({ composition, serveUrl, output, imageFormat: "png", inputProps, puppeteerInstance: browser });
      }
    };
    await Promise.all(Array.from({ length: os.cpus().length }, renderNext));
  } finally {
    await browser.close({ silent: true });
  }
}
