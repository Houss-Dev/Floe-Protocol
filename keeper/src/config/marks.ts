import type { PriceMarkArgs } from "@ledgerline/ledgerline";
import type { AssetCfg, KeeperConfig } from "./types.js";

export const USD_SCALE = 1_000_000_000n;

export const usdFixed = (usd: number): { v: bigint } => ({
  v: BigInt(Math.round(usd * Number(USD_SCALE))),
});

export function pythToUsd(price: string | number, expo: number): number {
  const p = Number(typeof price === "string" ? price : price.toString());
  if (!isFinite(p)) throw new Error("pyth price overflowed safe Number range");
  const e = Number(expo);
  return e >= 0 ? p * 10 ** e : p / 10 ** -e;
}

async function staticMark(src: Extract<AssetCfg["sizing"], { source: "static" }>): Promise<PriceMarkArgs> {
  return {
    price: usdFixed(src.priceUsd),
    conf: usdFixed(src.confUsd),
    publishTs: BigInt(Math.floor(Date.now() / 1000)),
    dislocationBps: 0,
  };
}

async function pythMark(cfg: KeeperConfig, src: Extract<AssetCfg["sizing"], { source: "pyth" }>): Promise<PriceMarkArgs> {
  const hermes = cfg.hermes ?? "https://hermes.pyth.network";
  const res = await fetch(`${hermes}/v2/updates/price/latest`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids: [src.equityFeedId, src.tokenFeedId], parsing: "json" }),
  });
  if (!res.ok) throw new Error(`hermes ${res.status}`);
  const j: { parsed: { price: { price: string; expo: number; conf: string; publish_time: number } }[] } =
    await res.json();
  const [eq, tok] = j.parsed.map((p) => p.price);
  const equityUsd = pythToUsd(eq.price, eq.expo);
  const tokenUsd = pythToUsd(tok.price, tok.expo);
  const confUsd = pythToUsd(tok.conf, tok.expo);
  const now = Math.floor(Date.now() / 1000);
  return {
    price: usdFixed(tokenUsd),
    conf: usdFixed(confUsd),
    publishTs: BigInt(Math.max(Number(tok.publish_time), 0) || now),
    dislocationBps: equityUsd > 0 ? Math.round((tokenUsd / equityUsd - 1) * 10_000) : 0,
  };
}

export async function prestocksMarks(
  cfg: KeeperConfig,
  snapshotPath: string,
): Promise<Map<string, { markPrice: number; mint: string }>> {
  let raw: string | null = null;
  if (cfg.prestocksApi) {
    try {
      const res = await fetch(cfg.prestocksApi, { signal: AbortSignal.timeout(5000) });
      if (res.ok) raw = await res.text();
    } catch {
      /* offline fallback */
    }
  }
  if (!raw) {
    const fs = await import("fs");
    raw = fs.readFileSync(snapshotPath, "utf8");
  }
  const list = JSON.parse(raw);
  const items = Array.isArray(list) ? list : list.prestocks ?? list.data ?? [];
  const out = new Map<string, { markPrice: number; mint: string }>();
  for (const it of items) {
    const mint = it.contract_address ?? it.mint;
    const price = Number(it.markPrice ?? it.mark_price ?? 0);
    if (mint && price > 0) out.set(String(mint), { markPrice: price, mint: String(mint) });
  }
  return out;
}

export async function sizingMark(
  cfg: KeeperConfig,
  asset: AssetCfg,
  snapshotPath: string,
): Promise<PriceMarkArgs> {
  if (asset.sizing.source === "pyth") return pythMark(cfg, asset.sizing);
  if (asset.sizing.source === "static") return staticMark(asset.sizing);
  const marks = await prestocksMarks(cfg, snapshotPath);
  const m = marks.get(asset.mint);
  if (!m) throw new Error(`prestocks: no mark for ${asset.label} (${asset.mint})`);
  return {
    price: usdFixed(m.markPrice),
    conf: usdFixed(m.markPrice * 0.02),
    publishTs: BigInt(Math.floor(Date.now() / 1000)),
    dislocationBps: 0,
  };
}

export function applyIssuerDislocation(
  mark: PriceMarkArgs,
  issuer: AssetCfg["issuer"],
  marks: Map<string, { markPrice: number; mint: string }> | null,
  mint: string,
): void {
  if (!issuer) return;
  const issuerUsd =
    issuer.source === "static" ? issuer.priceUsd : marks?.get(mint)?.markPrice ?? NaN;
  if (!isFinite(issuerUsd) || issuerUsd <= 0) {
    throw new Error(`issuer mark unavailable for ${mint} — refusing to size with zero dislocation`);
  }
  const sizingUsd = Number(mark.price.v) / Number(USD_SCALE);
  mark.dislocationBps = Math.round((sizingUsd / issuerUsd - 1) * 10_000);
}
