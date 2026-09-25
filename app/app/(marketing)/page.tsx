"use client";

import { motion, useReducedMotion } from "motion/react";
import { ArrowRight, TrendingUp, Zap, ShieldCheck, Clock } from "lucide-react";
import { SonarGrid } from "../../components/ui/sonar-grid";
import { ClientOnly } from "../../components/ClientOnly";
import Link from "next/link";

import { FLOE_GITHUB_URL } from "../../lib/brand";

// ── Sub-components ────────────────────────────────────────────────────────

function ProtocolStat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="ll-stat text-center">
      <div className="text-2xl font-semibold tracking-tight text-foreground tabular-nums">{value}</div>
      <div className="mt-1 text-xs font-medium text-muted">{label}</div>
      {hint && <div className="mt-0.5 text-[11px] text-faint">{hint}</div>}
    </div>
  );
}

function FeatureCard({
  icon: Icon,
  title,
  body,
  tint = "purple",
}: {
  icon: React.ElementType;
  title: string;
  body: string;
  tint?: "purple" | "green" | "blue";
}) {
  const iconBg =
    tint === "green" ? "bg-accent/15 text-accent" : tint === "blue" ? "bg-info/15 text-info" : "bg-accent2/15 text-accent2";
  return (
    <div className="ll-card p-5">
      <div className={`mb-3 flex h-9 w-9 items-center justify-center rounded-xl ${iconBg}`}>
        <Icon size={18} aria-hidden="true" />
      </div>
      <div className="text-sm font-semibold text-foreground">{title}</div>
      <div className="mt-1 text-sm leading-relaxed text-muted">{body}</div>
    </div>
  );
}

