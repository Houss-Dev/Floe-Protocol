import "./globals.css";

import type { Metadata, Viewport } from "next";

import { KitProvider } from "../components/KitProvider";

export const metadata: Metadata = {
  title: "Floe — spend your stocks, not sell them",
  applicationName: "Floe Protocol",
  description:
    "Floe Protocol: a credit line backed by tokenized stocks. SPYx and pre-IPO rounds as collateral, dividends as repayment.",
  icons: {
    icon: [{ url: "/favicon.svg", type: "image/svg+xml" }],
    shortcut: "/favicon.svg",
    apple: [{ url: "/favicon.svg", type: "image/svg+xml" }],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  themeColor: "#17110b",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body suppressHydrationWarning>
        <KitProvider>{children}</KitProvider>
      </body>
    </html>
  );
}
