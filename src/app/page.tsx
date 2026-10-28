import Link from "next/link";
import { connection } from "next/server";

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
    href: "/accounts",
    title: "Accounts",
    text: "Connect Instagram accounts, and pause, resume or disconnect them.",
    cta: "Manage accounts",
  },
];

export default async function Home() {
  await connection();

  return (
    <main className="home">
      <section className="hero">
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
