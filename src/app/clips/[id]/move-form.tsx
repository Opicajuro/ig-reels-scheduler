"use client";

import { ActionForm, SubmitButton } from "@/components/action-form";
import { EmptyState } from "@/components/empty-state";
import { Field } from "@/components/field";
import { copyClipsToProjectAction, moveClipsAction } from "../actions";
import styles from "../clips.module.css";

export type ProjectChoice = { id: string; name: string };

// Moves or copies clips to another project. A clip keeps its name there, or gets " (2)", " (3)"… when it is taken.
export function MoveForm({
  mode,
  clips,
  projectId,
  projects,
  busy,
}: {
  mode: "move" | "copy";
  clips: Array<{ id: string; name: string }>;
  projectId: string;
  projects: ProjectChoice[];
  busy: boolean;
}) {
  if (projects.length === 0) return <EmptyState>There is no other project yet to move or copy clips to.</EmptyState>;
  const one = clips.length === 1;
  const what = one ? clips[0].name : `${clips.length} clips`;
  const move = mode === "move";
  const hint = move
    ? `${one ? "It leaves" : "They leave"} this project.`
    : `${one ? "The copy keeps its" : "The copies keep their"} title, description and AI label.`;

  return (
    <ActionForm action={move ? moveClipsAction : copyClipsToProjectAction} className={styles.panel}>
      <input type="hidden" name="projectId" value={projectId} />
      {clips.map((clip) => (
        <input key={clip.id} type="hidden" name="clipId" value={clip.id} />
      ))}
      <Field label={`${move ? "Move" : "Copy"} ${what} to`} hint={hint}>
        <select name="targetProjectId" defaultValue="" required>
          <option value="" disabled>
            Choose a project
          </option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      </Field>
      <SubmitButton variant={move ? "primary" : undefined} disabled={busy} pendingLabel={move ? "Moving…" : "Copying…"}>
        {move ? "Move" : "Copy"}
      </SubmitButton>
    </ActionForm>
  );
}
