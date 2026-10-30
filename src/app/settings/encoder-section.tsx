import { Card } from "@/components/card";
import { LocalTime } from "@/components/local-time";
import { prisma } from "@/lib/prisma";
import { getVideoEncoding, VIDEO_ENCODER_LABELS } from "@/lib/video-encoding";
import styles from "./settings.module.css";

// Which encoder makes the clips, as the worker found it at its last start.
export async function EncoderSection() {
  const encoding = await getVideoEncoding(prisma);

  return (
    <>
      <h2>Video encoding</h2>
      <Card>
        {encoding ? (
          <dl className={styles.facts}>
            <dt>Encoder</dt>
            <dd>{VIDEO_ENCODER_LABELS[encoding.encoder]}</dd>
            <dt>Checked</dt>
            <dd>When the worker started, <LocalTime date={encoding.checkedAt} /></dd>
          </dl>
        ) : (
          <p className={styles.note}>The worker has not started yet. It checks for NVIDIA or AMD graphics when it starts.</p>
        )}
        {encoding?.encoder === "x264" ? (
          <p className={styles.note}>
            Videos are encoded on the processor because ffmpeg could not encode on NVIDIA or AMD graphics. With such a
            graphics card, update its driver and restart the app to encode on the card.
          </p>
        ) : null}
      </Card>
    </>
  );
}
