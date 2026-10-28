"use client";

import { useState } from "react";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { ButtonLink } from "@/components/button";
import { Field } from "@/components/field";
import { copyClipAction, deleteClipAction, renameClipAction, saveClipDetailsAction } from "../actions";
import styles from "../clips.module.css";
import type { ClipView } from "./clip-grid";

// Instagram cuts a caption at 2,200 characters, and the description is what a bulk schedule posts as the caption.
const CAPTION_MAX = 2200;

// The Details tab of a clip's drawer: its name, the title and description it is posted with, and the clip's own actions.
export function ClipDetails({ clip, projectId, busy }: { clip: ClipView; projectId: string; busy: boolean }) {
  const [description, setDescription] = useState(clip.description ?? "");
  const over = description.length > CAPTION_MAX;

  return (
    <div className={styles.panel}>
      <ActionForm action={renameClipAction} className={styles.panel}>
        <input type="hidden" name="clipId" value={clip.id} />
        <input type="hidden" name="projectId" value={projectId} />
        <Field label="Clip name">
          <input type="text" name="name" maxLength={60} defaultValue={clip.name} required />
        </Field>
        <SubmitButton pendingLabel="Renaming…">Rename</SubmitButton>
      </ActionForm>

      <ActionForm action={saveClipDetailsAction} className={styles.panel}>
        <input type="hidden" name="clipId" value={clip.id} />
        <input type="hidden" name="projectId" value={projectId} />
        <Field label="Title (YouTube, up to 100 characters)">
          <input type="text" name="title" maxLength={100} defaultValue={clip.title ?? clip.name} />
        </Field>
        <Field
          label="Description (with hashtags)"
          hint={
            <span className={over ? styles.over : undefined}>
              {description.length.toLocaleString("en")} / {CAPTION_MAX.toLocaleString("en")}
              {over
                ? " · longer than Instagram allows, so shorten it before scheduling"
                : " · the Instagram caption and the YouTube description"}
            </span>
          }
        >
          <textarea
            name="description"
            rows={8}
            maxLength={5000}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>
        <SubmitButton pendingLabel="Saving…">Save title and description</SubmitButton>
      </ActionForm>

      <div className={styles.clipTools}>
        <ButtonLink href={clip.downloadUrl} download>
          Download
        </ButtonLink>
        <ActionForm action={copyClipAction}>
          <input type="hidden" name="clipId" value={clip.id} />
          <input type="hidden" name="projectId" value={projectId} />
          <SubmitButton disabled={busy} pendingLabel="Copying…">
            Copy
          </SubmitButton>
        </ActionForm>
        <ActionForm
          action={deleteClipAction}
          confirm={{ message: `Delete ${clip.name}? This cannot be undone.`, confirmLabel: "Delete clip" }}
        >
          <input type="hidden" name="clipId" value={clip.id} />
          <input type="hidden" name="projectId" value={projectId} />
          <SubmitButton variant="danger" disabled={busy} pendingLabel="Deleting…">
            Delete
          </SubmitButton>
        </ActionForm>
      </div>
    </div>
  );
}
