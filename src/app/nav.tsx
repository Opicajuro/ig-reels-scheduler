"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOutAction } from "./auth-actions";

export const SECTIONS = [
  { href: "/clips", label: "Clips" },
  { href: "/dashboard", label: "Scheduled" },
  { href: "/posts/new", label: "New post" },
  { href: "/accounts", label: "Accounts" },
] as const;

// The menu bar on every signed-in screen. The sign-in page has no menu, since nothing behind it works yet.
export function Nav() {
  const pathname = usePathname();
  if (pathname === "/login") return null;

  return (
    <header className="topbar">
      <nav className="topbar-inner" aria-label="Main">
        <Link href="/" className="brand">
          <span className="brand-mark" aria-hidden="true" />
          Localirs
        </Link>
        <ul className="topbar-links">
          {SECTIONS.map((section) => {
            const active = pathname === section.href || pathname.startsWith(`${section.href}/`);
            return (
              <li key={section.href}>
                <Link href={section.href} className={active ? "active" : undefined} aria-current={active ? "page" : undefined}>
                  {section.label}
                </Link>
              </li>
            );
          })}
        </ul>
        <form action={signOutAction}>
          <button type="submit" className="ghost">
            Sign out
          </button>
        </form>
      </nav>
    </header>
  );
}
