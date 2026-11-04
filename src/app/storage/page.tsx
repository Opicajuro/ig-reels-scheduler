import type { ReactNode } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Alert } from "@/components/alert";
import { Button } from "@/components/button";
import { Card } from "@/components/card";
import { EmptyState } from "@/components/empty-state";
import { LocalTime } from "@/components/local-time";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { getAiEngine } from "@/lib/ai-engine";
import { formatBytes } from "@/lib/backup";
import { requireEnv } from "@/lib/env";
import { getOwnerId } from "@/lib/owner";
import { prisma } from "@/lib/prisma";
import { getSlideshowEngine, SLIDESHOW_ENGINE_IDS, SLIDESHOW_ENGINES } from "@/lib/slideshow-engines";
import { listObjects } from "@/lib/storage";
import {
  DEFAULT_BASE_CUT_DAYS,
  findOrphans,
  KEEP_NEWEST_BACKUPS,
  parseBaseCutDays,
  planBackups,
  planBaseCuts,
  planLogs,
  planTemp,
  type Plan,
} from "@/lib/storage-cleanup";
import { LOW_SPACE_BYTES, MIN_FREE_BYTES } from "@/lib/free-space";
import { cachedStorage, projectUsage, STORED_CATEGORIES, type StoredCategory } from "@/lib/storage-usage";
import { uninstallAiEngineAction } from "../settings/ai-actions";
import { uninstallSlideshowEngineAction } from "../settings/slideshow-actions";
import {
  cleanTempAction,
  deleteSourceAction,
  deleteStoredProjectAction,
  refreshStorageAction,
  removeBaseCutsAction,
  removeOldBackupsAction,
  removeOrphansAction,
  trimLogsAction,
} from "./actions";
import styles from "./storage.module.css";

export const metadata: Metadata = { title: "Storage" };

function files(count: number): string {
  return `${count} ${count === 1 ? "file" : "files"}`;
}

// formatBytes rounds up to 1 KB; nothing at all reads as nothing.
function size(bytes: number): string {
  return bytes === 0 ? "0 MB" : formatBytes(bytes);
}

// What a clean-up would free, or that there is nothing to do.
function planText(plan: Plan, unit: (count: number) => string = files): string {
  return plan.count === 0 ? "Nothing to remove." : `${unit(plan.count)}, ${formatBytes(plan.bytes)}.`;
}

// The days for "Caption-edit copies older than", from ?days=; the default when not given.
function baseCutDays(value: string | string[] | undefined): number {
  return value === undefined ? DEFAULT_BASE_CUT_DAYS : parseBaseCutDays(value);
}

