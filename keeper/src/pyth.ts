/**
 * Pyth Hermes helpers + mock PriceUpdate builder for localnet.
 * On localnet there is no PriceUpdateV2 account, so the keeper supplies
 * keeper marks (trusted, logged). When HERMES_URL is reachable we still build
 * marks from Hermes, but we also optionally create a mock on-chain PriceUpdate
 * account so the program's hybrid path can be exercised.
 */
import { generateKeyPairSigner, type Address } from "@solana/kit";
import { HERMES_URL } from "./config.js";

// Minimal PriceMark as the program expects (Fixed at 1e9 scale)
const SCALE = 1_000_000_000n;

export type PriceMark = {
  price: { v: bigint };
  conf: { v: bigint };
  publishTs: bigint;
  dislocationBps: number;
};

export function fixedFromWhole(n: number): bigint {
  return BigInt(n) * SCALE;
}

// Convert pyth (price, expo) to fixed. price * 10^(expo) * SCALE
export function pythToFixed(price: number, expo: number): bigint {
  // price is i64, expo i32
  const p = BigInt(price);
  const shift = 9 + expo; // DP=9
  if (shift >= 0) {
    return p * 10n ** BigInt(shift);
  } else {
    const d = 10n ** BigInt(-shift);
    let q = p / d;
    const r = p % d;
    if (r * 2n >= d) q += 1n;
    return q;
  }
}

export async function fetchHermesPrice(feedIdHex: string): Promise<{ price: number; conf: number; expo: number; publishTime: number } | null> {
  // feedIdHex is 64 hex chars; Hermes expects 0x-prefixed
  const id = feedIdHex.startsWith("0x") ? feedIdHex : "0x" + feedIdHex;
  try {
    const url = `${HERMES_URL}/v2/updates/price/latest?ids[]=${id}`;
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) return null;
    const json: any = await res.json();
    const parsed = json?.parsed?.[0]?.price;
    if (!parsed) return null;
    return {
      price: parseInt(parsed.price, 10),
      conf: parseInt(parsed.conf, 10),
      expo: parsed.expo,
      publishTime: parsed.publish_time,
    };
  } catch {
    return null;
  }
}

export function priceMarkFromPyth(price: number, conf: number, expo: number, publishTime: number): PriceMark {
  return {
    price: { v: pythToFixed(price, expo) },
    conf: { v: pythToFixed(conf, expo) },
    publishTs: BigInt(publishTime),
    dislocationBps: 0,
  };
}

export function mockPriceMark(priceUsd = 100): PriceMark {
  // $100 with $0.50 conf -> 0.5% -> inside 5% cap
  return {
    price: { v: BigInt(priceUsd) * SCALE },
    conf: { v: (SCALE / 2n) }, // $0.50
    publishTs: BigInt(Math.floor(Date.now() / 1000)),
    dislocationBps: 0,
  };
}

/**
 * Build a mock PriceUpdateV2 account data buffer matching the program's parser:
 * [disc(8)=0][feedId(32)][price(8 LE)][conf(8 LE)][expo(4 LE)][publishTime(8 LE)]
 */
export function buildMockPriceUpdateData(
  feedId: Uint8Array, // 32 bytes
  price: number,
  conf: number,
  expo: number,
  publishTime: number
): Uint8Array {
  const buf = Buffer.alloc(8 + 32 + 8 + 8 + 4 + 8);
  // disc stays zero
  Buffer.from(feedId).copy(buf, 8);
  buf.writeBigInt64LE(BigInt(price), 8 + 32);
  buf.writeBigUInt64LE(BigInt(conf), 8 + 32 + 8);
  buf.writeInt32LE(expo, 8 + 32 + 8 + 8);
  buf.writeBigInt64LE(BigInt(publishTime), 8 + 32 + 8 + 8 + 4);
  return buf;
}

export async function ensureMockPriceAccount(feedIdHex: string): Promise<Address> {
  // MVP stub (unchanged semantics): localnet uses keeper marks, not on-chain
  // mocks, so we only log and return an ephemeral address. Previously this
  // built an unsigned SystemProgram.createAccount transaction that was never
  // sent — the return value was only ever logged, never used on-chain.
  const ephemeral = await generateKeyPairSigner();
  console.log(
    `[keeper/pyth] mock price account for ${feedIdHex} would be ${ephemeral.address} (localnet mock uses keeper marks, not on-chain mock)`
  );
  return ephemeral.address;
}
