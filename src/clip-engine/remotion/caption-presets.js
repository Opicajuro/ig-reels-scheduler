// Caption looks a person can pick. Each preset sets how the caption text is drawn on the clip. A preset with
// wordByWord shows each line once per word, with the spoken word drawn in its highlight style.
export const CAPTION_PRESET_NAMES = ["classic", "yellow", "box", "words"];

const PRESETS = {
  classic: {
    color: "white",
    background: null,
    textShadow: "0 4px 12px rgba(0,0,0,0.9)",
    wordByWord: false,
  },
  yellow: {
    color: "#ffd400",
    background: null,
    textShadow: "-3px -3px 0 #000, 3px -3px 0 #000, -3px 3px 0 #000, 3px 3px 0 #000, 0 6px 14px rgba(0,0,0,0.9)",
    wordByWord: false,
  },
  box: {
    color: "white",
    background: "rgba(0,0,0,0.72)",
    textShadow: "none",
    wordByWord: false,
  },
  words: {
    color: "white",
    background: null,
    textShadow: "0 4px 12px rgba(0,0,0,0.9)",
    wordByWord: true,
    highlight: { color: "#111", background: "#ffd400", borderRadius: 12, padding: "0 12px", textShadow: "none" },
  },
};

export function captionPreset(name) {
  if (!Object.hasOwn(PRESETS, name)) throw new Error(`Unknown caption preset "${name}"`);
  return PRESETS[name];
}

// Where on the clip the caption sits. The bottom position is the one the captions have always used.
export const CAPTION_POSITION_NAMES = ["bottom", "middle", "top"];

const PLACEMENTS = {
  bottom: { bottom: "18%" },
  middle: { top: "50%", transform: "translateY(-50%)" },
  top: { top: "12%" },
};

export function captionPlacement(name) {
  if (!Object.hasOwn(PLACEMENTS, name)) throw new Error(`Unknown caption position "${name}"`);
  return PLACEMENTS[name];
}

// Fonts the captions, the hook title and the end card can use. The default is the one the captions have always used;
// the others are shipped with the app (remotion/fonts.js) and load in the bundle.
export const CAPTION_FONT_NAMES = ["default", "montserrat", "anton", "bebas"];

const FONTS = {
  default: { family: "sans-serif", weight: 800 },
  montserrat: { family: "Montserrat", weight: 800 },
  anton: { family: "Anton", weight: 400 },
  bebas: { family: "Bebas Neue", weight: 400 },
};

export function captionFont(name) {
  if (!Object.hasOwn(FONTS, name)) throw new Error(`Unknown caption font "${name}"`);
  return FONTS[name];
}

// Colours burned into the video: the word-by-word highlight and the progress bar. They are the same whatever theme
// the app shows, so they are plain values rather than tokens.
export const VIDEO_COLOR_NAMES = ["yellow", "green", "cyan", "pink", "white"];

const VIDEO_COLORS = {
  yellow: "#ffd400",
  green: "#3ee26b",
  cyan: "#22d3ee",
  pink: "#ff4fa3",
  white: "#ffffff",
};

export function videoColor(name) {
  if (!Object.hasOwn(VIDEO_COLORS, name)) throw new Error(`Unknown video colour "${name}"`);
  return VIDEO_COLORS[name];
}

export const EMOJI_FONT_FAMILY = "Noto Color Emoji";
