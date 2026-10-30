import { ExternalLink } from "@/components/platform-links";
import { platformName } from "@/lib/platforms";

// Where a project's video came from: a link to the original, named by its platform, or "Uploaded file".
export function SourceLink({ sourceUrl }: { sourceUrl: string | null }) {
  if (!sourceUrl) return <>Uploaded file</>;
  return (
    <ExternalLink href={sourceUrl} title={sourceUrl}>
      Original on {platformName(sourceUrl)}
    </ExternalLink>
  );
}
