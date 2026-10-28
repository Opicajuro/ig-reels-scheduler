import Link from "next/link";
import { PageHeader } from "@/components/page-header";

export default function NotFound() {
  return (
    <main>
      <PageHeader title="Page not found" description="This page does not exist, or what it showed was deleted." />
      <Link href="/">Go to the start page</Link>
    </main>
  );
}
