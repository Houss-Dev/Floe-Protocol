"use client";
import { useState } from "react";

export function SpendTerminal({
  onAuthorize,
  theme = "light",
}: {
  onAuthorize: (amount: number, merchant: string) => Promise<{ ok: boolean; tx?: string; err?: string }>;
  theme?: "light" | "pro";
}) {
  const wrap = theme === "pro" ? "pro-card border-accent2/25 p-5" : "ll-card border-accent2/25 bg-tint-purple p-5";
  const input =
    theme === "pro"
      ? "flex-1 rounded-lg border border-pro-border bg-pro-elevated px-4 py-3 text-lg text-pro-text outline-none focus:border-accent2/50"
      : "flex-1 rounded-xl border border-line bg-surface2 px-4 py-3 text-lg text-foreground outline-none focus:border-accent2/50";
  const label = theme === "pro" ? "text-pro-muted" : "text-muted";
  const [amount, setAmount] = useState("200");
  const [merchant, setMerchant] = useState("Whole Foods — groceries");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; tx?: string; err?: string } | null>(null);

  const go = async () => {
    setBusy(true);
    setResult(null);
    const r = await onAuthorize(parseFloat(amount) || 0, merchant);
    setResult(r);
    setBusy(false);
  };

  return (
    <div className={wrap}>
      <div className="flex items-center justify-between">
        <div className={`text-sm font-medium uppercase tracking-widest ${label}`}>Card terminal · simulated</div>
        <div className="h-2 w-2 animate-pulse rounded-full bg-accent" />
      </div>

      <div className="mt-4 grid gap-3">
        <label className={`text-xs ${label}`}>Amount (USDC)</label>
        <div className="flex gap-2">
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
            className={input}
            placeholder="200"
          />
          <button
            onClick={go}
            disabled={busy || !amount}
            className="rounded-xl bg-brand-gradient px-6 py-3 font-semibold text-white disabled:opacity-50 hover:opacity-90"
          >
            {busy ? "Authorising…" : "Authorise"}
          </button>
        </div>

        <label className={`text-xs ${label}`}>Merchant</label>
        <input
          value={merchant}
          onChange={(e) => setMerchant(e.target.value)}
          className={input}
        />

        {result && (
          <div className={`mt-2 rounded-xl px-4 py-3 text-sm ${result.ok ? "border border-accent/30 bg-accent/15 text-accent" : "bg-danger text-white"}`}>
            {result.ok ? (
              <div>
                <div className="font-semibold">Approved — ${amount} to {merchant}</div>
                <div className="text-xs opacity-80">I didn’t sell a share. Debt + fee added to my line. {result.tx && `Tx ${result.tx.slice(0, 12)}…`}</div>
              </div>
            ) : (
              <div>Declined: {result.err}</div>
            )}
          </div>
        )}

        <div className={`text-[11px] ${label}`}>
          Draw is keeper-signed in prod (latency ~1.5s). This terminal simulates it so judges can see the flow without a card partner.
        </div>
      </div>
    </div>
  );
}
