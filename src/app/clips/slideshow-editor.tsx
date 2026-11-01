"use client";

import { useRef, useState } from "react";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Field } from "@/components/field";
import { MAX_LINE_LENGTH, MAX_PICTURE_LENGTH, VOICE_PRESETS, type Slide, type SlideSource } from "@/lib/slideshow-options";
import aiStyles from "./ai.module.css";
import { makeSlideshowAction } from "./slideshow-actions";
import styles from "./slideshow.module.css";
import { putFile } from "./upload-form";

// A clip or source video a slide's picture can be taken from, with a link to play it for picking the moment.
export type FrameMedia = { kind: "clip" | "video"; id: string; label: string; length: number; url: string };

const CAPTION_STYLES = [
  { value: "words", label: "Word by word" },
  { value: "classic", label: "Classic" },
  { value: "yellow", label: "Yellow" },
  { value: "box", label: "Box" },
];

type Choice = "frame" | "photo" | "ai";

function choiceOf(source: SlideSource | null): Choice | null {
  if (!source) return null;
  if (source.kind === "clip" || source.kind === "video") return "frame";
  return source.kind;
}

// The script writer's draft: every line and picture description can be edited, and each slide gets its picture from
// a moment of a clip or video, an uploaded photo, or the picture maker.
export function SlideshowEditor({
  jobId,
  initialSlides,
  initialVoice,
  initialCaptionPreset,
  media,
  canDraw,
}: {
  jobId: string;
  initialSlides: Slide[];
  initialVoice: string;
  initialCaptionPreset: string;
  media: FrameMedia[];
  canDraw: boolean;
}) {
  const [slides, setSlides] = useState(initialSlides);
  const update = (index: number, change: Partial<Slide>) =>
    setSlides((current) => current.map((slide, at) => (at === index ? { ...slide, ...change } : slide)));
  const anyAi = slides.some((slide) => slide.source?.kind === "ai");

  return (
    <ActionForm action={makeSlideshowAction} className={styles.editor}>
      <input type="hidden" name="jobId" value={jobId} />
      <input type="hidden" name="slides" value={JSON.stringify(slides)} />
      <ol className={styles.slides}>
        {slides.map((slide, index) => (
          <li key={index} className={styles.slide}>
            <Field label={`Slide ${index + 1}: what the voice says`}>
              <textarea
                rows={2}
                maxLength={MAX_LINE_LENGTH}
                value={slide.text}
                onChange={(event) => update(index, { text: event.target.value })}
                required
              />
            </Field>
            <Field label="Picture description" hint="Used when the picture is drawn with AI.">
              <textarea
                rows={2}
                maxLength={MAX_PICTURE_LENGTH}
                value={slide.picture}
                onChange={(event) => update(index, { picture: event.target.value })}
                required
              />
            </Field>
            <PicturePicker
              index={index}
              source={slide.source}
              media={media}
              canDraw={canDraw}
              onChange={(source) => update(index, { source })}
            />
          </li>
        ))}
      </ol>
      <div className={styles.options}>
        <Field label="Voice">
          <select name="voice" defaultValue={initialVoice}>
            {VOICE_PRESETS.map((voice) => (
              <option key={voice.id} value={voice.id}>
                {voice.label}
              </option>
            ))}
          </select>
        </Field>
        <div>
          <span className={aiStyles.label}>Caption style</span>
          <div className={aiStyles.choice}>
            {CAPTION_STYLES.map((style) => (
              <label key={style.value}>
                <input type="radio" name="captionPreset" value={style.value} defaultChecked={style.value === initialCaptionPreset} />
                <span>{style.label}</span>
              </label>
            ))}
          </div>
        </div>
      </div>
      {anyAi ? (
        <p className={aiStyles.madeWithAi}>
          Made with AI: a slideshow with a drawn picture is marked as AI-made in Localirs, and Instagram should be told
          when it is posted.
        </p>
      ) : null}
      <SubmitButton variant="primary" pendingLabel="Starting…">
        Make slideshow
      </SubmitButton>
    </ActionForm>
  );
}

