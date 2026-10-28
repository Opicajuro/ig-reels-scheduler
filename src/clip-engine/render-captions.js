import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import { openBrowser, renderStill, selectComposition } from "@remotion/renderer";
import { captionPlacement, captionPreset } from "./remotion/caption-presets.js";

const ENTRY_POINT = fileURLToPath(new URL("./remotion/index.jsx", import.meta.url));

// Builds the caption composition once for a project.
export function bundleCaptions() {
  return bundle({ entryPoint: ENTRY_POINT });
}

// Draws each caption as a transparent 1080x1920 PNG, all in one browser. stills is a list of { text, output }.
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
    await Promise.all(
      stills.map(async ({ text, output }) => {
        const inputProps = { text, preset, position, uppercase };
        const composition = await selectComposition({
          serveUrl,
          id: "CaptionStill",
          inputProps,
          puppeteerInstance: browser,
        });
        await renderStill({ composition, serveUrl, output, imageFormat: "png", inputProps, puppeteerInstance: browser });
      }),
    );
  } finally {
    await browser.close({ silent: true });
  }
}
