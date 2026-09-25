"use client";
import { useEffect, useState } from "react";

type Session = "Regular" | "Extended" | "Overnight" | "Closed";

export function useSession(): Session {
  const [s, setS] = useState<Session>("Regular");
  useEffect(() => {
    const tick = () => {
      const now = new Date();
      const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
      const day = et.getDay();
      const mins = et.getHours() * 60 + et.getMinutes();
      const isWeekend = day === 0 || day === 6;
      if (isWeekend) return setS("Closed");
      const regular = 9 * 60 + 30,
        close = 16 * 60,
        pre = 4 * 60,
        post = 20 * 60;
      if (mins >= regular && mins < close) setS("Regular");
      else if ((mins >= pre && mins < regular) || (mins >= close && mins < post)) setS("Extended");
      else setS("Overnight");
    };
    tick();
    const id = setInterval(tick, 60_000);
    return () => clearInterval(id);
  }, []);
  return s;
}

export function SessionBanner({ session, theme = "light" }: { session: Session; theme?: "light" | "pro" }) {
  const map: Record<Session, { label: string; desc: string; tone: string }> = {
    Regular: {
      label: "Markets open — 55% LTV",
      desc: "Pyth Equity.US.SPY/USD is fresh. Your line is at full size.",
      tone: "border-accent/30 bg-accent/10",
    },
    Extended: {
      label: "Extended hours — 45% LTV",
      desc: "Equity feed is dark. We hold a 10% bigger buffer until the next session.",
      tone: "border-warn/30 bg-warn/10",
    },
    Overnight: {
      label: "Overnight — 45% LTV",
      desc: "Token trades, equity doesn't. Same buffer as extended.",
      tone: "border-warn/30 bg-warn/10",
    },
    Closed: {
      label: "Markets closed — 30% LTV",
      desc: "US markets are closed. We hold a bigger buffer until Monday 09:30 ET.",
      tone: "border-orange-400/30 bg-orange-500/10",
    },
  };
  const c = map[session];
  const proTone =
    session === "Regular"
      ? "border-accent/30 bg-accent/10"
      : session === "Closed"
        ? "border-orange-500/30 bg-orange-500/10"
        : "border-warn/30 bg-warn/10";
  const tone = theme === "pro" ? proTone : c.tone;
  const labelCls = theme === "pro" ? "text-pro-text" : "text-foreground";
  const descCls = theme === "pro" ? "text-pro-muted" : "text-muted";
  const chipCls =
    theme === "pro"
      ? "border-pro-border bg-pro-elevated text-pro-text"
      : "border-line bg-surface2 text-foreground";
  return (
    <div className={`flex items-start gap-3 rounded-xl border px-4 py-3 ${tone}`}>
      <div className="mt-0.5 h-2 w-2 animate-pulse rounded-full bg-accent" />
      <div>
        <div className={`text-sm font-medium ${labelCls}`}>{c.label}</div>
        <div className={`text-xs ${descCls}`}>{c.desc}</div>
      </div>
      <div className={`ml-auto whitespace-nowrap rounded-full border px-2 py-1 text-xs ${chipCls}`}>
        {session}
      </div>
    </div>
  );
}
