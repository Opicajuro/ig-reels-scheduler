"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export const SECTIONS = [
  { href: "/clips", label: "Clips" },
  { href: "/scheduled", label: "Scheduled" },
  { href: "/accounts", label: "Accounts" },
  { href: "/settings", label: "Settings" },
  { href: "/help", label: "Help" },
] as const;

// The menu bar on every screen.
export function Nav() {
  const pathname = usePathname();

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
      </nav>
    </header>
  );
}
