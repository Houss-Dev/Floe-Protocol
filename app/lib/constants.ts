export const PROGRAM_ID = process.env.NEXT_PUBLIC_PROGRAM_ID ?? "CK5xutaXUwmdcLR8qh7cCZMXJ5fkqopk1P5NZEM3cLrN";
export const RPC_URL =
  process.env.NEXT_PUBLIC_RPC_URL ?? "https://api.devnet.solana.com";
export const DEMO_MODE = true; // flip to false when wallet is connected and config exists

// Demo position — the story we tell judges
export const DEMO = {
  collateralTicker: "SPYx",
  collateralUsd: 5000,
  collateralRaw: 10_000_000, // 10 tokens at 6dp, $500 each -> $5,000
  priceUsd: 500,
  ltvRegularBps: 5500,
  ltvExtendedBps: 4500,
  ltvClosedBps: 3000,
  nextExDate: "2026-09-30",
  nextDividendUsd: 61.2,
};

export function usdc6(n: number): string {
  return `$${(n / 1_000_000).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function bps(n: number): string {
  return `${(n / 100).toFixed(2)}%`;
}
