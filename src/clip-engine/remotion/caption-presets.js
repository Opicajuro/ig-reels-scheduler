// Caption looks a person can pick. Each preset sets how the caption text is drawn on the clip.
export const CAPTION_PRESET_NAMES = ["classic", "yellow", "box"];

const PRESETS = {
  classic: {
    color: "white",
    background: null,
    textShadow: "0 4px 12px rgba(0,0,0,0.9)",
  },
  yellow: {
    color: "#ffd400",
    background: null,
    textShadow: "-3px -3px 0 #000, 3px -3px 0 #000, -3px 3px 0 #000, 3px 3px 0 #000, 0 6px 14px rgba(0,0,0,0.9)",
  },
  box: {
    color: "white",
    background: "rgba(0,0,0,0.72)",
    textShadow: "none",
  },
};

export function captionPreset(name) {
  if (!Object.hasOwn(PRESETS, name)) throw new Error(`Unknown caption preset "${name}"`);
  return PRESETS[name];
}
