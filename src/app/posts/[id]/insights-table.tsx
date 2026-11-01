import { EmptyState } from "@/components/empty-state";
import type { InsightTable } from "@/lib/insights";
import { InsightBars } from "./insight-bars";
import styles from "./post.module.css";

// A post's insight pulls: a column per pull, a row per metric, with a trend.
export function InsightsTable({ insights }: { insights: InsightTable }) {
  if (insights.rows.length === 0) {
    return <EmptyState>No insights yet. They are pulled 1 hour, 24 hours and 7 days after publishing.</EmptyState>;
  }
  return (
    <div className={styles.tableWrap}>
      <table>
        <thead>
          <tr>
            <th>Metric</th>
            {insights.pulls.map((pull) => (
              <th key={pull} className={styles.number}>
                {pull}
              </th>
            ))}
            <th>Trend</th>
          </tr>
        </thead>
        <tbody>
          {insights.rows.map((row) => (
            <tr key={row.metric}>
              <td>{row.label}</td>
              {row.values.map((value, index) => (
                <td key={insights.pulls[index]} className={styles.number}>
                  {value === null ? "–" : value.toLocaleString("en")}
                </td>
              ))}
              <td>
                <InsightBars label={row.label} pulls={insights.pulls} values={row.values} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
