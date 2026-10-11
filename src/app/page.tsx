import { Suspense } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { auth } from "@/auth";

// Where each part of the app is, in the order it's usually used. Clips come first: they work without a Meta app.
const DESTINATIONS = [
  {
    href: "/clips",
    title: "Clips",
    text: "Upload a long video, cut it into vertical clips, and download them with a posting sheet.",
    cta: "Make clips",
  },
  {
    href: "/dashboard",
    title: "Scheduled posts",
    text: "See what is queued for Instagram, what was published, and what failed.",
    cta: "Open schedule",
  },
  {
    href: "/posts/new",
    title: "New post",
    text: "Schedule a processed video as a Reel on one of your accounts.",
    cta: "Schedule a Reel",
  },
  {
    href: "/accounts",
    title: "Accounts",
    text: "Connect Instagram accounts, and pause, resume or disconnect them.",
    cta: "Manage accounts",
  },
];

async function SignedInHome() {
  await connection();
  const session = await auth();
  if (!session?.user) redirect("/login");

  return (
    <main className="home">
      <section className="hero">
        <p className="eyebrow">Signed in as {session.user.email}</p>
        <h1>What do you want to do?</h1>
      </section>
      <ul className="cards">
        {DESTINATIONS.map((destination) => (
          <li key={destination.href}>
            <Link href={destination.href} className="card">
              <h2>{destination.title}</h2>
              <p>{destination.text}</p>
              <span className="card-cta">{destination.cta} &rarr;</span>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}

export default function Home() {
  return (
    <Suspense fallback={<main className="home">Loading…</main>}>
      <SignedInHome />
    </Suspense>
  );
}
