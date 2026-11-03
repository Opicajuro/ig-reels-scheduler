// What an AI intro or B-roll on an existing clip takes, shared by the clip drawer and the server.

export type AiClipKind = "intro" | "broll";

export const AI_CLIP_LABELS: Record<AiClipKind, string> = { intro: "AI intro", broll: "AI B-roll" };
export const INTRO_SECONDS = [3, 5] as const;
export const BROLL_SECONDS = 3;

const SUGGESTION_WORDS = 12;

// A starting prompt from the clip's title, or else the first words said in it.
export function suggestAiPrompt(kind: AiClipKind, { title, words }: { title: string | null; words: string }): string {
  const firstWords = words.split(/\s+/).filter(Boolean).slice(0, SUGGESTION_WORDS).join(" ");
  const topic = title?.trim() || firstWords;
  const about = topic ? ` about "${topic}"` : "";
  return kind === "intro"
    ? `An eye-catching opening shot${about}, cinematic lighting, slow camera push in`
    : `A cinematic shot illustrating what is said${about}, natural light, gentle camera movement`;
}