export default async function StoragePage({ searchParams }: PageProps<"/storage">) {
  await connection();
  const ownerId = await getOwnerId();
  const dataDir = requireEnv("LOCALIRS_DATA_DIR");
  const now = new Date();
  const days = baseCutDays((await searchParams).days);

  const usage = await cachedStorage({ db: prisma, dataDir, list: listObjects, now });
  const [projects, orphans, baseCuts, backups, logs, temp, aiEngine, slideshowEngines] = await Promise.all([
    projectUsage(prisma, ownerId, usage.objects),
    findOrphans({ db: prisma, objects: usage.objects, now }),
    planBaseCuts({ db: prisma, objects: usage.objects, days, now }),
    planBackups({ db: prisma, dataDir }),
    planLogs({ dataDir }),
    planTemp({ dataDir, now }),
    getAiEngine(prisma),
    Promise.all(SLIDESHOW_ENGINE_IDS.map((id) => getSlideshowEngine(prisma, id))),
  ]);
  const orphanPlan = { count: orphans.length, bytes: orphans.reduce((sum, item) => sum + item.size, 0) };
  const slideshowBytes = SLIDESHOW_ENGINE_IDS.reduce((sum, id) => sum + usage.slideshowEngineBytes[id], 0);

  const totals: Array<{ label: string; bytes: number }> = [
    ...(Object.keys(STORED_CATEGORIES) as StoredCategory[]).map((category) => ({ label: STORED_CATEGORIES[category], bytes: usage.stored[category] })),
    { label: "AI video engine", bytes: usage.aiEngineBytes },
    { label: "Slideshow engines", bytes: slideshowBytes },
    { label: "Backups", bytes: usage.backupBytes },
    { label: "Logs", bytes: usage.logBytes },
    { label: "Temporary files", bytes: usage.tempBytes },
  ];
  const used = totals.reduce((sum, row) => sum + row.bytes, 0);
  const engines = [
    { id: "ai", name: "AI video engine", phrase: "the AI video engine", status: aiEngine.status, bytes: usage.aiEngineBytes, action: uninstallAiEngineAction, field: null, keeps: "AI videos" },
    ...slideshowEngines.map((engine, index) => ({
      id: engine.id,
      name: SLIDESHOW_ENGINES[SLIDESHOW_ENGINE_IDS[index]].name,
      phrase: `the ${SLIDESHOW_ENGINES[SLIDESHOW_ENGINE_IDS[index]].name.toLowerCase()}`,
      status: engine.status,
      bytes: usage.slideshowEngineBytes[SLIDESHOW_ENGINE_IDS[index]],
      action: uninstallSlideshowEngineAction,
      field: SLIDESHOW_ENGINE_IDS[index],
      keeps: "slideshows",
    })),
  ];

  return (
    <main>
      <Link href="/settings" className={styles.back}>
        ← Settings
      </Link>
      <PageHeader
        title="Storage"
        description={
          <>
            What takes space on this PC, and what can go. Measured <LocalTime date={usage.measuredAt} />.
          </>
        }
        actions={
          <ActionForm action={refreshStorageAction}>
            <SubmitButton pendingLabel="Measuring…">Refresh</SubmitButton>
          </ActionForm>
        }
      />

      {usage.freeBytes < LOW_SPACE_BYTES ? (
        <div className={styles.banner}>
          <Alert tone="error">
            Only {formatBytes(usage.freeBytes)} is free on the data drive. Below {formatBytes(MIN_FREE_BYTES)}, making clips,
            installing engines and making slideshows will not start. Free up space below.
          </Alert>
        </div>
      ) : null}

      <div className={styles.sections}>
        <Card>
          <div className={styles.stack}>
            <div className={styles.free}>
              <span className={styles.freeBytes}>{formatBytes(usage.freeBytes)}</span>
              <span className={styles.note}>
                free on the data drive (<code>{dataDir}</code>)
              </span>
            </div>
            <dl className={styles.totals}>
              {totals.map((row) => (
                <div key={row.label} className={styles.total}>
                  <dt>{row.label}</dt>
                  <dd>{size(row.bytes)}</dd>
                </div>
              ))}
              <div className={`${styles.total} ${styles.sum}`}>
                <dt>All of Localirs</dt>
                <dd>{formatBytes(used)}</dd>
              </div>
            </dl>
          </div>
        </Card>

        <section>
          <h2>Projects</h2>
          <p className={styles.note}>
            Deleting a source video keeps the project&apos;s clips, but Find highlights, making its clips again and taking a
            slideshow picture from the whole video no longer work. Not while clips are being made or highlights reviewed.
          </p>
          {projects.length === 0 ? (
            <EmptyState>No projects yet.</EmptyState>
          ) : (
            <Card>
              <ul className={styles.list}>
                {projects.map((project) => {
                  const busy = ["rendering", "picking", "review"].includes(project.status);
                  return (
                    <li key={project.id} className={styles.row}>
                      <div className={styles.what}>
                        <Link href={`/clips/${project.id}`}>{project.name}</Link>
                        <span className={styles.note}>
                          {project.hasSource
                            ? project.sourceDeletedAt
                              ? "Source deleted"
                              : `Source ${formatBytes(project.sourceBytes)}`
                            : "No source video"}
                          {" · "}Clips {size(project.clipsBytes)}
                        </span>
                      </div>
                      <div className={styles.buttons}>
                        {busy ? <StatusBadge status={project.status as "rendering" | "picking" | "review"} /> : null}
                        {project.hasSource && !project.sourceDeletedAt && project.sourceBytes > 0 ? (
                          <ActionForm
                            action={deleteSourceAction}
                            confirm={{
                              message: `Delete the source video of "${project.name}" and free ${formatBytes(project.sourceBytes)}? Its clips stay, but its highlights cannot be found and its clips cannot be made again.`,
                              confirmLabel: "Delete source video",
                            }}
                          >
                            <input type="hidden" name="projectId" value={project.id} />
                            <SubmitButton size="sm" variant="danger" disabled={busy} pendingLabel="Deleting…">
                              Delete source video
                            </SubmitButton>
                          </ActionForm>
                        ) : null}
                        <ActionForm
                          action={deleteStoredProjectAction}
                          confirm={{
                            message: `Delete "${project.name}" and all its clips, freeing ${formatBytes(project.sourceBytes + project.clipsBytes)}? This cannot be undone.`,
                            confirmLabel: "Delete project",
                          }}
                        >
                          <input type="hidden" name="projectId" value={project.id} />
                          <SubmitButton size="sm" variant="danger" disabled={busy && project.status !== "review"} pendingLabel="Deleting…">
                            Delete project
                          </SubmitButton>
                        </ActionForm>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </Card>
          )}
        </section>

        <section>
          <h2>Clean up</h2>
          <Card>
            <ul className={styles.list}>
              <CleanUp
                title="Old clip versions and orphaned files"
                about="Stored files no project, clip, post, AI video or slideshow uses any more, such as a clip's versions before its captions were edited. Only files older than a day."
                plan={orphanPlan}
                action={removeOrphansAction}
                confirmLabel="Remove files"
              />
              <CleanUp
                title={`Caption-edit copies older than ${days} days`}
                about="Each captioned clip keeps a copy without captions, for editing its captions. Without it, the Captions tab says to make the clips again to edit them."
                plan={baseCuts}
                action={removeBaseCutsAction}
                confirmLabel="Remove copies"
                days={days}
              >
                <form method="get" className={styles.days}>
                  <label>
                    Older than{" "}
                    <input type="number" name="days" min={1} max={3650} defaultValue={days} className={styles.daysInput} /> days
                  </label>
                  <Button type="submit" size="sm">
                    Check
                  </Button>
                </form>
              </CleanUp>
              <CleanUp
                title={`Backups beyond the newest ${KEEP_NEWEST_BACKUPS}`}
                about="The daily backups keep the newest 14. This keeps the newest 3."
                plan={backups}
                unit={(count) => `${count} ${count === 1 ? "backup" : "backups"}`}
                action={removeOldBackupsAction}
                confirmLabel="Remove backups"
              />
              <CleanUp
                title="Logs over 10 MB"
                about="Each is cut to its last 1 MB. A log Localirs is writing to right now is left as it is."
                plan={logs}
                unit={(count) => `${count} ${count === 1 ? "log" : "logs"}`}
                action={trimLogsAction}
                confirmLabel="Trim logs"
              />
              <CleanUp
                title="Temporary files"
                about="Left in the data folder's tmp folder and by stopped clip renders, untouched for an hour."
                plan={temp}
                unit={(count) => `${count} ${count === 1 ? "item" : "items"}`}
                action={cleanTempAction}
                confirmLabel="Remove files"
              />
            </ul>
          </Card>
        </section>

        <section>
          <h2>Engines</h2>
          <Card>
            <ul className={styles.list}>
              {engines.map((engine) => (
                <li key={engine.id} className={styles.row}>
                  <div className={styles.what}>
                    <strong>{engine.name}</strong>
                    <span className={styles.note}>{engine.bytes > 0 ? `${formatBytes(engine.bytes)} on disk` : "Nothing on disk"}</span>
                  </div>
                  <div className={styles.buttons}>
                    <StatusBadge status={engine.status} />
                    {engine.bytes > 0 && engine.status !== "installing" ? (
                      <ActionForm
                        action={engine.action}
                        confirm={{
                          message: `Delete ${engine.phrase} and free ${formatBytes(engine.bytes)}? The ${engine.keeps} already made stay in your clips.`,
                          confirmLabel: "Uninstall",
                        }}
                      >
                        {engine.field ? <input type="hidden" name="engine" value={engine.field} /> : null}
                        <SubmitButton size="sm" variant="danger" pendingLabel="Uninstalling…">
                          Uninstall
                        </SubmitButton>
                      </ActionForm>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        </section>
      </div>
    </main>
  );
}

function CleanUp({
  title,
  about,
  plan,
  unit,
  action,
  confirmLabel,
  days,
  children,
}: {
  title: string;
  about: string;
  plan: Plan;
  unit?: (count: number) => string;
  action: Parameters<typeof ActionForm>[0]["action"];
  confirmLabel: string;
  days?: number;
  children?: ReactNode;
}) {
  return (
    <li className={styles.row}>
      <div className={styles.what}>
        <strong>{title}</strong>
        <span className={styles.note}>{about}</span>
        {children}
        <span>{planText(plan, unit)}</span>
      </div>
      <ActionForm
        action={action}
        confirm={{ message: `${title}: ${(unit ?? files)(plan.count)}, freeing ${formatBytes(plan.bytes)}. This cannot be undone.`, confirmLabel }}
      >
        {days === undefined ? null : <input type="hidden" name="days" value={days} />}
        <SubmitButton size="sm" variant="danger" disabled={plan.count === 0} pendingLabel="Removing…">
          {confirmLabel}
        </SubmitButton>
      </ActionForm>
    </li>
  );
}
