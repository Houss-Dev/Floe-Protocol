import type { Address } from "@solana/kit";
import dotenv from "dotenv";
dotenv.config();

export const PROGRAM_ID = (process.env.PROGRAM_ID ??
  "CK5xutaXUwmdcLR8qh7cCZMXJ5fkqopk1P5NZEM3cLrN") as Address;
export const RPC_URL = process.env.ANCHOR_PROVIDER_URL ?? process.env.RPC_URL ?? "http://127.0.0.1:8899";
export const WALLET_PATH = process.env.ANCHOR_WALLET ?? `${process.env.HOME ?? "/home/user"}/.config/solana/id.json`;

// Pyth Hermes for price marks. When HERMES_URL is set we fetch live prices;
// otherwise we use a deterministic mock ($100) so local-validator still sizes.
export const HERMES_URL = process.env.HERMES_URL ?? "https://hermes.pyth.network";

// Mock-price fallback for sizing. Production keeper must NEVER fall back to a
// made-up price: a Hermes miss for a real feed aborts that line's resize unless
// this flag is explicitly set to "1" (local sandbox only). Locally-mocked feeds
// (all-zero / all-one feed ids from the tests) are always treated as mocks.
const mockPricesRequested = process.env.ALLOW_MOCK_PRICES === "1";
if (mockPricesRequested && process.env.NODE_ENV === "production") {
  throw new Error(
    "ALLOW_MOCK_PRICES=1 is forbidden when NODE_ENV=production — refusing to start keeper with fabricated prices",
  );
}
export const ALLOW_MOCK_PRICES = mockPricesRequested;

// Map feedId hex -> pyth hermes id. For MVP we treat equityFeedId as already
// being a pyth feed id; the keeper fetches both feeds and uses equity as ref.
// In production this table is populated from Asset.equityFeedId / tokenFeedId.
export const FEED_IDS: Record<string, string> = {};

// Logging
export const LOG_PREFIX = "[keeper]";
