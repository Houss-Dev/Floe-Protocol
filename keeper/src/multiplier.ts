/**
 * Read the Token-2022 ScaledUiAmount extension from a mint account.
 * Mirrors programs/ledgerline/src/multiplier.rs but in TypeScript for the keeper.
 * Used to detect pending dividend bumps before they become effective.
 */
import type { Address, Rpc, GetAccountInfoApi } from "@solana/kit";

export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" as Address;

export type MultiplierState = {
  multiplier: number; // f64
  multiplierBits: bigint;
  newMultiplier: number;
  newMultiplierBits: bigint;
  newEffectiveTs: bigint;
};

function readF64LE(view: DataView, off: number): { value: number; bits: bigint } {
  const bits = view.getBigUint64(off, true);
  const value = view.getFloat64(off, true);
  return { value, bits };
}

export async function readMultiplier(
  rpc: Rpc<GetAccountInfoApi>,
  mint: Address
): Promise<MultiplierState | null> {
  const { value: info } = await rpc.getAccountInfo(mint, { encoding: "base64" }).send();
  if (!info) return null;
  if (info.owner !== TOKEN_2022_PROGRAM) return null;
  const data = Buffer.from(info.data[0], "base64");
  if (data.length < 165 + 4) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.length);
  // Walk extensions: type at 165, then each ext header type(2) len(2) + body
  let off = 165 + 1;
  while (off + 4 <= data.length) {
    const type = view.getUint16(off, true);
    const len = view.getUint16(off + 2, true);
    if (type === 25 && len === 56) {
      const bodyOff = off + 4;
      // body[0:32] authority, [32:40] multiplier f64 LE, [40:48] effective i64 LE, [48:56] new_multiplier f64 LE
      const m = readF64LE(view, bodyOff + 32);
      const effTs = view.getBigInt64(bodyOff + 40, true);
      const nm = readF64LE(view, bodyOff + 48);
      return {
        multiplier: m.value,
        multiplierBits: m.bits,
        newMultiplier: nm.value,
        newMultiplierBits: nm.bits,
        newEffectiveTs: effTs,
      };
    }
    if (len === 0) break;
    off += 4 + len;
  }
  return null;
}

export function activeBits(state: MultiplierState, nowSec: number): bigint {
  return BigInt(nowSec) >= state.newEffectiveTs ? state.newMultiplierBits : state.multiplierBits;
}

export function actionIsLive(state: MultiplierState, nowSec: number): boolean {
  return BigInt(nowSec) >= state.newEffectiveTs && state.newMultiplierBits !== state.multiplierBits;
}

export function deltaBps(state: MultiplierState): number | null {
  if (state.multiplier === 0) return null;
  const ratio = state.newMultiplier / state.multiplier - 1;
  return Math.round(ratio * 10_000);
}
