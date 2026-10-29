"use client";

import { ActionForm, SubmitButton } from "@/components/action-form";
import { Field } from "@/components/field";
import type { ActionResult } from "@/lib/action-result";
import { putFile } from "../clips/upload-form";
import { createAiVideoAction } from "./actions";
import styles from "./ai.module.css";

const LENGTHS = [3, 5];

// A start picture goes to storage first, the way clip uploads do; the action gets its storage key, not the file.
async function sendNewVideo(previous: ActionResult, formData: FormData): Promise<ActionResult> {
  const picture = formData.get("startImage");
  formData.delete("startImage");
  if (picture instanceof File && picture.size > 0) {
    const dot = picture.name.lastIndexOf(".");
    const started = await fetch("/api/ai/start-image", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ extension: dot > 0 ? picture.name.slice(dot) : "" }),
    });
    if (!started.ok) return { ok: false, error: await started.text() };
    const { key, uploadUrl, contentType } = (await started.json()) as { key: string; uploadUrl: string; contentType: string };
    try {
      await putFile(uploadUrl, picture, contentType, () => {});
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "the picture upload failed" };
    }
    formData.set("startImageKey", key);
  }
  return createAiVideoAction(previous, formData);
}

export function NewVideoForm({ maxPromptLength }: { maxPromptLength: number }) {
  return (
    <ActionForm action={sendNewVideo} className={styles.form}>
      <Field label="Describe the video" hint="What is in it, how it moves, and how the camera moves. English works best.">
        <textarea
          name="prompt"
          rows={4}
          maxLength={maxPromptLength}
          required
          placeholder="A red fox walks through fresh snow at sunrise, slow camera pan to the right"
        />
      </Field>
      <Field label="Start picture (optional)" hint="The video starts from this picture. PNG, JPEG or WebP.">
        <input type="file" name="startImage" accept="image/png,image/jpeg,image/webp" />
      </Field>
      <div>
        <span className={styles.label}>Length</span>
        <div className={styles.choice}>
          {LENGTHS.map((seconds) => (
            <label key={seconds}>
              <input type="radio" name="seconds" value={seconds} defaultChecked={seconds === 5} />
              <span>{seconds} s</span>
            </label>
          ))}
        </div>
      </div>
      <p className={styles.madeWithAi}>
        Made with AI: the video is marked as AI-made in Localirs, and Instagram should be told when it is posted.
      </p>
      <SubmitButton variant="primary" pendingLabel="Starting…">
        Make video
      </SubmitButton>
    </ActionForm>
  );
}
