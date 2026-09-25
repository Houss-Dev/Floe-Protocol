import "./globals.css";

import type { Metadata, Viewport } from "next";

import { KitProvider } from "../components/KitProvider";



export const metadata: Metadata = {
  title: "Floe — spend your stocks, not sell them",
  applicationName: "Floe Protocol",
  description:
    "Floe Protocol: a credit line backed by tokenized stocks. SPYx and pre-IPO rounds as collateral, dividends as repayment.",
  icons: { icon: [{ url: "/floe-logo.png", type: "image/png" }] },
};



export const viewport: Viewport = {

  width: "device-width",

  initialScale: 1,

  maximumScale: 1,

  themeColor: "#ffffff",

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

