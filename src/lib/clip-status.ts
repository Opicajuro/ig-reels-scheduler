// What the clips pages say about a project's state.
export function describeClipProject(project: { status: string; error: string | null; clipCount: number }): string {
  if (project.status === "awaiting_source") return "Waiting for the video upload to finish.";
  if (project.status === "ready") return "Ready. Choose the settings and make clips.";
  if (project.status === "rendering") return "Making clips…";
  if (project.status === "failed") return `Failed: ${project.error ?? "unknown error"}`;
  return "Clips ready.";
}
