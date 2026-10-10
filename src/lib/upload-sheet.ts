// Title and description for a clip. A clip without its own title is named after its file.
export function uploadDetails(clip: { name: string; title: string | null; description: string | null }) {
  return {
    title: clip.title ?? clip.name,
    description: clip.description ?? "",
  };
}

// Plain text sheet for uploading the clips by hand in YouTube Studio.
export function buildUploadSheet(
  projectName: string,
  clips: Array<{ name: string; title: string | null; description: string | null }>,
): string {
  const blocks = clips.map((clip, index) => {
    const { title, description } = uploadDetails(clip);
    return [`${index + 1}. ${clip.name}.mp4`, `Title: ${title}`, "Description:", description]
      .filter(Boolean)
      .join("\n");
  });
  const header = [
    `Upload sheet: ${projectName}`,
    "",
    "Upload each clip in YouTube Studio (Create > Upload videos), then paste its title and description.",
  ].join("\n");
  return `${[header, ...blocks].join("\n\n")}\n`;
}
