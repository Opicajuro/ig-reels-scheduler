import type { ComponentProps } from "react";
import { platformName } from "@/lib/platforms";
import styles from "./platform-links.module.css";

// A link to another site. It opens in a new window, so the app stays where it is.
export function ExternalLink(props: Omit<ComponentProps<"a">, "target" | "rel">) {
  return <a {...props} target="_blank" rel="noopener noreferrer" />;
}

// Links as small chips named by their platform: "YouTube", "TikTok", … The full link is the chip's tooltip.
export function PlatformChips({ links }: { links: Array<{ id: string; url: string }> }) {
  if (links.length === 0) return null;
  return (
    <ul className={styles.chips} aria-label="Posted elsewhere">
      {links.map((link) => (
        <li key={link.id}>
          <ExternalLink href={link.url} className={styles.chip} title={link.url}>
            {platformName(link.url)}
          </ExternalLink>
        </li>
      ))}
    </ul>
  );
}
