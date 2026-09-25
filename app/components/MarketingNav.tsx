"use client";
import Link from "next/link";

import { FLOE_GITHUB_URL } from "../lib/brand";
import { FloeBrandIcon } from "./FloeBrandIcon";
export function MarketingNav() {
  return (
    <nav className="sticky top-0 z-40 border-b border-line bg-paper/90 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4">
        <Link href="/" className="flex items-center gap-2.5">
          <FloeBrandIcon size={28} />
          <span className="text-[15px] font-semibold tracking-tight text-foreground">Floe</span>
        </Link>
        <div className="flex items-center gap-2 text-sm">
          <a
            href={FLOE_GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            className="hidden rounded-full px-3.5 py-2 text-muted transition hover:bg-surface2 hover:text-foreground md:inline"
          >
            GitHub
          </a>
          <Link href="/dashboard" className="ll-btn-primary text-sm">
            Launch app
          </Link>
        </div>
      </div>
    </nav>
  );
}
