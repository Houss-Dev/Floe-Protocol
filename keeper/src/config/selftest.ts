import fs from "fs";
import path from "path";
import { applyIssuerDislocation, pythToUsd, USD_SCALE } from "./marks.js";
import type { PriceMarkArgs } from "@ledgerline/ledgerline";

export function runConfigSelftest(repoRoot: string): void {
  const t0 = Date.now();
  if (Math.abs(pythToUsd("507325", -6) - 0.507325) > 1e-9) throw new Error("expo neg");
  if (Math.abs(pythToUsd("5", 1) - 50) > 1e-9) throw new Error("expo pos");

  const raw = fs.readFileSync(path.join(repoRoot, "docs/data/prestocks.json"), "utf8");
  const list = JSON.parse(raw);
  const items = Array.isArray(list) ? list : list.prestocks;
  if (!Array.isArray(items) || items.length < 6) throw new Error("snapshot shape");
  for (const it of items) {
    if (!(it.contract_address && Number(it.markPrice) > 0)) throw new Error("snapshot entry");
  }

  const m: PriceMarkArgs = { price: { v: 100n * USD_SCALE }, conf: { v: 0n }, publishTs: 0n, dislocationBps: 0 };
  applyIssuerDislocation(m, { source: "static", priceUsd: 1017.88 }, null, "x");
  if (!(m.dislocationBps < -8000)) throw new Error(`dislocation not surfaced: ${m.dislocationBps}`);

  console.log(`selftest ok in ${Date.now() - t0}ms (expo, snapshot x${items.length}, fail-closed units)`);
}
