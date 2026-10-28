import styles from "./post.module.css";

const BAR_WIDTH = 14;
const GAP = 6;
const HEIGHT = 28;

// A tiny bar chart of one metric across the insight pulls, each bar scaled to the metric's highest value.
export function InsightBars({ label, pulls, values }: { label: string; pulls: string[]; values: Array<number | null> }) {
  const max = Math.max(1, ...values.map((value) => value ?? 0));
  const width = values.length * (BAR_WIDTH + GAP) - GAP;
  const summary = values.map((value, index) => `${pulls[index]}: ${value ?? "none"}`).join(", ");
  return (
    <svg className={styles.bars} width={width} height={HEIGHT} viewBox={`0 0 ${width} ${HEIGHT}`} role="img">
      <title>{`${label}: ${summary}`}</title>
      {values.map((value, index) => {
        const height = Math.max(2, ((value ?? 0) / max) * HEIGHT);
        return (
          <rect key={pulls[index]} x={index * (BAR_WIDTH + GAP)} y={HEIGHT - height} width={BAR_WIDTH} height={height} rx={2} />
        );
      })}
    </svg>
  );
}
