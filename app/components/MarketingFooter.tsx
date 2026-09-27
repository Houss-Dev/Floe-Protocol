"use client";
import Link from "next/link";
import { motion, useReducedMotion } from "motion/react";
import { ExternalLink } from "lucide-react";

import { FLOE_GITHUB_URL, FLOE_X_URL } from "../lib/brand";

const TICKER_ITEMS = [
  "Session-aware credit",
  "Dividends repay your debt",
  "Built on Solana",
  "Pre-IPO collateral",
];

export function MarketingFooter() {
  const reduce = useReducedMotion();
  const rise = reduce
    ? {}
    : {
        initial: { opacity: 0, y: 28 },
        whileInView: { opacity: 1, y: 0 },
        viewport: { once: true, margin: "-80px" },
        transition: { duration: 0.6, ease: [0.22, 1, 0.36, 1] as const },
      };

  return (
    <footer className="overflow-hidden bg-hot pt-14 sm:pt-16">
      <motion.div {...rise} className="ll-page flex flex-wrap items-start justify-between gap-6">
        <Link
          href="/dashboard"
          className="font-condensed text-6xl uppercase leading-[0.82] tracking-tight text-[#17110b] hover:opacity-80 sm:text-7xl md:text-8xl"
        >
          Launch the app <span className="inline-block">↗</span>
        </Link>
        <div className="flex flex-wrap gap-6 pt-2 text-sm font-bold tracking-wider text-[#17110b]">
          <Link href="/dashboard" className="hover:opacity-70">
            APP
          </Link>
          <a href={FLOE_GITHUB_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 hover:opacity-70">
            GITHUB <ExternalLink className="h-3 w-3" aria-hidden="true" />
          </a>
          <a href={FLOE_X_URL} target="_blank" rel="noreferrer" className="hover:opacity-70">
            @FLOEPROTOCOL
          </a>
        </div>
      </motion.div>

      {/* Marquee ticker */}
      <div className="mt-12 overflow-hidden border-t-2 border-[#17110b]/40 py-3.5">
        <div className="flex w-max animate-[marquee-scroll_22s_linear_infinite] items-center gap-6 whitespace-nowrap text-sm font-bold uppercase tracking-widest text-[#17110b]">
          {[...TICKER_ITEMS, ...TICKER_ITEMS].map((item, i) => (
            <span key={i} className="inline-flex items-center gap-6">
              {item}
              <span className="h-1 w-1 rounded-full bg-[#17110b]/50" aria-hidden="true" />
            </span>
          ))}
        </div>
      </div>

      {/* Giant wordmark */}
      <motion.div {...rise} className="ll-page mt-4">
        <div className="font-condensed select-none text-[9vw] uppercase leading-[0.78] tracking-tight text-[#17110b] sm:text-[6rem] md:text-[8rem] lg:text-[10rem]">
          Floe Protocol
        </div>
      </motion.div>
    </footer>
  );
}
