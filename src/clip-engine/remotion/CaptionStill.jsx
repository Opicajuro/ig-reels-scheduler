import { Fragment } from "react";
import { AbsoluteFill } from "remotion";
import { captionPlacement, captionPreset } from "./caption-presets.js";

// One caption line on a transparent canvas, laid over the clip by ffmpeg while the line is spoken. highlight is the
// index of the word drawn in the preset's highlight style, or null.
export function CaptionStill({ words, highlight, preset, position, uppercase }) {
  const look = captionPreset(preset);

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
          fontFamily: "sans-serif",
          fontSize: 64,
          fontWeight: 800,
          textShadow: look.textShadow,
          textTransform: uppercase ? "uppercase" : "none",
        }}
      >
        {words.map((word, index) => (
          <Fragment key={index}>
            {index > 0 ? " " : null}
            <span style={index === highlight ? look.highlight : undefined}>{word}</span>
          </Fragment>
        ))}
      </div>
    </AbsoluteFill>
  );
}
