"use client";

import { useState } from "react";

// A datetime-local value has no timezone, so the browser turns it into an absolute time before it is sent.
// Without this, the server would read the time in its own timezone.
export function PublishAtInput() {
  const [when, setWhen] = useState("");
  return (
    <>
      <label>
        Publish at (your local time)
        <input type="datetime-local" value={when} onChange={(event) => setWhen(event.target.value)} required />
      </label>
      <input type="hidden" name="scheduledAt" value={when ? new Date(when).toISOString() : ""} />
    </>
  );
}
