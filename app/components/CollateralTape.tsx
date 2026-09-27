"use client";

import { TapeTokenIcon } from "./TapeTokenIcon";

type TapeItem = {
  ticker: string;
  name: string;
  price: string;
  change: number;
  spark: string;
};

const ITEMS: TapeItem[] = [
  { ticker: "SPYx", name: "S&P 500", price: "$500.00", change: 0.42, spark: "2,14 8,10 14,12 20,7 26,9 32,5" },
  { ticker: "QQQx", name: "Nasdaq 100", price: "$500.00", change: -0.18, spark: "2,8 8,11 14,9 20,13 26,10 32,14" },
  { ticker: "PRE1x", name: "Pre-IPO A", price: "$1.25", change: 0, spark: "2,10 8,10 14,9 20,10 26,10 32,10" },
  { ticker: "USDC", name: "USD Coin", price: "$1.00", change: 0, spark: "2,11 8,11 14,11 20,11 26,11 32,11" },
];

function TapeRow({ item }: { item: TapeItem }) {
  const up = item.change > 0;
  const down = item.change < 0;
  const tone = up ? "text-hot" : down ? "text-pro-muted" : "text-pro-faint";
  const sign = item.change > 0 ? "+" : "";

  return (
    <div className="flex min-w-[220px] items-center gap-3 rounded-2xl bg-pro-elevated px-3 py-2.5">
      <TapeTokenIcon ticker={item.ticker} size={36} />
      <div className="min-w-0">
        <div className="text-sm font-semibold text-pro-text">{item.ticker}</div>
        <div className="truncate text-[11px] text-pro-faint">{item.name}</div>
      </div>
      <div className="ml-auto text-right">
        <div className="text-sm font-semibold tabular-nums text-pro-text">{item.price}</div>
        <div className={`text-[11px] font-semibold tabular-nums ${tone}`}>
          {sign}
          {item.change.toFixed(2)}%
        </div>
      </div>
      <svg viewBox="0 0 34 18" className="h-5 w-10 shrink-0" aria-hidden="true">
        <polyline
          fill="none"
          stroke={up ? "#ff4d1c" : down ? "rgba(244,240,229,0.45)" : "rgba(244,240,229,0.28)"}
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          points={item.spark}
        />
      </svg>
    </div>
  );
}

export function CollateralTape() {
  const loop = [...ITEMS, ...ITEMS];
  return (
    <div className="overflow-hidden border-y border-pro-border bg-pro-panel/80">
      <div className="flex w-max animate-[marquee-scroll_28s_linear_infinite] items-center gap-3 px-4 py-3">
        {loop.map((item, i) => (
          <TapeRow key={`${item.ticker}-${i}`} item={item} />
        ))}
      </div>
    </div>
  );
}
