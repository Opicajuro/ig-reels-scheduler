"use client";

import { useEffect } from "react";
import { Button } from "@/components/button";
import { PageHeader } from "@/components/page-header";

// Shown when a page or an action fails in a way the app did not expect. The details go to the browser console.
export default function ErrorPage({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main>
      <PageHeader title="Something went wrong" description="Localirs hit a problem it did not expect. Try again; if it keeps happening, restart Localirs." />
      <Button variant="primary" onClick={() => retry()}>
        Try again
      </Button>
    </main>
  );
}
