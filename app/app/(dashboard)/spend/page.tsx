"use client";
import { useState } from "react";
import { SpendTerminal } from "../../../components/SpendTerminal";
import { HealthRing } from "../../../components/HealthRing";
import { SessionBanner, useSession } from "../../../components/SessionBanner";
import { usdc6 } from "../../../lib/constants";

export default function SpendPage() {
  const session = useSession();
  const [debt, setDebt] = useState(100_250_000);
  const collateral = 5_000_000_000;
  const ltvForSession = (s: string) => (s === "Regular" ? 5500 : s === "Closed" ? 3000 : 4500);
  const ltv = ltvForSession(session);
  const limit = Math.floor((collateral * ltv) / 10_000);
  const available = Math.max(0, limit - debt);
  const ltvBps = Math.floor((debt * 10_000) / collateral);

  const handleAuth = async (amountUsdc: number, _merchant: string) => {
    await new Promise((r) => setTimeout(r, 1200));
    const minor = Math.round(amountUsdc * 1_000_000);
    if (minor <= 0) return { ok: false, err: "Amount must be > 0" };
    const fee = Math.floor(minor * 0.0025);
    const total = minor + fee;
    if (total > available) return { ok: false, err: `Insufficient credit. Available ${usdc6(available)}` };
    setDebt((d) => d + total);
    return { ok: true, tx: `demo-${Date.now().toString(16)}` };
  };

  return (
    <div className="mx-auto max-w-5xl grid gap-6 md:grid-cols-5">
      <div className="space-y-4 md:col-span-3">
        <div>
          <p className="pro-pill">Explore · Spend</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-pro-text">Draw at point of sale</h1>
          <p className="mt-2 text-sm text-pro-muted">
            Keeper-signed in prod (~1.5s). No standing debt, no idle interest.
          </p>
        </div>
        <SessionBanner session={session} theme="pro" />
        <SpendTerminal onAuthorize={handleAuth} theme="pro" />
        <div className="pro-card p-4 text-xs text-pro-muted">
          Prod: deposit → resize_line → draw via reserve PDA. Liquidation needs no DEX.
        </div>
      </div>
      <div className="space-y-4 md:col-span-2">
        <div className="pro-card p-5">
          <div className="text-sm font-medium text-pro-text">Health after draw</div>
          <div className="mt-3">
            <HealthRing ltvBps={ltvBps} theme="pro" />
          </div>
          <div className="mt-4 grid grid-cols-2 gap-2 text-sm">
            {[
              { label: `Limit (${ltv / 100}% LTV)`, value: usdc6(limit) },
              { label: "Available", value: usdc6(available) },
              { label: "Debt", value: usdc6(debt) },
              { label: "Collateral", value: usdc6(collateral) },
            ].map((s) => (
              <div key={s.label} className="pro-card-inset p-3">
                <div className="text-xs text-pro-muted">{s.label}</div>
                <div className="font-semibold tabular-nums text-pro-text">{s.value}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
