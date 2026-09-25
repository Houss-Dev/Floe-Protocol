import Link from "next/link";
import { ExternalLink } from "lucide-react";

import { FLOE_GITHUB_URL, FLOE_X_URL } from "../lib/brand";

export function MarketingFooter() {
  return (
    <footer className="border-t border-line bg-surface2/80">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-10 md:flex-row md:items-center md:justify-between">
        <div>
          <p className="text-sm font-semibold text-foreground">Floe Protocol</p>
          <p className="mt-1 max-w-sm text-xs leading-relaxed text-muted">
            Onchain credit backed by tokenized stocks — sized by session, repaid by dividends.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-4 text-sm">
          <Link href="/dashboard" className="font-medium text-accent2 hover:underline">
            Launch app
          </Link>
          <a
            href={FLOE_GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-muted transition hover:text-foreground"
          >
            <ExternalLink className="h-4 w-4" aria-hidden="true" />
            GitHub
          </a>
          <a
            href={FLOE_X_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-muted transition hover:text-foreground"
          >
            <span className="flex h-4 w-4 items-center justify-center text-[11px] font-bold leading-none" aria-hidden="true">
              𝕏
            </span>
            @Floeprotocol
          </a>
        </div>
      </div>
    </footer>
  );
}
