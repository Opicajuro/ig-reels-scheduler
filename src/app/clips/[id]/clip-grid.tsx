"use client";

import { useRef, useState, type MouseEvent } from "react";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { AiBadge } from "@/components/ai-badge";
import { Button } from "@/components/button";
import { Drawer } from "@/components/drawer";
import { EmptyState } from "@/components/empty-state";
import { Menu } from "@/components/menu";
import { PlatformChips } from "@/components/platform-links";
import { Tabs } from "@/components/tabs";
import { deleteClipAction, deleteClipsAction } from "../actions";
import { ClipDetails } from "./clip-details";
import { ClipLinks } from "./clip-links";
import { ExportForm } from "./export-form";
import { ScheduleForm } from "./schedule-form";
import { BulkScheduleForm } from "./bulk-schedule-form";
import { MoveForm, type ProjectChoice } from "./move-form";
import styles from "../clips.module.css";

export type ClipView = {
  id: string;
  name: string;
  start: number;
  length: number;
  title: string | null;
  description: string | null;
  aiGenerated: boolean;
  // Where the clip was posted outside Localirs.
  links: Array<{ id: string; url: string }>;
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

type DrawerTab = "details" | "move";

// Where a clip card shows its still: a moment into the clip, as the first frame is often black.
function stillAt(clip: ClipView): number {
  return Math.min(1, clip.length / 2);
}

// A clip card. It shows a still of the clip, a frame picked with a #t= media fragment, and loads the video only to
// play it muted while the pointer is over it. Clicking the card or its checkbox selects it; its own actions are in a
// ⋯ menu.
function ClipCard({
  clip,
  projectId,
  busy,
  picked,
  onPick,
  onOpen,
}: {
  clip: ClipView;
  projectId: string;
  busy: boolean;
  picked: boolean;
  onPick: (on: boolean) => void;
  onOpen: (tab: DrawerTab) => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const deleteButton = useRef<HTMLButtonElement>(null);

  function onCardClick(event: MouseEvent<HTMLElement>) {
    if ((event.target as Element).closest("a, button, input, label, [role=menu]")) return;
    onPick(!picked);
  }

  return (
    <article
      className={`${styles.clip} ${picked ? styles.selected : ""}`}
      onClick={onCardClick}
      onMouseEnter={() => {
        if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
        // Leaving the card before the video starts interrupts play(), which is expected.
        video.current!.play().catch((err: unknown) => {
          if (!(err instanceof DOMException && err.name === "AbortError")) throw err;
        });
      }}
      onMouseLeave={() => {
        video.current!.pause();
        video.current!.currentTime = stillAt(clip);
      }}
    >
      <div className={styles.thumb}>
        <video ref={video} src={`${clip.downloadUrl}#t=${stillAt(clip)}`} muted loop playsInline preload="metadata" />
        <label className={styles.pick}>
          <input
            type="checkbox"
            aria-label={`Select ${clip.name}`}
            checked={picked}
            onChange={(event) => onPick(event.target.checked)}
            onKeyDown={(event) => {
              if (event.key === "Enter") onPick(!picked);
            }}
          />
        </label>
        <div className={styles.clipMenu}>
          <Menu
            label={`Actions for ${clip.name}`}
            items={[
              { label: "Open", onSelect: () => onOpen("details") },
              { label: "Download", href: clip.downloadUrl, download: true },
              { label: "Move or copy…", onSelect: () => onOpen("move"), disabled: busy },
              { label: "Delete…", onSelect: () => deleteButton.current!.form!.requestSubmit(), disabled: busy, danger: true },
            ]}
          />
        </div>
      </div>
      <div className={styles.clipBody}>
        <strong>{clip.name}</strong>
        {clip.aiGenerated ? <AiBadge title="Made with AI" /> : null}
        <span className={styles.meta}>
          {formatTime(clip.start)} – {formatTime(clip.start + clip.length)}
        </span>
        <PlatformChips links={clip.links} />
      </div>
      {/* Sent from the menu's Delete, so its question and any error show on the card. */}
      <ActionForm
        action={deleteClipAction}
        confirm={{ message: `Delete ${clip.name}? This cannot be undone.`, confirmLabel: "Delete clip" }}
        className={styles.clipDelete}
      >
        <input type="hidden" name="clipId" value={clip.id} />
        <input type="hidden" name="projectId" value={projectId} />
        <button ref={deleteButton} type="submit" hidden />
      </ActionForm>
    </article>
  );
}

// Clips of one project. A clip opens in a drawer for its details, scheduling and moving; picked clips get a bar to
// download, schedule, move, copy or delete them together. Every change is a form posting to a server action.
export function ClipGrid({
  projectId,
  busy,
  clips,
  accounts,
  alreadyScheduledTo,
  projects,
}: {
  projectId: string;
  busy: boolean;
  clips: ClipView[];
  accounts: AccountView[];
  alreadyScheduledTo: string[];
  projects: ProjectChoice[];
}) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [openId, setOpenId] = useState<string | null>(null);
  const [openTab, setOpenTab] = useState<DrawerTab>("details");
  const [panel, setPanel] = useState<"export" | "schedule" | "move" | "copy" | null>(null);
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
            <ClipCard
              key={clip.id}
              clip={clip}
              projectId={projectId}
              busy={busy}
              picked={picked.has(clip.id)}
              onPick={(on) => togglePick(clip.id, on)}
              onOpen={(tab) => {
                setOpenId(clip.id);
                setOpenTab(tab);
              }}
            />
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
              <Button type="button" disabled={busy} onClick={() => setPanel("move")}>
                Move to project…
              </Button>
              <Button type="button" disabled={busy} onClick={() => setPanel("copy")}>
                Copy to project…
              </Button>
              <ActionForm
                action={deleteClipsAction}
                className={styles.dockForm}
                confirm={{
                  message: `Delete ${selected.length === 1 ? selected[0].name : `${selected.length} clips`}? This cannot be undone.`,
                  confirmLabel: selected.length === 1 ? "Delete clip" : "Delete clips",
                }}
              >
                <input type="hidden" name="projectId" value={projectId} />
                {selected.map((clip) => (
                  <input key={clip.id} type="hidden" name="clipId" value={clip.id} />
                ))}
                <SubmitButton variant="danger" disabled={busy} pendingLabel="Deleting…">
                  Delete selected
                </SubmitButton>
              </ActionForm>
              <Button type="button" variant="primary" onClick={() => setPanel("schedule")}>
                Schedule on Instagram
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      <Drawer open={openClip !== null} title={openClip?.name} onClose={() => setOpenId(null)}>
        {openClip ? <video key={openClip.id} className={styles.player} src={openClip.downloadUrl} controls playsInline /> : null}
        {openClip ? (
          <Tabs
            key={`${openClip.id}-${openTab}`}
            label="Clip"
            initial={openTab}
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
                    clipAiGenerated={openClip.aiGenerated}
                    alreadyScheduledTo={alreadyScheduledTo}
                  />
                ),
              },
              {
                id: "links",
                label: "Links",
                content: <ClipLinks clip={openClip} projectId={projectId} />,
              },
              {
                id: "move",
                label: "Move or copy",
                content: (
                  <div className={styles.panel}>
                    <MoveForm mode="move" clips={[openClip]} projectId={projectId} projects={projects} busy={busy} />
                    {projects.length > 0 ? (
                      <MoveForm mode="copy" clips={[openClip]} projectId={projectId} projects={projects} busy={busy} />
                    ) : null}
                  </div>
                ),
              },
            ]}
          />
        ) : null}
      </Drawer>

      <Drawer open={panel === "export"} title="Download for posting" onClose={() => setPanel(null)}>
        <ExportForm projectId={projectId} clips={selected} />
      </Drawer>

      <Drawer open={panel === "move"} title="Move to project" onClose={() => setPanel(null)}>
        <MoveForm mode="move" clips={selected} projectId={projectId} projects={projects} busy={busy} />
      </Drawer>

      <Drawer open={panel === "copy"} title="Copy to project" onClose={() => setPanel(null)}>
        <MoveForm mode="copy" clips={selected} projectId={projectId} projects={projects} busy={busy} />
      </Drawer>

      <Drawer open={panel === "schedule"} title="Schedule on Instagram" onClose={() => setPanel(null)}>
        <BulkScheduleForm
          projectId={projectId}
          clips={selected.map((clip) => ({
            id: clip.id,
            name: clip.name,
            caption: captionOf(clip),
            aiGenerated: clip.aiGenerated,
          }))}
          accounts={accounts}
          alreadyScheduledTo={alreadyScheduledTo}
        />
      </Drawer>
    </>
  );
}
