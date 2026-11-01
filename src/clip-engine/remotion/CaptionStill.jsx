import { Fragment, useEffect, useState } from "react";
import { AbsoluteFill, cancelRender, continueRender, delayRender } from "remotion";
import { captionFont, captionPlacement, captionPreset, EMOJI_FONT_FAMILY, videoColor } from "./caption-presets.js";
import "./fonts.js";

// Holds the still until the shipped fonts it draws with have loaded, so the PNG is never taken with a stand-in font.
// The default font is the system's and needs nothing.
function useFonts(font, text, emoji) {
  const [handle] = useState(() => delayRender("Loading the caption fonts"));
  useEffect(() => {
    const loads = [];
    if (font.family !== "sans-serif") loads.push(document.fonts.load(`${font.weight} 64px "${font.family}"`, text));
    if (emoji) loads.push(document.fonts.load(`64px "${EMOJI_FONT_FAMILY}"`, emoji));
    Promise.all(loads)
      .then((faces) => {
        if (faces.some((loaded) => loaded.length === 0)) throw new Error(`a font for "${text}" did not load`);
        continueRender(handle);
      })
      .catch((err) => cancelRender(err));
  }, [font, text, emoji, handle]);
}

function fontStyle(font) {
  return { fontFamily: font.family === "sans-serif" ? "sans-serif" : `"${font.family}"`, fontWeight: font.weight };
}

// One caption line on a transparent canvas, laid over the clip by ffmpeg while the line is spoken. highlight is the
// index of the word drawn in the preset's highlight style, or null. emoji, or null, follows the line.
export function CaptionStill({ words, highlight, emoji, preset, position, uppercase, font, highlightColor }) {
  const look = captionPreset(preset);
  const face = captionFont(font);
  useFonts(face, words.join(" "), emoji);

  return (
    <AbsoluteFill>
      <div
        style={{
          position: "absolute",
          ...captionPlacement(position),
          width: "100%",
          padding: "16px 48px",
          boxSizing: "border-box",
          textAlign: "center",
          color: look.color,
          background: look.background ?? "transparent",
          ...fontStyle(face),
          fontSize: 64,
          textShadow: look.textShadow,
          textTransform: uppercase ? "uppercase" : "none",
        }}
      >
        {words.map((word, index) => (
          <Fragment key={index}>
            {index > 0 ? " " : null}
            <span style={index === highlight ? { ...look.highlight, background: videoColor(highlightColor) } : undefined}>
              {word}
            </span>
          </Fragment>
        ))}
        {emoji ? (
          <>
            {" "}
            <span style={{ fontFamily: `"${EMOJI_FONT_FAMILY}"`, fontWeight: 400 }}>{emoji}</span>
          </>
        ) : null}
      </div>
    </AbsoluteFill>
  );
}

// The hook title, big at the top of the clip for its first seconds.
export function HookStill({ text, font }) {
  const face = captionFont(font);
  useFonts(face, text, null);

  return (
    <AbsoluteFill>
      <div
        style={{
          position: "absolute",
          top: "7%",
          left: 60,
          right: 60,
          padding: "24px 36px",
          borderRadius: 28,
          background: "rgba(0,0,0,0.72)",
          color: "white",
          textAlign: "center",
          ...fontStyle(face),
          fontSize: 84,
          lineHeight: 1.1,
        }}
      >
        {text}
      </div>
    </AbsoluteFill>
  );
}

// The end card: the person's handle in the middle of a dimmed clip, for its last moments.
export function EndCardStill({ text, font }) {
  const face = captionFont(font);
  useFonts(face, text, null);

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        background: "rgba(0,0,0,0.65)",
        color: "white",
        textAlign: "center",
        padding: 60,
        ...fontStyle(face),
        fontSize: 96,
        textShadow: "0 4px 12px rgba(0,0,0,0.9)",
      }}
    >
      {text}
    </AbsoluteFill>
  );
}
