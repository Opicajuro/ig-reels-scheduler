"use client";

import { useRef } from "react";
import { ActionForm, type Confirmation } from "@/components/action-form";
import { Menu } from "@/components/menu";
import type { ActionResult } from "@/lib/action-result";
import { cancelAiVideoAction, cancelSlideshowAction } from "../queue/actions";
import { deleteAiVideoAction } from "./ai-actions";
import styles from "./ai.module.css";
import { deleteSlideshowAction } from "./slideshow-actions";

type Action = (previous: ActionResult, formData: FormData) => Promise<ActionResult>;

const KINDS: Record<
  "ai" | "slideshow",
  { name: string; cancel: Action; cancelConfirm: Confirmation; remove: Action; deleteLabel: string }
> = {
  ai: {
    name: "AI video",
    cancel: cancelAiVideoAction,
    cancelConfirm: { message: "Stop this AI video? It will not be made.", confirmLabel: "Stop video" },
    remove: deleteAiVideoAction,
    deleteLabel: "Delete video",
  },
  slideshow: {
    name: "slideshow",
    cancel: cancelSlideshowAction,
    cancelConfirm: { message: "Stop this slideshow? A written script is kept, so you can make it again.", confirmLabel: "Stop slideshow" },
    remove: deleteSlideshowAction,
    deleteLabel: "Delete slideshow",
  },
};

// The ⋯ menu of an AI video or slideshow in the Clips page's lists: Cancel while it is waiting or being made, Delete
// once it is finished or failed. Delete also deletes the clip it made. Its entry is the list item it sits in.
export function JobMenu({ kind, jobId, title, busy, hasClip }: { kind: "ai" | "slideshow"; jobId: string; title: string; busy: boolean; hasClip: boolean }) {
  const submit = useRef<HTMLButtonElement>(null);
  const { name, cancel, cancelConfirm, remove, deleteLabel } = KINDS[kind];

  return (
    <>
      <div className={styles.jobMenu}>
        <Menu
          label={`Actions for ${title}`}
          items={[{ label: busy ? "Cancel…" : "Delete…", onSelect: () => submit.current!.form!.requestSubmit(), danger: true }]}
        />
      </div>
      {/* Sent from the menu, so its question and any error show with the entry. */}
      <ActionForm
        className={styles.jobForm}
        action={busy ? cancel : remove}
        confirm={
          busy
            ? cancelConfirm
            : { message: `Delete this ${name}?${hasClip ? " Its clip is deleted too." : ""}`, confirmLabel: deleteLabel }
        }
      >
        <input type="hidden" name="jobId" value={jobId} />
        <button ref={submit} type="submit" hidden />
      </ActionForm>
    </>
  );
}
