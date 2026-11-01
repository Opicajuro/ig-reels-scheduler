import { ActionForm, SubmitButton } from "@/components/action-form";
import { Alert } from "@/components/alert";
import { Card } from "@/components/card";
import { StatusBadge } from "@/components/status-badge";
import { formatGigabytes } from "@/lib/ai-engine";
import { prisma } from "@/lib/prisma";
import {
  engineDownloadBytes,
  engineFreeBytes,
  getSlideshowEngine,
  SLIDESHOW_ENGINES,
  slideshowDir,
  type SlideshowEngineId,
} from "@/lib/slideshow-engines";
import { EngineProgress } from "./engine-progress";
import { installSlideshowEngineAction, uninstallSlideshowEngineAction } from "./slideshow-actions";
import styles from "./settings.module.css";

const ABOUT: Record<SlideshowEngineId, string> = {
  script: "Writes a slideshow's lines and picture descriptions from a topic: llama.cpp (MIT) with the Qwen3.5 4B model (Apache-2.0).",
  picture:
    "Draws a slide's picture from its description: stable-diffusion.cpp (MIT) with the Z-Image Turbo model (Apache-2.0). A picture takes seconds on a gaming graphics card and a few minutes on a laptop.",
};

// The two offline engines of the Clips page's slideshows. They run on any graphics card (Vulkan), integrated or not.
// The voice ships with Localirs.
export async function SlideshowSection() {
  let dir: string | null = null;
  let dirProblem: string | null = null;
  try {
    dir = slideshowDir();
  } catch (err) {
    dirProblem = (err as Error).message;
  }
  return (
    <>
      <h2 id="slideshow-ai">Slideshow AI</h2>
      {dirProblem ? <Alert tone="error">{dirProblem}</Alert> : null}
      <div className={styles.cards}>
        {(["script", "picture"] as const).map((engine) => (
          <EngineCard key={engine} engine={engine} dir={dir} />
        ))}
      </div>
    </>
  );
}

async function EngineCard({ engine, dir }: { engine: SlideshowEngineId; dir: string | null }) {
  const manifest = SLIDESHOW_ENGINES[engine];
  const state = await getSlideshowEngine(prisma, engine);

  return (
    <Card>
      <div className={styles.stack}>
        <div className={styles.heading}>
          <h2>{manifest.name}</h2>
          <StatusBadge status={state.status} />
        </div>
        <p className={styles.note}>
          {ABOUT[engine]} Downloaded once into {dir ?? "the data folder"}.
        </p>
        {state.status === "installing" ? (
          <EngineProgress initialStep={state.step} initialPercent={state.percent} statusUrl={`/api/slideshows/engines/${engine}`} />
        ) : null}
        {state.status === "installed" && state.installedBytes !== null ? (
          <div className={styles.row}>
            <span>Installed, {formatGigabytes(state.installedBytes)} on disk.</span>
            <ActionForm
              action={uninstallSlideshowEngineAction}
              confirm={{
                message: `Delete the ${manifest.name.toLowerCase()} (${formatGigabytes(state.installedBytes)}) from this PC? The slideshows already made stay in your clips.`,
                confirmLabel: "Uninstall",
              }}
            >
              <input type="hidden" name="engine" value={engine} />
              <SubmitButton variant="danger" pendingLabel="Uninstalling…">
                Uninstall
              </SubmitButton>
            </ActionForm>
          </div>
        ) : null}
        {state.status === "failed" ? <Alert tone="error">The install stopped: {state.error}</Alert> : null}
        {(state.status === "not_installed" || state.status === "failed") && dir ? (
          <div className={styles.row}>
            <span>
              Downloads {formatGigabytes(engineDownloadBytes(manifest))} and needs {formatGigabytes(engineFreeBytes(manifest))} of free disk space.
              {state.status === "failed" ? " Files already downloaded are kept." : ""}
            </span>
            <ActionForm action={installSlideshowEngineAction}>
              <input type="hidden" name="engine" value={engine} />
              <SubmitButton variant="primary" pendingLabel="Starting…">
                {state.status === "failed" ? "Try again" : "Install"}
              </SubmitButton>
            </ActionForm>
          </div>
        ) : null}
      </div>
    </Card>
  );
}
