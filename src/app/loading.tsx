import styles from "./loading.module.css";

// Shown while a page reads its data.
export default function Loading() {
  return (
    <main>
      <p className={styles.loading} role="status">
        Loading…
      </p>
    </main>
  );
}
