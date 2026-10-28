import { AbsoluteFill, OffthreadVideo, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { captionPlacement, captionPreset } from "./caption-presets.js";

export function Captions({ src, captions, preset, position, uppercase }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const timeMs = (frame / fps) * 1000;
  const active = captions.find((caption) => timeMs >= caption.startMs && timeMs < caption.endMs);
  const look = captionPreset(preset);

  return (
    <AbsoluteFill style={{ backgroundColor: "black" }}>
      <OffthreadVideo src={staticFile(src)} />
      {active ? (
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
          {active.text}
        </div>
      ) : null}
    </AbsoluteFill>
  );
}
