import type { Metadata, Viewport } from "next";
import { Barlow, Barlow_Condensed } from "next/font/google";
import "./globals.css";

const barlow = Barlow({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-barlow",
  display: "swap",
});

const barlowCondensed = Barlow_Condensed({
  subsets: ["latin"],
  weight: ["600", "700"],
  variable: "--font-barlow-condensed",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Northside Appliance Repair — dispatch console",
  description:
    "A working AI voice agent for an appliance repair company. Triages the fault, quotes from a rate card, books a technician into Google Calendar and alerts dispatch.",
  robots: { index: true, follow: true },
  openGraph: {
    title: "AI voice agent — appliance repair dispatch",
    description: "Take a call end to end and watch the job card fill in as the agent works.",
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: "#10314d",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${barlow.variable} ${barlowCondensed.variable}`}>
      <body>{children}</body>
    </html>
  );
}
