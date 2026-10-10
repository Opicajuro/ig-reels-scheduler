export function captionsForClip(captions, clipStartMs, clipEndMs) {
  return captions
    .filter((caption) => caption.endMs > clipStartMs && caption.startMs < clipEndMs)
    .map((caption) => {
      const startMs = Math.max(caption.startMs, clipStartMs) - clipStartMs;
      const endMs = Math.min(caption.endMs, clipEndMs) - clipStartMs;
      return { ...caption, startMs, endMs, timestampMs: startMs };
    });
}
