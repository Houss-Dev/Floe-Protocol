"use client";

import { useEffect, useMemo, useState } from "react";
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
import { findLinePda, MarketKind, type CreditLine } from "@ledgerline/ledgerline";

function slotValueUsdc6(raw: bigint, decimals: number, price1e9: bigint): number {
  const scale = 10n ** BigInt(decimals);
  if (scale === 0n || price1e9 === 0n) return 0;
  return Number((raw * price1e9) / scale / 1000n);
}

export default function DashboardPage() {
  const session = useSession();
  const connected = useConnectedWallet(client);
  const wallet = connected?.account?.address;
  const sample = !wallet;
  const [debt, setDebt] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const [live, setLive] = useState<CreditLine | null>(null);
  const [lineStatus, setLineStatus] = useState<"idle" | "loading" | "empty" | "legacy">("idle");

  useEffect(() => {
    if (!wallet) {
      setLive(null);
      setLineStatus("idle");
      return;
    }
    let cancel = false;
    setLineStatus("loading");
    (async () => {
      const [line] = await findLinePda({ owner: wallet });
      const fetched = await client.ledgerline.accounts.creditLine.fetchMaybe(line);
      if (cancel) return;
      if (!fetched.exists) {
        setLive(null);
        setLineStatus("empty");
        return;
      }
      setLive(fetched.data);
      setLineStatus("idle");
    })().catch(() => {
      if (!cancel) {
        setLive(null);
        setLineStatus("legacy");
      }
    });
    return () => {
      cancel = true;
    };
  }, [wallet]);

  const ltvForSession = (s: string) => {
    if (s === "Regular") return DEMO.ltvRegularBps;
    if (s === "Closed") return DEMO.ltvClosedBps;
    return DEMO.ltvExtendedBps;
  };
  const ltv = ltvForSession(session);
  const collateralUsd = sample ? DEMO.collateralUsd * 1_000_000 : Number(live?.collateralUsdc ?? 0n);
  const limit = sample
    ? Math.floor((collateralUsd * ltv) / 10_000)
    : Number(live?.creditLimitUsdc ?? 0n);
  const shownDebt = sample ? debt : Number(live?.usdcDebt ?? 0n) + Number(live?.accruedInterest ?? 0n);
  const available = sample ? Math.max(0, limit - debt) : Number(live?.availableCreditUsdc ?? 0n);
  const ltvBps =
    shownDebt === 0 || collateralUsd === 0 ? 0 : Math.floor((shownDebt * 10_000) / collateralUsd);

  const sampleRows = useMemo(
    () => [
      {
        mint: DEMO.collateralTicker,
        label: "SPDR S&P 500",
        shares: "10.000",
        value: DEMO.collateralUsd * 1_000_000,
        dislocation: 12,
        tier: "public" as const,
      },
      {
        mint: "QQQx",
        label: "Invesco QQQ",
        shares: "5.035",
        value: 2_500_000_000,
        dislocation: -38,
        tier: "public" as const,
      },
      {
        mint: "PRE1x",
        label: "Pre-IPO Round A",
        shares: "1000.000",
        value: 1_250_000_000,
        dislocation: 0,
        tier: "pre-ipo" as const,
      },
    ],
    [],
  );

  const rows = sample
    ? sampleRows
    : (live?.collateral ?? []).slice(0, live?.nCollateral ?? 0).map((slot) => {
        const decimals = slot.decimals || 6;
        const shares = Number(slot.rawAmount) / 10 ** decimals;
        return {
          mint: slot.mint,
          label: slot.marketKind === MarketKind.PreIpo ? "Pre-IPO" : "Tokenized equity",
          shares: shares.toLocaleString(undefined, { maximumFractionDigits: 3 }),
          value: slotValueUsdc6(slot.rawAmount, decimals, slot.lastPrice.v),
          dislocation: 0,
          tier: slot.marketKind === MarketKind.PreIpo ? ("pre-ipo" as const) : ("public" as const),
        };
      });

  return (
    <ClientOnly>
      <div className="mx-auto max-w-5xl space-y-8">
        <div>
          <p className="pro-pill">Dashboard</p>
          <h1 className="font-condensed mt-1 text-4xl uppercase tracking-tight text-pro-text md:text-5xl">Your credit line</h1>
          <p className="mt-1 text-sm text-pro-muted">
            {connected?.account
              ? "Connected — actions below use your wallet on devnet."
              : "Connect your wallet to open a line, deposit collateral, and draw."}
          </p>
        </div>

        {sample && (
          <div className="pro-card border-hot/30 bg-hot/10 p-4 text-sm text-pro-muted">
            Sample data. Connect a wallet to load your on-chain credit line. These numbers are not a position.
          </div>
        )}
        {lineStatus === "empty" && (
          <div className="pro-card border-pro-border p-4 text-sm text-pro-muted">
            This wallet has no credit line yet. Open one in the devnet sandbox below.
          </div>
        )}
        {lineStatus === "legacy" && (
          <div className="pro-card border-hot/30 bg-hot/10 p-4 text-sm text-pro-muted">
            A credit line exists but was written by an older program build and cannot be read. Use a fresh wallet after the upgrade.
          </div>
        )}

        <div className="grid gap-4 lg:grid-cols-3">
          <div className="pro-card bg-pro-elevated p-6 lg:col-span-2">
            <div className="inline-flex items-center gap-2 rounded-full bg-hot/15 px-2.5 py-1 text-xs font-semibold text-hot">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-hot" />
              Available to spend
            </div>
            <div className="font-condensed mt-3 text-5xl uppercase tabular-nums tracking-tight text-pro-text md:text-6xl">
              {usdc6(available)}
            </div>
            <div className="mt-2 text-sm text-pro-muted">
              Limit {usdc6(limit)} · Debt {usdc6(shownDebt)} · {(sample ? ltv / 100 : ltvBps / 100).toFixed(0)}% LTV · {session}
              {sample ? " · sample" : ""}
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
              {sample && (
                <button
                  type="button"
                  suppressHydrationWarning
                  onClick={() => {
                    const fee = Math.floor(200_000_000 * 0.0025);
                    const total = 200_000_000 + fee;
                    if (available < total) setToast("Insufficient credit — resize first or repay");
                    else {
                      setDebt((d) => d + total);
                      setToast(`Sample draw of $200 (fee $0.50). Debt now ${usdc6(debt + total)}.`);
                    }
                    setTimeout(() => setToast(null), 3000);
                  }}
                  className="pro-btn-secondary text-xs"
                >
                  Simulate draw $200
                </button>
              )}
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
              <h2 className="font-condensed text-2xl uppercase tracking-tight text-pro-text">Your positions</h2>
            </div>
            <span className="rounded-full border border-pro-border bg-pro-elevated px-3 py-1 text-xs text-pro-muted">
              {sample ? "Sample data" : `${rows.length} asset${rows.length === 1 ? "" : "s"}`}
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
              {rows.length === 0 && (
                <div className="p-4 text-sm text-pro-muted">No collateral on this line.</div>
              )}
              {rows.map((r) => (
                <div
                  key={r.mint}
                  className="grid grid-cols-[1fr_auto_auto] items-center gap-4 p-4 transition hover:bg-pro-hover sm:grid-cols-[1fr_auto_auto_auto]"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="grid h-10 w-10 place-items-center rounded-full bg-hot/15 font-mono text-xs font-bold text-hot">
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
          <div className="pro-card p-5">
            <div className="flex items-center gap-2 text-sm font-semibold text-pro-text">
              <Zap className="h-4 w-4 text-hot" />
              Dividend loop
            </div>
            <p className="mt-2 text-sm text-pro-muted">
              {sample
                ? `Sample: last trim ~$${DEMO.nextDividendUsd}, routed to repay debt when the multiplier bumps.`
                : `Dividends received ${usdc6(Number(live?.dividendsReceived ?? 0n))}, of which ${usdc6(Number(live?.dividendsToRepay ?? 0n))} repaid debt.`}
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
