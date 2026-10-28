import { AbsoluteFill } from "remotion";
import { captionPlacement, captionPreset } from "./caption-presets.js";

// One caption on a transparent canvas, laid over the clip by ffmpeg while the caption is spoken.
export function CaptionStill({ text, preset, position, uppercase }) {
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
        {text}
      </div>
    </AbsoluteFill>
  );
}
