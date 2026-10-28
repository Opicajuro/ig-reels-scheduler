"use client";

import { useState } from "react";
import { Button } from "@/components/button";
import { Drawer } from "@/components/drawer";
import { EmptyState } from "@/components/empty-state";
import { Tabs } from "@/components/tabs";
import { ClipDetails } from "./clip-details";
import { ExportForm } from "./export-form";
import { ScheduleForm } from "./schedule-form";
import { BulkScheduleForm } from "./bulk-schedule-form";
import styles from "../clips.module.css";

export type ClipView = {
  id: string;
  name: string;
  start: number;
  length: number;
  title: string | null;
  description: string | null;
  downloadUrl: string;
};

export type AccountView = { id: string; username: string };

function formatTime(seconds: number): string {
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

// What a clip is posted with on Instagram, the same fallback the server uses.
function captionOf(clip: ClipView): string {
  return clip.description || clip.title || clip.name;
}

// Clips of one project. A clip opens in a drawer for its details and scheduling; picked clips get a bar to download
// or schedule them together. Every change is a form posting to a server action.
export function ClipGrid({
  projectId,
  busy,
  clips,
  accounts,
  alreadyScheduledTo,
}: {
  projectId: string;
  busy: boolean;
  clips: ClipView[];
  accounts: AccountView[];
  alreadyScheduledTo: string[];
}) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [openId, setOpenId] = useState<string | null>(null);
  const [panel, setPanel] = useState<"export" | "schedule" | null>(null);
  // Read through the current clips, so a clip deleted or replaced since it was picked or opened drops out.
  const selected = clips.filter((clip) => picked.has(clip.id));
  const openClip = clips.find((clip) => clip.id === openId) ?? null;
  // A panel for an empty selection closes, so it does not open again by itself on the next pick.
  if (panel !== null && selected.length === 0) setPanel(null);

  function togglePick(clipId: string, on: boolean) {
    setPicked((current) => {
      const next = new Set(current);
      if (on) {
        next.add(clipId);
      } else {
        next.delete(clipId);
      }
      return next;
    });
  }

  return (
    <>
      {clips.length === 0 ? (
        <EmptyState>No clips yet. Choose the settings and make clips.</EmptyState>
      ) : (
        <div className={styles.clips}>
          {clips.map((clip) => (
            <article key={clip.id} className={`${styles.clip} ${picked.has(clip.id) ? styles.selected : ""}`}>
              <video src={clip.downloadUrl} controls playsInline preload="metadata" />
              <div className={styles.clipBody}>
                <strong>{clip.name}</strong>
                <span className={styles.meta}>
                  {formatTime(clip.start)} – {formatTime(clip.start + clip.length)}
                </span>
              </div>
              <div className={styles.clipActions}>
                <label className={styles.pick}>
                  <input
                    type="checkbox"
                    aria-label={`Select ${clip.name}`}
                    checked={picked.has(clip.id)}
                    onChange={(event) => togglePick(clip.id, event.target.checked)}
                  />
                  Select
                </label>
                <Button type="button" aria-label={`Open ${clip.name}`} onClick={() => setOpenId(clip.id)}>
                  Open
                </Button>
              </div>
            </article>
          ))}
        </div>
      )}

      {selected.length > 0 ? (
        <div className={styles.dock} role="region" aria-label="Selected clips">
          <div className={styles.dockInner}>
            <div className={styles.dockCount}>
              <strong>
                {selected.length} {selected.length === 1 ? "clip" : "clips"} selected
              </strong>
              <Button type="button" size="sm" onClick={() => setPicked(new Set())}>
                Clear
              </Button>
            </div>
            <div className={styles.dockActions}>
              <Button type="button" onClick={() => setPanel("export")}>
                Download for posting (ZIP)
              </Button>
              <Button type="button" variant="primary" onClick={() => setPanel("schedule")}>
                Schedule on Instagram
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      <Drawer open={openClip !== null} title={openClip?.name} onClose={() => setOpenId(null)}>
        {openClip ? (
          <Tabs
            key={openClip.id}
            label="Clip"
            tabs={[
              {
                id: "details",
                label: "Details",
                content: <ClipDetails clip={openClip} projectId={projectId} busy={busy} />,
              },
              {
                id: "instagram",
                label: "Instagram",
                content: (
                  <ScheduleForm
                    clipId={openClip.id}
                    projectId={projectId}
                    accounts={accounts}
                    defaultCaption={captionOf(openClip)}
                    alreadyScheduledTo={alreadyScheduledTo}
                  />
                ),
              },
            ]}
          />
        ) : null}
      </Drawer>

      <Drawer open={panel === "export"} title="Download for posting" onClose={() => setPanel(null)}>
        <ExportForm projectId={projectId} clips={selected} />
      </Drawer>

      <Drawer open={panel === "schedule"} title="Schedule on Instagram" onClose={() => setPanel(null)}>
        <BulkScheduleForm
          projectId={projectId}
          clips={selected.map((clip) => ({ id: clip.id, name: clip.name, caption: captionOf(clip) }))}
          accounts={accounts}
          alreadyScheduledTo={alreadyScheduledTo}
        />
      </Drawer>
    </>
  );
}
