import { RENDER_CANCELLED } from "./work-queue";

// What the clips pages say about a project's state.
export function describeClipProject(project: { status: string; error: string | null; renderStep: string | null; clipCount: number }): string {
  if (project.status === "awaiting_source") return "Waiting for the video upload to finish.";
  // The Queue page's cancel leaves "Cancelled" as the last step.
  const cancelled = project.renderStep === RENDER_CANCELLED;
  if (project.status === "ready") return cancelled ? "Making clips was cancelled. Choose the settings and make clips." : "Ready. Choose the settings and make clips.";
  if (project.status === "rendering") return "Making clips…";
  if (project.status === "failed") return `Failed: ${project.error ?? "unknown error"}`;
  if (cancelled) return "Making clips was cancelled. The clips made before that are kept.";
  return "Clips ready.";
}
