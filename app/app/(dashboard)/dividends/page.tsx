"use client";
import { useState } from "react";
import { usdc6 } from "../../../lib/constants";

type DivRow = {
  date: string;
  ticker: string;
  multBefore: string;
  multAfter: string;
  gross: number;
  fee: number;
  net: number;
  where: "Repaid debt" | "Paid out";
  tx: string;
};

const HISTORY: DivRow[] = [
  { date: "2026-09-18", ticker: "SPYx", multBefore: "1.0000", multAfter: "1.0070", gross: 7_000_000, fee: 35_000, net: 6_965_000, where: "Repaid debt", tx: "4k9…2a1" },
  { date: "2026-06-15", ticker: "SPYx", multBefore: "1.0000", multAfter: "1.0062", gross: 6_200_000, fee: 31_000, net: 6_169_000, where: "Repaid debt", tx: "7f1…9c2" },
  { date: "2026-03-20", ticker: "QQQx", multBefore: "1.0030", multAfter: "1.0085", gross: 5_500_000, fee: 27_500, net: 5_472_500, where: "Paid out", tx: "a3c…0e9" },
];

const UPCOMING = [
  { ex: "2026-09-30", ticker: "SPYx", est: 61_200_000 / 1_000_000 },
  { ex: "2026-12-18", ticker: "SPYx", est: 58.4 },
  { ex: "2026-10-12", ticker: "QQQx", est: 42.1 },
];

export default function DividendsPage() {
  const [mode, setMode] = useState<"RepayDebt" | "Payout" | "Reinvest">("RepayDebt");
  const [simulating, setSimulating] = useState(false);
  const [history, setHistory] = useState<DivRow[]>(HISTORY);

  const simulateBump = async () => {
    setSimulating(true);
    await new Promise((r) => setTimeout(r, 1200));
    const now = new Date().toISOString().slice(0, 10);
    setHistory((h) => [
      {
        date: now,
        ticker: "SPYx",
        multBefore: "1.0070",
        multAfter: "1.0140",
        gross: 7_000_000,
        fee: 35_000,
        net: 6_965_000,
        where: mode === "Payout" ? "Paid out" : "Repaid debt",
        tx: Math.random().toString(16).slice(2, 6) + "…" + Math.random().toString(16).slice(2, 5),
      },
      ...h,
    ]);
    setSimulating(false);
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="pro-pill">Explore · Dividends</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-pro-text md:text-3xl">Dividend routing</h1>
          <p className="mt-2 max-w-2xl text-sm text-pro-muted">
            Multiplier bumps are the only on-chain trace — trim, swap to USDC, route per payout mode.
          </p>
        </div>
        <div className="pro-card flex gap-1 p-2 text-sm">
          {(["RepayDebt", "Payout", "Reinvest"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`rounded-full px-3 py-1.5 transition ${
                mode === m ? "bg-accent2 text-white" : "text-pro-muted hover:bg-pro-hover hover:text-pro-text"
              }`}
            >
              {m === "RepayDebt" ? "Repay debt" : m === "Payout" ? "Pay out" : "Reinvest (soon)"}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-3">
        <div className="space-y-4 md:col-span-2">
          <div className="pro-card overflow-hidden">
            <div className="flex items-center justify-between border-b border-pro-border px-4 py-3">
              <div className="text-sm font-medium text-pro-text">Ledger</div>
              <button
                onClick={simulateBump}
                disabled={simulating}
                className="rounded-lg bg-accent/15 px-3 py-1.5 text-xs font-semibold text-accent disabled:opacity-50"
              >
                {simulating ? "Bumping…" : "Simulate bump → harvest"}
              </button>
            </div>
            <div className="divide-y divide-pro-border">
              {history.map((r, i) => (
                <div key={i} className="flex items-center gap-4 p-4">
                  <div className="grid h-10 w-10 place-items-center rounded-lg bg-brand-gradient font-mono text-xs font-bold text-white">
                    {r.ticker.slice(0, 3)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-pro-text">
                      {r.date} · {r.ticker} · {r.multBefore} → {r.multAfter}
                    </div>
                    <div className="text-xs text-pro-muted">
                      Net {usdc6(r.net)} · {r.where} · {r.tx}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="pro-card p-5">
            <div className="text-sm font-semibold text-pro-text">How the trim works</div>
            <pre className="mt-2 overflow-auto rounded-lg border border-pro-border bg-pro-elevated p-3 text-xs text-pro-muted">
              {`mult 1.0 → 1.007 · trim · swap USDC · repay debt (idempotent by effective_ts)`}
            </pre>
          </div>
        </div>
        <div className="space-y-4">
          <div className="pro-card p-4">
            <div className="text-sm font-medium text-pro-text">Upcoming</div>
            <div className="mt-3 divide-y divide-pro-border">
              {UPCOMING.map((u) => (
                <div key={u.ex + u.ticker} className="flex justify-between py-2 text-sm">
                  <span className="text-pro-muted">
                    {u.ex} · {u.ticker}
                  </span>
                  <span className="font-medium text-pro-text">~${u.est.toFixed(2)}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="pro-card p-4 text-xs text-pro-muted">
            Current mode: <b className="text-pro-text">{mode}</b>
          </div>
        </div>
      </div>
    </div>
  );
}
