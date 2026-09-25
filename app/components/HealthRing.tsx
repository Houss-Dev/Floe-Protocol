"use client";
export function HealthRing({
  ltvBps,
  thresholdBps = 6500,
  floorBps = 8500,
  theme = "light",
}: {
  ltvBps: number;
  thresholdBps?: number;
  floorBps?: number;
  theme?: "light" | "pro";
}) {
  const track = theme === "pro" ? "stroke-white/10" : "stroke-black/8";
  const textMain = theme === "pro" ? "text-pro-text" : "text-foreground";
  const textMuted = theme === "pro" ? "text-pro-muted" : "text-muted";
  const badgeNeutral =
    theme === "pro"
      ? "border-pro-border bg-pro-elevated text-pro-text"
      : "border-line bg-surface2 text-foreground";
  const pct = Math.min(100, (ltvBps / floorBps) * 100);
  const color = ltvBps >= floorBps ? "text-danger" : ltvBps >= thresholdBps ? "text-warn" : "text-accent";
  const label = ltvBps >= floorBps ? "Liquidatable" : ltvBps >= thresholdBps ? "At risk" : "Healthy";
  const circumference = 2 * Math.PI * 44;
  const dash = (pct / 100) * circumference;
  return (
    <div className="flex items-center gap-4">
      <div className="relative h-24 w-24">
        <svg viewBox="0 0 100 100" className="h-24 w-24 -rotate-90">
          <circle cx="50" cy="50" r="44" strokeWidth="10" className={`fill-none ${track}`} />
          <circle
            cx="50"
            cy="50"
            r="44"
            strokeWidth="10"
            className={`fill-none ${color}`}
            stroke="currentColor"
            strokeLinecap="round"
            strokeDasharray={`${dash} ${circumference}`}
          />
        </svg>
        <div className="absolute inset-0 grid place-items-center">
          <div className="text-center">
            <div className={`text-xl font-semibold ${textMain}`}>{(ltvBps / 100).toFixed(1)}%</div>
            <div className={`text-[10px] uppercase tracking-widest ${textMuted}`}>LTV</div>
          </div>
        </div>
      </div>
      <div>
        <div
          className={`inline-flex rounded-full border px-2 py-1 text-xs ${
            ltvBps >= thresholdBps ? "border-warn/40 bg-warn/10 text-warn" : badgeNeutral
          }`}
        >
          {label}
        </div>
        <div className={`mt-1 text-xs ${textMuted}`}>
          Threshold {thresholdBps / 100}% · Floor {floorBps / 100}%
        </div>
        <div className={`text-xs ${textMuted}`}>Avail = max(0, limit − debt − interest)</div>
      </div>
    </div>
  );
}
