"use client";

import { useRef, useState } from "react";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Button } from "@/components/button";
import { renameProjectAction } from "../actions";
import styles from "../clips.module.css";

// The project's name as the page title. Clicking it turns it into a field: Enter saves, Escape puts the name back.
export function ProjectTitle({ projectId, name, busy }: { projectId: string; name: string; busy: boolean }) {
  const [editing, setEditing] = useState(false);
  // Leaving the field gives focus back to the title.
  const refocus = useRef(false);

  function finish() {
    refocus.current = true;
    setEditing(false);
  }

  if (!editing) {
    return (
      <button
        ref={(button) => {
          if (button && refocus.current) {
            refocus.current = false;
            button.focus();
          }
        }}
        type="button"
        className={styles.titleButton}
        aria-label={`Rename project ${name}`}
        title={busy ? "Wait for the clips to be made to rename the project" : "Rename"}
        disabled={busy}
        onClick={() => setEditing(true)}
      >
        {name}
      </button>
    );
  }
  return (
    <ActionForm action={renameProjectAction} onDone={finish} className={styles.titleForm}>
      <input type="hidden" name="projectId" value={projectId} />
      <input
        type="text"
        name="name"
        aria-label="Project name"
        defaultValue={name}
        maxLength={120}
        required
        autoFocus
        onFocus={(event) => event.currentTarget.select()}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            finish();
          }
        }}
      />
      <SubmitButton size="sm" variant="primary" pendingLabel="Saving…">
        Save
      </SubmitButton>
      <Button type="button" size="sm" onClick={finish}>
        Cancel
      </Button>
    </ActionForm>
  );
}
