import { Suspense } from "react";
import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ToastProvider } from "@/components/toast";
import "./globals.css";
import { Nav } from "./nav";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  // Each page sets its own title; the home page shows the default.
  title: { template: "%s · Localirs", default: "Localirs" },
  description: "Cut long videos into clips and schedule them to Instagram Reels.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`}>
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