function MarketModule({
  category,
  title,
  description,
  variant,
  tokens,
  href,
}: {
  category: string;
  title: string;
  description: string;
  variant: "purple" | "green" | "blue" | "amber";
  tokens: { sym: string; color: string }[];
  href?: string;
}) {
  const wrap = `ll-market-card--${variant}`;
  return (
    <div className={wrap}>
      <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">{category}</p>
      <h3 className="mt-2 text-lg font-semibold tracking-tight text-foreground">{title}</h3>
      <p className="mt-2 flex-1 text-sm leading-relaxed text-muted">{description}</p>
      <div className="mt-4 flex flex-wrap gap-2">
        {tokens.map((t) => (
          <span
            key={t.sym}
            className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-1 text-xs font-medium text-foreground shadow-sm"
          >
            <span className={`h-2 w-2 rounded-full ${t.color}`} aria-hidden="true" />
            {t.sym}
          </span>
        ))}
      </div>
      {href && (
        <Link href={href} className="mt-4 text-sm font-semibold text-accent2 hover:underline">
          Learn more →
        </Link>
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────

export default function LandingPage() {
  const reduce = useReducedMotion();

  const enter = (delay: number) =>
    reduce
      ? {}
      : {
          initial: { opacity: 0, y: 14, filter: "blur(6px)" },
          animate: { opacity: 1, y: 0, filter: "blur(0px)" },
          transition: { duration: 0.6, delay, ease: [0.22, 1, 0.36, 1] as const },
        };

  return (
    <ClientOnly>
      <div className="space-y-0">
        {/* ── HERO ──────────────────────────────────────────────────────── */}
        <SonarGrid
          ringWidth={90}
          speed={260}
          amplitude={2.2}
          pingEvery={2.4}
          interactive
          spacing={26}
          baseOpacity={0.14}
          pingArea={[0.22, 0.18, 0.78, 0.82]}
          className="-mx-4 flex min-h-[max(580px,100svh)] w-[calc(100%+2rem)] flex-col"
        >
          {/* Radial wash keeps text legible through the grid */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_38%_32%_at_50%_52%,var(--color-paper)_0%,transparent_100%)]"
          />
          {/* Top vignette */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 top-0 h-32 bg-gradient-to-b from-paper to-transparent"
          />
          {/* Bottom vignette */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 h-32 bg-gradient-to-t from-paper to-transparent"
          />

          <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col items-center justify-center px-6 py-24 text-center">
            {/* Eyebrow */}
            <motion.p
              {...enter(0)}
              className="mb-5 inline-flex items-center gap-2 rounded-full border border-accent/30 bg-tint-green px-3.5 py-1.5 text-xs font-medium text-accent backdrop-blur"
            >
              <span aria-hidden="true" className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
              Live on Solana devnet · backed by real shares
            </motion.p>

            {/* Headline */}
            <motion.h1
              {...enter(0.08)}
              className="text-5xl font-semibold tracking-tight text-balance text-foreground sm:text-6xl md:text-7xl"
            >
              Spend your stocks.
              <br />
              <span className="bg-brand-gradient bg-clip-text text-transparent">
                Not sell them.
              </span>
            </motion.h1>

            {/* Subline */}
            <motion.p
              {...enter(0.16)}
              className="mt-6 max-w-lg text-base leading-relaxed text-muted sm:text-lg"
            >
              A credit line backed by SPYx, QQQx, and pre-IPO rounds — sized by NYSE session,
              repaid automatically when dividends land.
            </motion.p>

            {/* CTAs */}
            <motion.div
              {...enter(0.24)}
              className="mt-9 flex flex-wrap items-center justify-center gap-3"
            >
              <Link href="/dashboard" className="ll-btn-dark group">
                Open a line
                <ArrowRight
                  className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5"
                  aria-hidden="true"
                />
              </Link>
              <Link href="/dividends" className="ll-btn-secondary">
                How dividends work
              </Link>
            </motion.div>
          </div>
        </SonarGrid>

        {/* ── PROTOCOL STATS (Aave network band) ─────────────────────────── */}
        <section className="-mx-4 mt-2 rounded-2xl border border-line bg-surface2 px-4 py-10 md:px-8">
          <p className="ll-pill text-center">Onchain credit network</p>
          <h2 className="mt-2 text-center text-2xl font-semibold tracking-tight text-foreground">
            Sized by session. Repaid by dividends.
          </h2>
          <div className="mx-auto mt-8 grid max-w-4xl grid-cols-2 gap-3 md:grid-cols-4 md:gap-4">
            <ProtocolStat label="Collateral demo" value="$7.5K" hint="SPYx + QQQx + pre-IPO" />
            <ProtocolStat label="Max LTV (regular)" value="55%" hint="NYSE session open" />
            <ProtocolStat label="Dividend fee" value="0.50%" hint="Trim → USDC → debt" />
            <ProtocolStat label="Draw fee" value="0.25%" hint="Keeper-signed spend" />
          </div>
        </section>

        {/* ── MARKETS (Aave multi-color modules) ─────────────────────────── */}
        <section className="pt-14">
          <p className="ll-pill">Markets for every strategy</p>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight text-foreground md:text-3xl">
            Collateral tiers that match how you borrow
          </h2>
          <p className="mt-2 max-w-2xl text-sm text-muted">
            From liquid tokenized ETFs to pre-IPO marks — each tier has its own LTV, freshness rules, and dividend policy.
          </p>
          <div className="mt-8 grid gap-4 md:grid-cols-3">
            <MarketModule
              category="Public equities"
              title="Main"
              description="Broadest market: SPYx, QQQx, and listed tokenized stocks with session-aware LTV and Pyth equity feeds."
              variant="purple"
              tokens={[
                { sym: "SPYx", color: "bg-info" },
                { sym: "QQQx", color: "bg-accent2" },
                { sym: "USDC", color: "bg-accent" },
              ]}
              href="/dashboard"
            />
            <MarketModule
              category="Pre-IPO collateral"
              title="Private marks"
              description="Closed-tier LTV only, 120s draw freshness, issuer divergence cap — dividends refused until IPO."
              variant="amber"
              tokens={[
                { sym: "PRE1x", color: "bg-warn" },
                { sym: "USDC", color: "bg-accent" },
              ]}
            />
            <MarketModule
              category="Income routing"
              title="Dividend loop"
              description="ScaledUiAmount multiplier bumps become USDC — auto-repay debt or pay out to your wallet."
              variant="green"
              tokens={[
                { sym: "SPYx", color: "bg-info" },
                { sym: "USDC", color: "bg-accent" },
              ]}
              href="/dividends"
            />
          </div>
        </section>

        {/* ── PROMO BAND ─────────────────────────────────────────────────── */}
        <section className="mt-14 overflow-hidden rounded-2xl bg-brand-gradient p-8 text-white md:p-10">
          <div className="flex flex-wrap items-center justify-between gap-6">
            <div className="max-w-lg">
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-white/70">Floe app</p>
              <h2 className="mt-2 text-2xl font-semibold tracking-tight md:text-3xl">The full power of onchain credit</h2>
              <p className="mt-2 text-sm text-white/80">
                Deposit tokenized stocks, resize by session, draw at point of sale, harvest dividends — built on Solana with
                fixed-point math only.
              </p>
            </div>
            <div className="flex flex-wrap gap-3">
              <Link href="/dashboard" className="rounded-full bg-white px-6 py-2.5 text-sm font-semibold text-accent2 shadow-sm hover:bg-white/95">
                Get started
              </Link>
              <a
                href={FLOE_GITHUB_URL}
                target="_blank"
                rel="noreferrer"
                className="rounded-full border border-white/35 px-6 py-2.5 text-sm font-medium text-white hover:bg-white/10"
              >
                View on GitHub
              </a>
            </div>
          </div>
        </section>

        {/* ── PRE-IPO TIER ──────────────────────────────────────────────── */}
        <section className="pt-10">
          <div className="mb-5">
            <p className="ll-pill">Pre-IPO collateral</p>
            <h2 className="mt-1 text-2xl font-semibold tracking-tight text-foreground">
              Pre-IPO tier
            </h2>
            <p className="mt-1 max-w-lg text-sm text-muted">
              Private marks are promises, not market prints. Floe constrains pre-IPO
              collateral so the uncertainty is bounded, not ignored.
            </p>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="ll-card p-6">
              <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-foreground">
                <ShieldCheck className="h-4 w-4 text-accent2" aria-hidden="true" />
                How it differs
              </div>
              <ul className="space-y-3 text-sm">
                {[
                  {
                    label: "25% LTV — closed tier always",
                    desc: "Session clock doesn't matter. The most conservative haircut, always.",
                  },
                  {
                    label: "120-second draw window",
                    desc: "Keeper must re-size within 2 minutes of draw. Stale sizing = no draw.",
                  },
                  {
                    label: "Issuer divergence cap",
                    desc: "If our mark diverges >10% from the issuer's own number, sizing freezes.",
                  },
                  {
                    label: "No dividends until IPO",
                    desc: "harvest_dividend is refused outright — multiplier bumps don't accrue.",
                  },
                ].map((item) => (
                  <li key={item.label} className="flex gap-3">
                    <span className="mt-0.5 h-4 w-4 shrink-0 rounded-full border border-accent2/30 bg-accent2/15 text-center text-[10px] leading-4 text-accent2">
                      ✓
                    </span>
                    <div>
                      <div className="font-medium text-foreground">{item.label}</div>
                      <div className="text-xs text-muted">{item.desc}</div>
                    </div>
                  </li>
                ))}
              </ul>
            </div>

            <div className="space-y-4">
              <div className="ll-card p-5">
                <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-foreground">
                  <Clock className="h-4 w-4 text-warn" aria-hidden="true" />
                  Draw freshness window
                </div>
                <div className="relative h-2 overflow-hidden rounded-full bg-surface3">
                  <div className="h-full w-[62%] rounded-full bg-gradient-to-r from-warn to-accent2" />
                </div>
                <div className="mt-2 flex justify-between text-[11px] text-faint">
                  <span>0s (draw submitted)</span>
                  <span className="text-warn">74s elapsed</span>
                  <span>120s (stale)</span>
                </div>
                <div className="mt-3 text-xs text-muted">
                  The{" "}
                  <code className="rounded bg-surface3 px-1 py-0.5 font-mono text-[11px] text-accent2">
                    PreIpoSizingStale
                  </code>{" "}
                  error fires when{" "}
                  <code className="rounded bg-surface3 px-1 py-0.5 font-mono text-[11px]">
                    now - last_resize_ts &gt; 120
                  </code>
                  .
                </div>
              </div>

              <div className="rounded-card border border-warn/30 bg-tint-amber p-5">
                <div className="text-sm font-semibold text-warn">Honest caveats</div>
                <ul className="mt-2 list-disc space-y-1 pl-4 text-xs text-muted">
                  <li>
                    resize_line still trusts keeper-supplied marks (Pyth receiver CPI is next).
                  </li>
                  <li>Liquidation defers between threshold and hard floor — no book to hit.</li>
                  <li>Decimals are read from the mint (6 / 8 / 9) — never assumed.</li>
                </ul>
              </div>
            </div>
          </div>
        </section>

        {/* ── FEATURE HIGHLIGHTS ────────────────────────────────────────── */}
        <section className="pt-10">
          <p className="ll-pill mb-4">Under the hood</p>
          <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3">
            <FeatureCard
              icon={TrendingUp}
              title="Session-aware LTV"
              tint="purple"
              body="NYSE Regular / Extended / Closed / Overnight sessions each carry a different haircut. The clock is read on-chain from Clock::get() — the keeper can't spoof it."
            />
            <FeatureCard
              icon={Zap}
              title="Dividend auto-repayment"
              tint="green"
              body="ScaledUiAmount multiplier bumps are the only trace of a dividend. We detect the bump, compute the trim, swap to USDC, and reduce debt — all in one idempotent transaction."
            />
            <FeatureCard
              icon={ShieldCheck}
              title="Permissionless liquidation"
              tint="blue"
              body="Any liquidator can repay USDC and take collateral at a bonus from the vault. No DEX needed — the liquidator nets the full bonus, the borrower bears the issuer fee."
            />
          </div>
        </section>

      </div>
    </ClientOnly>
  );
}
