"use client";

import { ActionForm, SubmitButton } from "@/components/action-form";
import { EmptyState } from "@/components/empty-state";
import { Field } from "@/components/field";
import { ExternalLink } from "@/components/platform-links";
import { platformName } from "@/lib/platforms";
import { addClipLinkAction, removeClipLinkAction } from "../actions";
import styles from "../clips.module.css";
import type { ClipView } from "./clip-grid";

// The Links tab of a clip's drawer: where this clip was posted outside Localirs, such as YouTube Shorts or TikTok.
export function ClipLinks({ clip, projectId }: { clip: ClipView; projectId: string }) {
  return (
    <div className={styles.panel}>
      <p className={styles.muted}>Paste where you posted this clip on other sites, so you can find it again from here.</p>
      {clip.links.length === 0 ? (
        <EmptyState>Not posted elsewhere yet.</EmptyState>
      ) : (
        <ul className={styles.links}>
          {clip.links.map((link) => (
            <li key={link.id}>
              <strong>{platformName(link.url)}</strong>
              <ExternalLink href={link.url} className={styles.linkUrl}>
                {link.url}
              </ExternalLink>
              <ActionForm action={removeClipLinkAction}>
                <input type="hidden" name="linkId" value={link.id} />
                <input type="hidden" name="projectId" value={projectId} />
                <SubmitButton size="sm" aria-label={`Remove the ${platformName(link.url)} link`} pendingLabel="Removing…">
                  Remove
                </SubmitButton>
              </ActionForm>
            </li>
          ))}
        </ul>
      )}
      <ActionForm action={addClipLinkAction} className={styles.panel}>
        <input type="hidden" name="clipId" value={clip.id} />
        <input type="hidden" name="projectId" value={projectId} />
        <Field label="Link" hint="YouTube Shorts, TikTok, Facebook, X or any other site.">
          <input type="url" name="url" maxLength={2000} placeholder="https://…" required />
        </Field>
        <SubmitButton pendingLabel="Adding…">Add link</SubmitButton>
      </ActionForm>
    </div>
  );
}
