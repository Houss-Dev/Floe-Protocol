"use client";

import { useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { ArrowRight, Clock } from "lucide-react";
import { ClientOnly } from "../../components/ClientOnly";
import { Reveal } from "../../components/Reveal";
import { PoweredByItem } from "../../components/PoweredByLogos";
import Link from "next/link";
import Image from "next/image";

// ── Sub-components ────────────────────────────────────────────────────────

function CountUp({
  to,
  prefix = "",
  suffix = "",
  decimals = 0,
}: {
  to: number;
  prefix?: string;
  suffix?: string;
  decimals?: number;
}) {
  const reduce = useReducedMotion();
  const ref = useRef<HTMLSpanElement>(null);
  const [value, setValue] = useState(reduce ? to : 0);
  const [started, setStarted] = useState(Boolean(reduce));

  useEffect(() => {
    const node = ref.current;
    if (!node || reduce) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setStarted(true);
          observer.disconnect();
        }
      },
      { threshold: 0.4 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [reduce]);

  useEffect(() => {
    if (!started || reduce) return;
    const start = performance.now();
    const duration = 1100;
    let frame = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - (1 - t) ** 3;
      setValue(to * eased);
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [started, reduce, to]);

  const shown = decimals > 0 ? value.toFixed(decimals) : String(Math.round(value));
  return (
    <span ref={ref}>
      {prefix}
      {shown}
      {suffix}
    </span>
  );
}

function ProtocolStat({
  label,
  hint,
  to,
  prefix,
  suffix,
  decimals = 0,
}: {
  label: string;
  hint?: string;
  to: number;
  prefix?: string;
  suffix?: string;
  decimals?: number;
}) {
  return (
    <div className="ll-stat text-center">
      <div className="text-2xl font-semibold tracking-tight text-foreground tabular-nums">
        <CountUp to={to} prefix={prefix} suffix={suffix} decimals={decimals} />
      </div>
      <div className="mt-1 text-sm font-medium text-muted">{label}</div>
      {hint && <div className="mt-0.5 text-sm text-faint">{hint}</div>}
    </div>
  );
}

function TierCard({
  category,
  title,
  description,
  tokens,
  href,
  index = 0,
}: {
  category: string;
  title: string;
  description: string;
  tokens: string[];
  href?: string;
  index?: number;
}) {
  return (
    <Reveal delay={index * 0.1} className="border-l border-line p-7 first:border-l-0">
      <p className="ll-pill">{category}</p>
      <h3 className="ll-content-title mt-3">{title}</h3>
      <p className="ll-content-body mt-3 min-h-[4.5rem]">{description}</p>
      <div className="mb-4 flex flex-wrap gap-2">
        {tokens.map((t) => (
          <span key={t} className="rounded-full border border-line px-3 py-1 text-xs font-semibold text-foreground/70">
            {t}
          </span>
        ))}
      </div>
      {href && (
        <Link href={href} className="text-sm font-bold text-hot hover:underline">
          Learn more →
        </Link>
      )}
    </Reveal>
  );
}

function UnderHoodCard({ title, body, index = 0 }: { title: string; body: string; index?: number }) {
  return (
    <Reveal delay={index * 0.1} className="flex h-full flex-col border-l border-line p-7 first:border-l-0">
      <div className="ll-content-title min-h-[7.5rem]">{title}</div>
      <div className="ll-content-body mt-3">{body}</div>
    </Reveal>
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
        <div className="relative left-1/2 flex min-h-[calc(100svh-4rem)] w-screen max-w-[100vw] -translate-x-1/2 flex-col justify-center bg-[#1a1a1a] px-6 py-8 text-center">
          <div className="mx-auto flex w-full max-w-5xl flex-col items-center">
            {/* Eyebrow */}
            <motion.p
              {...enter(0)}
              className="mb-4 inline-flex items-center gap-2 rounded-full border border-hot/40 bg-hot/10 px-3.5 py-1.5 text-xs font-medium text-hot"
            >
              <span aria-hidden="true" className="h-1.5 w-1.5 animate-pulse rounded-full bg-hot" />
              Live on Solana devnet · backed by real shares
            </motion.p>

            {/* Headline */}
            <motion.h1
              {...enter(0.08)}
              className="font-condensed text-balance text-7xl uppercase leading-[0.82] tracking-tight text-[#f4f0e5] sm:text-8xl md:text-9xl"
            >
              Spend your stocks.
              <br />
              <span className="text-hot">Not sell them.</span>
            </motion.h1>

            {/* Subline */}
            <motion.p
              {...enter(0.16)}
              className="mt-5 max-w-xl text-base leading-relaxed text-[#f4f0e5]/60 sm:text-lg"
            >
              A credit line backed by SPYx, QQQx, and pre-IPO rounds — sized by NYSE session,
              repaid automatically when dividends land.
            </motion.p>

            {/* CTAs */}
            <motion.div
              {...enter(0.24)}
              className="mt-6 flex flex-wrap items-center justify-center gap-3"
            >
              <Link
                href="/dashboard"
                className="group inline-flex items-center justify-center gap-2 rounded-full bg-[#f4f0e5] px-6 py-2.5 text-sm font-semibold text-[#1a1a1a] shadow-sm hover:opacity-90"
              >
                Open a line
                <ArrowRight
                  className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5"
                  aria-hidden="true"
                />
              </Link>
              <Link
                href="/dividends"
                className="inline-flex items-center justify-center rounded-full border border-[#f4f0e5]/25 px-6 py-2.5 text-sm font-medium text-[#f4f0e5] hover:bg-white/5"
              >
                How dividends work
              </Link>
            </motion.div>
          </div>
        </div>

        <div className="ll-on-ink bg-[#1a1a1a] pb-20">
          {/* ── SEE IT IN ACTION (real product screenshot) ──────────────────── */}
          <section className="ll-page pt-16">
            <Reveal className="mb-8 flex flex-col items-start justify-between gap-4 md:flex-row md:items-end">
              <div>
                <p className="ll-pill">See it in action</p>
                <h2 className="ll-content-title mt-2 text-4xl sm:text-5xl">The real dashboard, not a mockup</h2>
              </div>
              <Link href="/dashboard" className="text-sm font-bold text-hot hover:underline">
                Open the app →
              </Link>
            </Reveal>
            <Reveal delay={0.1} className="ll-ink-panel overflow-hidden rounded-2xl border shadow-2xl shadow-black/40">
              <Image
                src="/screenshots/dashboard-preview.png"
                alt="Floe dashboard showing an open credit line, line health, session-aware sizing, and collateral positions"
                width={2400}
                height={1350}
                className="h-auto w-full"
                priority={false}
              />
            </Reveal>
          </section>

          {/* ── PROTOCOL STATS ───────────────────────────────────────────────── */}
          <section className="ll-page pt-20">
            <Reveal className="mb-8">
              <p className="ll-pill">Onchain credit network</p>
              <h2 className="ll-content-title mt-2 text-4xl sm:text-5xl">Sized by session. Repaid by dividends.</h2>
            </Reveal>
            <Reveal>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4 md:gap-4">
                <ProtocolStat label="Collateral demo" to={7.5} prefix="$" suffix="K" decimals={1} hint="SPYx + QQQx + pre-IPO" />
                <ProtocolStat label="Max LTV (regular)" to={55} suffix="%" hint="NYSE session open" />
                <ProtocolStat label="Dividend fee" to={0.5} suffix="%" decimals={2} hint="Trim → USDC → debt" />
                <ProtocolStat label="Draw fee" to={0.25} suffix="%" decimals={2} hint="Keeper-signed spend" />
              </div>
            </Reveal>
          </section>

          {/* ── POWERED BY ───────────────────────────────────────────────────── */}
          <section className="ll-page pt-20">
            <Reveal className="mb-10">
              <p className="ll-pill">Powered by</p>
            </Reveal>
            <Reveal>
              <div className="flex flex-wrap items-center justify-start gap-x-12 gap-y-8">
                <PoweredByItem name="Solana" />
                <PoweredByItem name="Pyth Network" />
                <PoweredByItem name="Token-2022" />
                <PoweredByItem name="Anchor" />
              </div>
            </Reveal>
          </section>

          {/* ── HOW IT WORKS ─────────────────────────────────────────────────── */}
          <section className="ll-page pt-20">
            <Reveal className="mb-16">
              <h2 className="ll-section-title">Markets</h2>
              <p className="ll-content-body mt-4 max-w-xl">
                All markets — public equities, pre-IPO collateral, dividend routing, risk engine.
              </p>
            </Reveal>

            <Reveal className="mb-4">
              <p className="ll-pill">Markets for every strategy</p>
            </Reveal>
            <div className="ll-ink-panel grid divide-y divide-line border md:grid-cols-3 md:divide-x md:divide-y-0">
              <TierCard
                index={0}
                category="Public equities"
                title="Main"
                description="Broadest market: SPYx, QQQx, and listed tokenized stocks with session-aware LTV and Pyth equity feeds."
                tokens={["SPYx", "QQQx", "USDC"]}
                href="/dashboard"
              />
              <TierCard
                index={1}
                category="Pre-IPO collateral"
                title="Private marks"
                description="Closed-tier LTV only, 120s draw freshness, issuer divergence cap — dividends refused until IPO."
                tokens={["PRE1x", "USDC"]}
              />
              <TierCard
                index={2}
                category="Income routing"
                title="Dividend loop"
                description="ScaledUiAmount multiplier bumps become USDC — auto-repay debt or pay out to your wallet."
                tokens={["SPYx", "USDC"]}
                href="/dividends"
              />
            </div>
          </section>

          {/* ── PRE-IPO TIER ──────────────────────────────────────────────── */}
          <Reveal className="ll-page">
            <section className="mt-16">
              <div className="mb-9">
                <h2 className="ll-section-title">Pre-IPO tier</h2>
                <p className="ll-content-body mt-4 max-w-xl">
                  Private marks are promises, not market prints. Floe constrains pre-IPO
                  collateral so the uncertainty is bounded, not ignored.
                </p>
              </div>

              <div className="ll-ink-panel grid gap-10 border p-7 md:grid-cols-2 md:p-10">
                <div>
                  <p className="ll-pill mb-2">How it differs</p>
                  <ul>
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
                    ].map((item, i, arr) => (
                      <li
                        key={item.label}
                        className={`flex gap-4 py-4 ${i !== arr.length - 1 ? "border-b border-line" : ""}`}
                      >
                        <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-hot text-[11px] font-bold text-hot">
                          ✓
                        </span>
                        <div>
                          <div className="text-sm font-bold text-foreground">{item.label}</div>
                          <div className="ll-content-body mt-0.5">{item.desc}</div>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>

                <div className="space-y-5">
                  <div className="ll-ink-panel border p-6">
                    <div className="mb-5 flex items-center gap-2 text-sm font-bold text-foreground">
                      <Clock className="h-4 w-4 text-hot" aria-hidden="true" />
                      Draw freshness window
                    </div>
                    <div className="relative h-1.5 overflow-hidden rounded-full bg-surface3">
                      <div className="h-full w-[62%] rounded-full bg-hot" />
                    </div>
                    <div className="mt-3 flex justify-between text-sm text-faint">
                      <span>0s (draw submitted)</span>
                      <span className="text-hot">74s elapsed</span>
                      <span>120s (stale)</span>
                    </div>
                    <div className="ll-content-body mt-4">
                      The{" "}
                      <code className="rounded bg-surface3 px-1 py-0.5 font-mono text-sm text-hot">
                        PreIpoSizingStale
                      </code>{" "}
                      error fires when{" "}
                      <code className="rounded bg-surface3 px-1 py-0.5 font-mono text-sm text-[#f4f0e5]/80">
                        now - last_resize_ts &gt; 120
                      </code>
                      .
                    </div>
                  </div>

                  <div className="border border-hot/40 bg-hot/10 p-6">
                    <div className="ll-pill text-hot">Honest caveats</div>
                    <ul className="ll-content-body mt-3 space-y-1.5">
                      <li>— resize_line still trusts keeper-supplied marks (Pyth receiver CPI is next).</li>
                      <li>— Liquidation defers between threshold and hard floor — no book to hit.</li>
                      <li>— Decimals are read from the mint (6 / 8 / 9) — never assumed.</li>
                    </ul>
                  </div>
                </div>
              </div>
            </section>
          </Reveal>

          {/* ── UNDER THE HOOD ───────────────────────────────────────────────── */}
          <section className="ll-page pt-20">
            <Reveal className="mb-8">
              <p className="ll-pill">Under the hood</p>
            </Reveal>
            <div className="ll-ink-panel grid divide-y divide-line border sm:grid-cols-3 sm:divide-x sm:divide-y-0">
              <UnderHoodCard
                index={0}
                title="Session-aware LTV"
                body="NYSE Regular / Extended / Closed / Overnight sessions each carry a different haircut. The clock is read on-chain from Clock::get() — the keeper can't spoof it."
              />
              <UnderHoodCard
                index={1}
                title="Dividend auto-repayment"
                body="ScaledUiAmount multiplier bumps are the only trace of a dividend. We detect the bump, compute the trim, swap to USDC, and reduce debt — all in one idempotent transaction."
              />
              <UnderHoodCard
                index={2}
                title="Permissionless liquidation"
                body="Any liquidator can repay USDC and take collateral at a bonus from the vault. No DEX needed — the liquidator nets the full bonus, the borrower bears the issuer fee."
              />
            </div>
          </section>
        </div>

      </div>
    </ClientOnly>
  );
}
