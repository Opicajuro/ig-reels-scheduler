import { existsSync } from "node:fs";
import path from "node:path";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Alert } from "@/components/alert";
import { Card } from "@/components/card";
import { Field } from "@/components/field";
import { LocalTime } from "@/components/local-time";
import { folderBytes, formatBytes, getBackupSettings, KEEP_BACKUPS, pendingRestore } from "@/lib/backup";
import { prisma } from "@/lib/prisma";
import { backUpNowAction, restoreBackupAction, saveBackupSettingsAction } from "./backup-actions";
import styles from "./backups-section.module.css";

const LISTED_BACKUPS = 30;

// The daily backups: where they go, whether they copy the clips, "Back up now", and the list with Restore.
export async function BackupsSection() {
  const dataDir = process.env.LOCALIRS_DATA_DIR;
  if (!dataDir) {
    return (
      <>
        <h2 id="backups">Backups</h2>
        <Alert tone="error">LOCALIRS_DATA_DIR is not set. The installer writes it to .env; for development, add it to .env.</Alert>
      </>
    );
  }
  const settings = await getBackupSettings(prisma, dataDir);
  const storage = path.join(dataDir, "seaweedfs");
  const clipBytes = existsSync(storage) ? await folderBytes(storage) : null;
  const restore = await pendingRestore(dataDir);
  const backups = await prisma.backup.findMany({ orderBy: { startedAt: "desc" }, take: LISTED_BACKUPS });

  return (
    <>
      <h2 id="backups">Backups</h2>
      <div className={styles.cards}>
        {restore ? (
          <Alert tone="info">
            The backup in <code>{restore.backupPath}</code> is restored the next time Localirs starts. Quit Localirs from its
            tray icon and open it again.
          </Alert>
        ) : null}
        <Card>
          <ActionForm action={saveBackupSettingsAction} className={styles.stack}>
            <p className={styles.note}>
              Every day at 03:30 (or as soon as Localirs starts, if the PC was off then) Localirs saves its database and
              settings to the backup folder and keeps the newest {KEEP_BACKUPS} backups. A folder on another drive keeps
              them safe if this one fails.
            </p>
            <Field label="Backup folder" hint="Leave empty for the backups folder in the data folder.">
              <input name="folder" defaultValue={settings.folder} autoComplete="off" spellCheck={false} />
            </Field>
            <label className={styles.toggle}>
              <input type="checkbox" name="includeClips" defaultChecked={settings.includeClips} />
              <span>
                Also back up clips and videos
                <small>
                  {clipBytes === null
                    ? "There is no file storage in the data folder, so there is nothing to copy."
                    : `They take ${formatBytes(clipBytes)} now. Each backup copies all of them again, so ${KEEP_BACKUPS} backups need about ${formatBytes(clipBytes * KEEP_BACKUPS)}.`}
                </small>
              </span>
            </label>
            <div>
              <SubmitButton variant="primary" pendingLabel="Saving…">
                Save backup settings
              </SubmitButton>
            </div>
          </ActionForm>
        </Card>
        <Card>
          <div className={styles.stack}>
            <div className={styles.row}>
              <h2>Backups made</h2>
              <ActionForm action={backUpNowAction}>
                <SubmitButton pendingLabel="Starting…">Back up now</SubmitButton>
              </ActionForm>
            </div>
            {backups.length === 0 ? <p className={styles.note}>No backups yet.</p> : null}
            <ul className={styles.list}>
              {backups.map((backup) => (
                <li key={backup.id} className={styles.row}>
                  <div className={styles.backup}>
                    <span>
                      <LocalTime date={backup.startedAt} />
                      {backup.status === "ok" && backup.sizeBytes !== null ? ` · ${formatBytes(Number(backup.sizeBytes))}` : ""}
                      {backup.includeClips ? " · with clips" : ""}
                    </span>
                    <code>{backup.path}</code>
                    {backup.status === "running" ? <span className={styles.note}>Running…</span> : null}
                    {backup.status === "failed" ? <span className={styles.error}>Failed: {backup.error}</span> : null}
                  </div>
                  {backup.status === "ok" ? (
                    <ActionForm
                      action={restoreBackupAction}
                      confirm={{
                        message:
                          "Restore this backup? Everything since it was made is lost: posts, clips, accounts and settings go back to how they were then." +
                          (backup.includeClips ? "" : " Clip and video files are not in this backup, so ones deleted since then stay deleted.") +
                          " Localirs restores it the next time it starts.",
                        confirmLabel: "Restore",
                      }}
                    >
                      <input type="hidden" name="backupId" value={backup.id} />
                      <SubmitButton variant="danger" pendingLabel="Preparing…">
                        Restore
                      </SubmitButton>
                    </ActionForm>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        </Card>
      </div>
    </>
  );
}
