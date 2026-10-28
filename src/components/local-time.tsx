"use client";

import { useSyncExternalStore } from "react";

function subscribe() {
  return () => {};
}

// A moment in the viewer's own timezone. The server does not know that timezone, so the server-rendered HTML shows
// UTC, and the browser swaps in local time as soon as it hydrates.
export function LocalTime({ date }: { date: Date }) {
  const inBrowser = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
  const text = inBrowser
    ? date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
    : `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
  return <time dateTime={date.toISOString()}>{text}</time>;
}
