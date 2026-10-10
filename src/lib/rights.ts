export type AudioSourceValue = "original" | "licensed" | "from_source" | "unknown";

export type RightsCheck = {
  /** false: the post must not be created */
  canSchedule: boolean;
  warnings: string[];
};

// The safe-clip gate: the operator confirms they own or license the clip, and gets warned about the things that
// commonly get a Reel claimed or down-ranked.
export function checkRights(input: {
  rightsConfirmed: boolean;
  audioSource: AudioSourceValue;
  /** other accounts with a scheduled or published post whose media came from the same clip project */
  siblingAccountCount: number;
}): RightsCheck {
  if (!input.rightsConfirmed) {
    return {
      canSchedule: false,
      warnings: ["Please confirm you own or hold a license to this clip's video and audio before scheduling."],
    };
  }

  const warnings: string[] = [];
  if (input.audioSource === "from_source") {
    warnings.push("This clip's audio comes from the source video. If you don't own that video, Instagram can claim the Reel.");
  }
  if (input.audioSource === "unknown") {
    warnings.push("Audio source is unknown. Set it so the rights record is complete.");
  }
  if (input.siblingAccountCount > 0) {
    warnings.push(
      `Media from this project is already scheduled or published to ${input.siblingAccountCount} other account(s). Instagram down-ranks duplicate content.`,
    );
  }
  return { canSchedule: true, warnings };
}

export function parseAudioSource(value: unknown): AudioSourceValue {
  return value === "original" || value === "licensed" || value === "from_source" ? value : "unknown";
}
