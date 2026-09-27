"use client";
import Link from "next/link";

import { FLOE_GITHUB_URL } from "../lib/brand";
import { FloeBrandIcon } from "./FloeBrandIcon";
export function MarketingNav() {
  return (
    <nav className="sticky top-0 z-40 border-b border-[#1a1a1a] bg-[#1a1a1a]">
      <div className="ll-page flex h-16 items-center justify-between">
        <Link href="/" className="flex items-center gap-3" aria-label="Floe home">
          <FloeBrandIcon size={40} ink="cream" />
          <span className="text-lg font-semibold leading-none tracking-tight text-[#f4f0e5]">Floe</span>
        </Link>
        <div className="flex items-center gap-2 text-sm font-semibold">
          <a
            href={FLOE_GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            className="hidden rounded-full px-3.5 py-2 text-[#f4f0e5] transition hover:bg-white/5 md:inline"
          >
            GitHub
          </a>
          <Link
            href="/dashboard"
            className="inline-flex items-center justify-center rounded-full bg-hot px-5 py-2 text-sm font-semibold text-[#f4f0e5] hover:opacity-90"
          >
            Launch app
          </Link>
        </div>
      </div>
    </nav>
  );
}
