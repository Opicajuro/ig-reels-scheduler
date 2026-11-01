import os from "node:os";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import { openBrowser, renderStill, selectComposition } from "@remotion/renderer";
import { captionFont, captionPlacement, captionPreset, videoColor } from "./remotion/caption-presets.js";

const ENTRY_POINT = fileURLToPath(new URL("./remotion/index.jsx", import.meta.url));

// Builds the caption composition once for a project.
export function bundleCaptions() {
  return bundle({ entryPoint: ENTRY_POINT });
}

// Draws each still as a transparent 1080x1920 PNG, all in one browser. stills is a list of { id, inputProps, output }
// where id names the composition.
async function renderStills({ serveUrl, stills, chromePath }) {
  if (!chromePath) throw new Error("chromePath is required to render captions");
  const browser = await openBrowser("chrome", { browserExecutable: chromePath });
  try {
    // One page per core at a time; each loop takes the next still until none are left.
    let next = 0;
    const renderNext = async () => {
      while (next < stills.length) {
        const { id, inputProps, output } = stills[next++];
        const composition = await selectComposition({ serveUrl, id, inputProps, puppeteerInstance: browser });
        await renderStill({ composition, serveUrl, output, imageFormat: "png", inputProps, puppeteerInstance: browser });
      }
    };
    await Promise.all(Array.from({ length: os.cpus().length }, renderNext));
  } finally {
    await browser.close({ silent: true });
  }
}

// Draws each caption. stills is a list of { words, highlight, emoji, output }, as CaptionStill takes them.
export async function renderCaptionStills({
  serveUrl,
  stills,
  chromePath,
  preset,
  position = "bottom",
  uppercase = false,
  font = "default",
  highlightColor = "yellow",
}) {
  captionPreset(preset);
  captionPlacement(position);
  captionFont(font);
  videoColor(highlightColor);
  await renderStills({
    serveUrl,
    chromePath,
    stills: stills.map(({ words, highlight, emoji = null, output }) => ({
      id: "CaptionStill",
      inputProps: { words, highlight, emoji, preset, position, uppercase, font, highlightColor },
      output,
    })),
  });
}

// Draws hook titles and end cards. stills is a list of { kind: "hook" | "endCard", text, output }.
export async function renderTitleStills({ serveUrl, stills, chromePath, font = "default" }) {
  captionFont(font);
  const ids = { hook: "HookStill", endCard: "EndCardStill" };
  await renderStills({
    serveUrl,
    chromePath,
    stills: stills.map(({ kind, text, output }) => {
      if (!Object.hasOwn(ids, kind)) throw new Error(`Unknown title still "${kind}"`);
      if (!text) throw new Error(`a ${kind} still needs text`);
      return { id: ids[kind], inputProps: { text, font }, output };
    }),
  });
}