function PicturePicker({
  index,
  source,
  media,
  canDraw,
  onChange,
}: {
  index: number;
  source: SlideSource | null;
  media: FrameMedia[];
  canDraw: boolean;
  onChange: (source: SlideSource | null) => void;
}) {
  const [choice, setChoice] = useState<Choice | null>(choiceOf(source));
  const [upload, setUpload] = useState<string | null>(null);
  const preview = useRef<HTMLVideoElement>(null);
  const picked =
    source?.kind === "clip" || source?.kind === "video"
      ? media.find((item) => item.kind === source.kind && item.id === (source.kind === "clip" ? source.clipId : source.projectId))
      : undefined;
  const at = source?.kind === "clip" || source?.kind === "video" ? source.at : 0;

  const frameSource = (item: FrameMedia, seconds: number): SlideSource =>
    item.kind === "clip" ? { kind: "clip", clipId: item.id, at: seconds } : { kind: "video", projectId: item.id, at: seconds };

  async function uploadPhoto(file: File) {
    setUpload("Uploading…");
    onChange(null);
    const dot = file.name.lastIndexOf(".");
    const started = await fetch("/api/slideshows/photo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ extension: dot > 0 ? file.name.slice(dot) : "" }),
    });
    if (!started.ok) {
      setUpload(await started.text());
      return;
    }
    const { key, uploadUrl, contentType } = (await started.json()) as { key: string; uploadUrl: string; contentType: string };
    try {
      await putFile(uploadUrl, file, contentType, (percent) => setUpload(`Uploading… ${percent}%`));
    } catch (err) {
      setUpload(err instanceof Error ? err.message : "the photo upload failed");
      return;
    }
    setUpload("Uploaded");
    onChange({ kind: "photo", key });
  }

  return (
    <div className={styles.picture}>
      <span className={aiStyles.label}>Picture</span>
      <div className={aiStyles.choice}>
        {(
          [
            { value: "frame", label: "Frame from a clip or video", disabled: media.length === 0 },
            { value: "photo", label: "Your photo", disabled: false },
            { value: "ai", label: "Draw with AI", disabled: !canDraw },
          ] as const
        ).map((option) => (
          <label key={option.value} title={option.value === "ai" && !canDraw ? "Install the picture maker in Settings first" : undefined}>
            <input
              type="radio"
              name={`picture-${index}`}
              value={option.value}
              checked={choice === option.value}
              disabled={option.disabled}
              onChange={() => {
                setChoice(option.value);
                setUpload(null);
                onChange(option.value === "ai" ? { kind: "ai" } : option.value === "frame" && media[0] ? frameSource(media[0], 0) : null);
              }}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
      {choice === "frame" && picked ? (
        <div className={styles.frame}>
          <select
            aria-label={`Clip or video for slide ${index + 1}`}
            value={`${picked.kind}:${picked.id}`}
            onChange={(event) => {
              const item = media.find((entry) => `${entry.kind}:${entry.id}` === event.target.value)!;
              onChange(frameSource(item, 0));
            }}
          >
            {media.map((item) => (
              <option key={`${item.kind}:${item.id}`} value={`${item.kind}:${item.id}`}>
                {item.label}
              </option>
            ))}
          </select>
          <video ref={preview} src={picked.url} preload="metadata" muted playsInline className={styles.preview} />
          <label className={styles.slider}>
            <span>
              Moment: {at.toFixed(1)} s of {picked.length} s
            </span>
            <input
              type="range"
              min={0}
              max={picked.length}
              step={0.1}
              value={at}
              onChange={(event) => {
                const seconds = Number(event.target.value);
                if (preview.current) preview.current.currentTime = seconds;
                onChange(frameSource(picked, seconds));
              }}
            />
          </label>
        </div>
      ) : null}
      {choice === "photo" ? (
        <div className={styles.frame}>
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            aria-label={`Photo for slide ${index + 1}`}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void uploadPhoto(file);
            }}
          />
          {upload ? <span className={aiStyles.meta}>{upload}</span> : null}
        </div>
      ) : null}
    </div>
  );
}
