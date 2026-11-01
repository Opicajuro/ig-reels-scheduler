"use client";

import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Button } from "@/components/button";
import {
  addHighlight,
  formatTime,
  HIGHLIGHT_STEP,
  moveHighlight,
  pxToSeconds,
  removeHighlight,
  resizeHighlight,
  secondsToPx,
  wordsInRange,
  type Highlight,
  type LengthLimits,
  type Word,
} from "@/lib/highlights";
import styles from "../clips.module.css";

// A pointer that went down on a highlight, or on one of its edges. Until it moves a few pixels it is a click, which
// previews the highlight.
type Drag = { index: number; edge: "move" | "start" | "end"; x: number; width: number; from: Highlight[]; moved: boolean };

const CLICK_PX = 3;
const TICKS = [0, 0.25, 0.5, 0.75, 1];

// The highlights "Find highlights" picked, as blocks on a timeline of the whole source video. A block is dragged to
// move it and by its edges to resize it, or with the arrow keys (shift resizes); clicking it plays that range of the
// source. The highlights go with the settings form's "Make clips", in a hidden field of that form.
export function HighlightReview({
  formId,
  durationSeconds,
  initial,
  limits,
  clipSeconds,
  sourceUrl,
  words,
}: {
  formId: string;
  durationSeconds: number;
  initial: Highlight[];
  limits: LengthLimits;
  clipSeconds: number;
  sourceUrl: string;
  words: Word[] | null;
}) {
  const [highlights, setHighlights] = useState(initial);
  const [selected, setSelected] = useState<number | null>(null);
  const [playhead, setPlayhead] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  // Where the preview of a highlight pauses.
  const stopAt = useRef<number | null>(null);

  const percent = (seconds: number) => `${secondsToPx(seconds, durationSeconds, 100)}%`;

  function requireVideo(): HTMLVideoElement {
    if (!video.current) throw new Error("the source video is not on the page");
    return video.current;
  }

  function seek(seconds: number) {
    requireVideo().currentTime = seconds;
    setPlayhead(seconds);
  }

  function preview(index: number) {
    const { start, length } = highlights[index];
    setSelected(index);
    stopAt.current = start + length;
    seek(start);
    requireVideo()
      .play()
      .catch((err: unknown) => {
        // A seek or pause before playback starts interrupts it, which is fine.
        if (!(err instanceof DOMException && err.name === "AbortError")) throw err;
      });
  }

  function update(next: Highlight[]) {
    setHighlights(next);
    setNote(null);
  }

  function remove(index: number) {
    update(removeHighlight(highlights, index));
    setSelected(null);
  }

  function add() {
    const next = addHighlight(highlights, playhead, clipSeconds, durationSeconds, limits);
    if (!next) {
      setNote(`No room for a highlight at ${formatTime(playhead)}: move the playhead to a free stretch of at least ${limits.min} seconds.`);
      return;
    }
    update(next);
    setSelected(next.findIndex((item) => !highlights.includes(item)));
  }

  function startDrag(event: PointerEvent<HTMLElement>, index: number, edge: Drag["edge"]) {
    if (event.button !== 0 || !track.current) return;
    // The track takes the pointer, so it gets the moves even when they leave the block.
    event.stopPropagation();
    track.current.setPointerCapture(event.pointerId);
    const width = track.current.getBoundingClientRect().width;
    drag.current = { index, edge, x: event.clientX, width, from: highlights, moved: false };
    setSelected(index);
  }

  function moveDrag(event: PointerEvent<HTMLDivElement>) {
    const current = drag.current;
    if (!current) return;
    const dx = event.clientX - current.x;
    if (!current.moved && Math.abs(dx) < CLICK_PX) return;
    current.moved = true;
    const delta = pxToSeconds(dx, durationSeconds, current.width);
    const { start, length } = current.from[current.index];
    update(
      current.edge === "move"
        ? moveHighlight(current.from, current.index, start + delta, durationSeconds)
        : resizeHighlight(
            current.from,
            current.index,
            current.edge,
            (current.edge === "start" ? start : start + length) + delta,
            durationSeconds,
            limits,
          ),
    );
  }

  function endDrag() {
    const current = drag.current;
    drag.current = null;
    if (current && !current.moved && current.edge === "move") preview(current.index);
  }

  function onKey(event: KeyboardEvent<HTMLDivElement>, index: number) {
    const { start, length } = highlights[index];
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      const delta = event.key === "ArrowLeft" ? -HIGHLIGHT_STEP : HIGHLIGHT_STEP;
      update(
        event.shiftKey
          ? resizeHighlight(highlights, index, "end", start + length + delta, durationSeconds, limits)
          : moveHighlight(highlights, index, start + delta, durationSeconds),
      );
    } else if (event.key === "Enter" || event.key === " ") {
      preview(index);
    } else if (event.key === "Delete" || event.key === "Backspace") {
      remove(index);
    } else {
      return;
    }
    event.preventDefault();
  }

  return (
    <section className={styles.review} aria-labelledby="highlights-heading">
      <input type="hidden" name="highlights" form={formId} value={JSON.stringify(highlights)} />
      <h2 id="highlights-heading">Highlights</h2>
      <p className={styles.muted} id="highlights-help">
        Drag a highlight to move it, or its edges to change its length ({limits.min} to {limits.max} seconds). Click it
        to play it. With a highlight focused, the arrow keys move it by half a second and shift with an arrow changes its
        length.
      </p>
      <video
        ref={video}
        className={styles.reviewVideo}
        src={sourceUrl}
        controls
        preload="metadata"
        onTimeUpdate={(event) => {
          const time = event.currentTarget.currentTime;
          setPlayhead(time);
          if (stopAt.current !== null && time >= stopAt.current) {
            stopAt.current = null;
            event.currentTarget.pause();
          }
        }}
      />
      <div
        ref={track}
        className={styles.timeline}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          const rect = event.currentTarget.getBoundingClientRect();
          stopAt.current = null;
          seek(Math.min(Math.max(pxToSeconds(event.clientX - rect.left, durationSeconds, rect.width), 0), durationSeconds));
        }}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={() => {
          drag.current = null;
        }}
      >
        {highlights.map((highlight, index) => (
          <div
            key={index}
            role="button"
            tabIndex={0}
            aria-describedby="highlights-help"
            aria-label={`Highlight ${index + 1}, ${formatTime(highlight.start)} to ${formatTime(highlight.start + highlight.length)}`}
            aria-pressed={selected === index}
            className={`${styles.block} ${selected === index ? styles.blockSelected : ""}`}
            style={{ left: percent(highlight.start), width: percent(highlight.length) }}
            onPointerDown={(event) => startDrag(event, index, "move")}
            onKeyDown={(event) => onKey(event, index)}
            onFocus={() => setSelected(index)}
          >
            <span className={`${styles.blockEdge} ${styles.blockStart}`} onPointerDown={(event) => startDrag(event, index, "start")} />
            <span className={styles.blockLabel}>{index + 1}</span>
            <span className={`${styles.blockEdge} ${styles.blockEnd}`} onPointerDown={(event) => startDrag(event, index, "end")} />
          </div>
        ))}
        <span className={styles.playhead} style={{ left: percent(playhead) }} aria-hidden="true" />
      </div>
      <div className={styles.ticks} aria-hidden="true">
        {TICKS.map((share) => (
          <span key={share}>{formatTime(Math.round(share * durationSeconds))}</span>
        ))}
      </div>
      <div className={styles.actions}>
        <Button type="button" size="sm" onClick={add}>
          Add highlight at {formatTime(Math.floor(playhead / HIGHLIGHT_STEP) * HIGHLIGHT_STEP)}
        </Button>
      </div>
      {note ? <p className={styles.warning}>{note}</p> : null}
      {highlights.length === 0 ? <p className={styles.muted}>No highlights. Add one at the playhead.</p> : null}
      <ol className={styles.highlightList}>
        {highlights.map((highlight, index) => {
          const said = words ? wordsInRange(words, highlight) : null;
          return (
            <li key={index} className={selected === index ? styles.highlightSelected : undefined}>
              <div className={styles.highlightRow}>
                <strong>Clip {index + 1}</strong>
                <span>
                  {formatTime(highlight.start)} – {formatTime(highlight.start + highlight.length)} · {highlight.length} s
                </span>
                <span className={styles.highlightButtons}>
                  <Button type="button" size="sm" onClick={() => preview(index)}>
                    Play
                  </Button>
                  <Button type="button" size="sm" variant="danger" onClick={() => remove(index)}>
                    Delete
                  </Button>
                </span>
              </div>
              {said === null ? null : <p className={styles.muted}>{said || "Nothing is said here."}</p>}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
