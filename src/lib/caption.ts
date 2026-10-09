const MAX_LENGTH = 2200;
const MAX_HASHTAGS = 30;
const MAX_MENTIONS = 20;

export function validateCaption(caption: string): string[] {
  const problems: string[] = [];
  if (caption.length > MAX_LENGTH) problems.push(`caption must be at most ${MAX_LENGTH} characters`);
  if ((caption.match(/#\w+/g) ?? []).length > MAX_HASHTAGS) {
    problems.push(`caption may have at most ${MAX_HASHTAGS} hashtags`);
  }
  if ((caption.match(/@\w+/g) ?? []).length > MAX_MENTIONS) {
    problems.push(`caption may have at most ${MAX_MENTIONS} mentions`);
  }
  return problems;
}
