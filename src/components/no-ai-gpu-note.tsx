import { aiGpuShortfall, NO_AI_GPU_NOTE, type GpuCheck } from "@/lib/ai-gpu";
import styles from "./no-ai-gpu-note.module.css";

// Why this PC makes no AI videos, said as information: most PCs cannot, and nothing is wrong with them.
export function NoAiGpuNote({ check }: { check: GpuCheck }) {
  const shortfall = aiGpuShortfall(check);
  return (
    <div className={styles.note}>
      <p>{NO_AI_GPU_NOTE}</p>
      {shortfall ? <p className={styles.shortfall}>{shortfall}</p> : null}
    </div>
  );
}
