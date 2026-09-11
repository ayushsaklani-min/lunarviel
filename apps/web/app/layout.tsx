import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Lunarveil — Private markets. Verifiable execution.",
  description:
    "A privacy-preserving batch exchange on Midnight with cryptographically verified execution.",
  applicationName: "Lunarveil",
  openGraph: {
    title: "Lunarveil — Private markets. Verifiable execution.",
    description:
      "A privacy-preserving batch exchange on Midnight with cryptographically verified execution.",
    type: "website",
    images: [
      {
        url: "/lunarveil-social-card.png",
        width: 1728,
        height: 907,
        alt: "Lunarveil wordmark beside a veiled moon",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Lunarveil — Private markets. Verifiable execution.",
    description:
      "A privacy-preserving batch exchange on Midnight with cryptographically verified execution.",
    images: ["/lunarveil-social-card.png"],
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
