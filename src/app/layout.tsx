import { Suspense, type CSSProperties } from "react";
import type { Metadata } from "next";
import { Bricolage_Grotesque, Instrument_Serif, JetBrains_Mono, Manrope, Unbounded } from "next/font/google";
import { connection } from "next/server";
import { ToastProvider } from "@/components/toast";
import { getAppearance } from "@/lib/appearance";
import { prisma } from "@/lib/prisma";
import "./globals.css";
import { Nav } from "./nav";

// The designs' typefaces (src/app/globals.css picks them per design).
const bricolage = Bricolage_Grotesque({ variable: "--font-bricolage", subsets: ["latin"] });
const instrumentSerif = Instrument_Serif({ variable: "--font-instrument-serif", subsets: ["latin"], weight: "400" });
const manrope = Manrope({ variable: "--font-manrope", subsets: ["latin"] });
const unbounded = Unbounded({ variable: "--font-unbounded", subsets: ["latin"] });
const jetbrainsMono = JetBrains_Mono({ variable: "--font-jetbrains-mono", subsets: ["latin"] });

const FONT_VARIABLES = [bricolage, instrumentSerif, manrope, unbounded, jetbrainsMono].map((font) => font.variable).join(" ");

export const metadata: Metadata = {
  // Each page sets its own title; the home page shows the default.
  title: { template: "%s · Localirs", default: "Localirs" },
  description: "Cut long videos into clips and schedule them to Instagram Reels.",
};

// The saved design is read for every request so the first paint already wears it, which makes every page wait for it.
export const instant = false;

export default async function RootLayout({ children }: LayoutProps<"/">) {
  await connection();
  const { design, palette, hue } = await getAppearance(prisma);

  return (
    <html
      lang="en"
      className={FONT_VARIABLES}
      data-design={design}
      data-palette={palette}
      style={{ "--hue": hue } as CSSProperties}
    >
      <body>
        <ToastProvider>
          {/* The menu reads the current address, which is only known per request. */}
          <Suspense fallback={null}>
            <Nav />
          </Suspense>
          {children}
        </ToastProvider>
      </body>
    </html>
  );
}
