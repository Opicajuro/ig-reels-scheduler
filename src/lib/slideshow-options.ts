// What a slideshow is made of and the limits the forms, the script writer and the checks share. Nothing here runs on
// the server only, so the Clips page's editor uses it too.

export const MIN_SLIDES = 3;
export const MAX_SLIDES = 10;
export const MAX_TOPIC_LENGTH = 200;
export const MAX_LINE_LENGTH = 200;
export const MAX_PICTURE_LENGTH = 400;

// Kokoro's best-rated English voices.
export const VOICE_PRESETS = [
  { id: "af_heart", label: "Heart (US English, woman)" },
  { id: "af_bella", label: "Bella (US English, woman)" },
  { id: "am_michael", label: "Michael (US English, man)" },
  { id: "bf_emma", label: "Emma (UK English, woman)" },
  { id: "bm_george", label: "George (UK English, man)" },
] as const;

export type VoicePreset = (typeof VOICE_PRESETS)[number]["id"];

export function isVoicePreset(voice: string): voice is VoicePreset {
  return VOICE_PRESETS.some((preset) => preset.id === voice);
}

// Where a slide's picture comes from: drawn by the picture maker from its description, a frame of one of the owner's
// clips or source videos at a time in seconds, or an uploaded photo. null until the person picks one.
export type SlideSource =
  | { kind: "ai" }
  | { kind: "clip"; clipId: string; at: number }
  | { kind: "video"; projectId: string; at: number }
  | { kind: "photo"; key: string };
export type Slide = { text: string; picture: string; source: SlideSource | null };
export type ReadySlide = Slide & { source: SlideSource };
