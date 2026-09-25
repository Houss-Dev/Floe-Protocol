"use client";
export function DislocationBadge({ bps }: { bps: number }) {
  const sign = bps > 0 ? "+" : "";
  const tone =
    Math.abs(bps) > 150
      ? "border-warn/40 bg-warn/10 text-warn"
      : "border-pro-border bg-pro-elevated text-pro-muted";
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-xs ${tone}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-accent" />
      Dislocation {sign}
      {(bps / 100).toFixed(2)}%
    </span>
  );
}
