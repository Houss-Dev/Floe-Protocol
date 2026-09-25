"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Zap } from "lucide-react";
import { SessionBanner, useSession } from "../../../components/SessionBanner";
import { HealthRing } from "../../../components/HealthRing";
import { DislocationBadge } from "../../../components/DislocationBadge";
import { DevnetSandboxLazy } from "../../../components/DevnetSandboxLazy";
import { devnetSandboxEnabled } from "../../../lib/flags";
import { ClientOnly } from "../../../components/ClientOnly";
import { DEMO, usdc6 } from "../../../lib/constants";
import { useConnectedWallet } from "@solana/kit-plugin-wallet/react";
import { client } from "../../../lib/solana";

export default function DashboardPage() {
  const session = useSession();
  const connected = useConnectedWallet(client);
  const [debt, setDebt] = useState(0);
  const [toast, setToast] = useState<string | null>(null);

  const ltvForSession = (s: string) => {
    if (s === "Regular") return DEMO.ltvRegularBps;
    if (s === "Closed") return DEMO.ltvClosedBps;
    return DEMO.ltvExtendedBps;
  };
  const ltv = ltvForSession(session);
  const collateralUsd = DEMO.collateralUsd * 1_000_000;
  const limit = Math.floor((collateralUsd * ltv) / 10_000);
  const available = Math.max(0, limit - debt);
  const ltvBps = debt === 0 ? 0 : Math.floor((debt * 10_000) / collateralUsd);

  const rows = useMemo(
    () => [
      {
        mint: DEMO.collateralTicker,
        label: "SPDR S&P 500",
        raw: "10.000000",
        shares: "10.000",
        mult: "1.000",
        value: collateralUsd,
        dislocation: 12,
        tier: "public" as const,
      },
      {
        mint: "QQQx",
        label: "Invesco QQQ",
        raw: "5.000000",
        shares: "5.035",
        mult: "1.007",
        value: 2_500_000_000,
        dislocation: -38,
        tier: "public" as const,
      },
      {
        mint: "PRE1x",
        label: "Pre-IPO Round A",
        raw: "1000.000000",
        shares: "1000.000",
        mult: "1.000",
        value: 1_250_000_000,
        dislocation: 0,
        tier: "pre-ipo" as const,
      },
    ],
    [collateralUsd],
  );

  return (
    <ClientOnly>
      <div className="mx-auto max-w-5xl space-y-8">
        <div>
          <p className="pro-pill">Dashboard</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-pro-text md:text-3xl">Your credit line</h1>
          <p className="mt-1 text-sm text-pro-muted">
            {connected?.account
              ? "Connected — actions below use your wallet on devnet."
              : "Connect your wallet to open a line, deposit collateral, and draw."}
          </p>
        </div>

        {!connected?.account && (
          <div className="pro-card border-accent2/30 bg-accent2/10 p-4 text-sm text-pro-muted">
            Connect in the top right to interact with the program. Demo numbers below illustrate session-aware sizing.
          </div>
        )}

        <div className="grid gap-4 lg:grid-cols-3">
          <div className="pro-card border-accent/25 bg-pro-elevated p-6 lg:col-span-2">
            <div className="inline-flex items-center gap-2 rounded-full bg-accent/15 px-2.5 py-1 text-xs font-semibold text-accent">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
              Available to spend
            </div>
            <div className="mt-3 text-4xl font-semibold tabular-nums tracking-tight text-pro-text md:text-5xl">
              {usdc6(available)}
            </div>
            <div className="mt-2 text-sm text-pro-muted">
              Limit {usdc6(limit)} · Debt {usdc6(debt)} · {(ltv / 100).toFixed(0)}% LTV · {session}
            </div>
            <div className="mt-6 flex flex-wrap gap-2">
              <Link href="/spend" className="pro-btn-primary">
                Spend
              </Link>
              <button type="button" className="pro-btn-secondary" suppressHydrationWarning>
                Repay
              </button>
              <button type="button" className="pro-btn-secondary" suppressHydrationWarning>
                Deposit
              </button>
              <button
                type="button"
                suppressHydrationWarning
                onClick={() => {
                  const fee = Math.floor(200_000_000 * 0.0025);
                  const total = 200_000_000 + fee;
                  if (available < total) setToast("Insufficient credit — resize first or repay");
                  else {
                    setDebt((d) => d + total);
                    setToast(`Drew $200 (fee $0.50). Debt now ${usdc6(debt + total)}.`);
                  }
                  setTimeout(() => setToast(null), 3000);
                }}
                className="pro-btn-secondary text-xs"
              >
                Simulate draw $200
              </button>
            </div>
            {toast && <div className="mt-3 rounded-lg bg-pro-hover px-3 py-2 text-xs text-pro-text">{toast}</div>}
          </div>

          <div className="pro-card p-5">
            <div className="text-xs text-pro-muted">Line health</div>
            <div className="mt-2">
              <HealthRing ltvBps={ltvBps} theme="pro" />
            </div>
          </div>
        </div>

        <div className="pro-card p-4">
          <div className="mb-2 text-xs text-pro-muted">Session-aware sizing</div>
          <SessionBanner session={session} theme="pro" />
        </div>

        <section>
          <div className="mb-4 flex items-end justify-between gap-3">
            <div>
              <p className="pro-pill">Collateral</p>
              <h2 className="text-lg font-semibold text-pro-text">Your positions</h2>
            </div>
            <span className="rounded-full border border-pro-border bg-pro-elevated px-3 py-1 text-xs text-pro-muted">
              3 assets
            </span>
          </div>
          <div className="pro-card overflow-hidden">
            <div className="grid grid-cols-[1fr_auto_auto] border-b border-pro-border px-4 py-2 text-[10px] font-semibold uppercase tracking-wider text-pro-faint sm:grid-cols-[1fr_auto_auto_auto]">
              <span>Asset</span>
              <span className="hidden sm:block">Shares</span>
              <span>Value</span>
              <span>Disloc.</span>
            </div>
            <div className="divide-y divide-pro-border">
              {rows.map((r) => (
                <div
                  key={r.mint}
                  className="grid grid-cols-[1fr_auto_auto] items-center gap-4 p-4 transition hover:bg-pro-hover sm:grid-cols-[1fr_auto_auto_auto]"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="grid h-10 w-10 place-items-center rounded-lg bg-brand-gradient font-mono text-xs font-bold text-white">
                      {r.mint.slice(0, 3)}
                    </div>
                    <div>
                      <div className="text-sm font-medium text-pro-text">{r.mint}</div>
                      <div className="text-xs text-pro-muted">{r.label}</div>
                    </div>
                  </div>
                  <div className="hidden text-sm text-pro-muted sm:block">{r.shares}</div>
                  <div className="text-sm font-semibold tabular-nums text-pro-text">{usdc6(r.value)}</div>
                  <DislocationBadge bps={r.dislocation} />
                </div>
              ))}
            </div>
          </div>
        </section>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="pro-card p-5">
            <div className="mb-3 text-sm font-semibold text-pro-text">Risk parameters</div>
            <div className="grid grid-cols-3 gap-2 text-xs">
              {[
                ["LTV Regular", "55%"],
                ["LTV Extended", "45%"],
                ["LTV Closed", "30%"],
                ["Draw fee", "0.25%"],
                ["Div fee", "0.50%"],
                ["Pre-IPO LTV", "25%"],
              ].map(([k, v]) => (
                <div key={k} className="pro-card-inset p-2.5">
                  <div className="text-pro-faint">{k}</div>
                  <div className="font-semibold text-pro-text">{v}</div>
                </div>
              ))}
            </div>
          </div>
          <div className="pro-card border-accent/25 p-5">
            <div className="flex items-center gap-2 text-sm font-semibold text-pro-text">
              <Zap className="h-4 w-4 text-accent" />
              Dividend loop
            </div>
            <p className="mt-2 text-sm text-pro-muted">
              Last trim ~${DEMO.nextDividendUsd} routed to repay debt when multiplier bumps.
            </p>
            <Link href="/dividends" className="pro-btn-secondary mt-4 inline-flex text-xs">
              Dividends →
            </Link>
          </div>
        </div>

        {devnetSandboxEnabled && (
          <section id="devnet" className="scroll-mt-8">
            <p className="pro-pill mb-3">Devnet</p>
            <DevnetSandboxLazy />
          </section>
        )}
      </div>
    </ClientOnly>
  );
}
