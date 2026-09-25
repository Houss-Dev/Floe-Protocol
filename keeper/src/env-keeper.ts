/**
 * Env-configured Kit keeper: Hermes marks, resize_line, optional harvest_dividend.
 * Used when no JSON config is passed (CI / local validator).
 */
import {
  AccountRole,
  createClient,
  createKeyPairSignerFromBytes,
  generateKeyPairSigner,
  type Address,
  type Instruction,
  type ReadonlyUint8Array,
} from "@solana/kit";
import { solanaRpcConnection, rpcTransactionPlanner, rpcTransactionPlanSendingExecutor } from "@solana/kit-plugin-rpc";
import { signer } from "@solana/kit-plugin-signer";
import {
  findAssetPda,
  findConfigPda,
  findDividendEventPda,
  findTreasuryPda,
  findVaultPda,
  getCreditLineDecoder,
  ledgerlineProgram,
  type CreditLine,
} from "@ledgerline/ledgerline";
import fs from "fs";
import { PROGRAM_ID, RPC_URL, WALLET_PATH, ALLOW_MOCK_PRICES } from "./config.js";
import { mockPriceMark, fetchHermesPrice, priceMarkFromPyth, type PriceMark } from "./pyth.js";
import { readMultiplier, actionIsLive, deltaBps, TOKEN_2022_PROGRAM } from "./multiplier.js";

async function loadKeeperSigner() {
  try {
    const raw = fs.readFileSync(WALLET_PATH, "utf-8");
    const arr = JSON.parse(raw);
    return await createKeyPairSignerFromBytes(Uint8Array.from(arr));
  } catch {
    console.warn(`[keeper] no wallet at ${WALLET_PATH} — using ephemeral keeper (read-only mode)`);
    return await generateKeyPairSigner();
  }
}

async function resolveMark(asset: { equityFeedId: ReadonlyUint8Array }, mint: Address): Promise<PriceMark> {
  const feedId = Array.from(asset.equityFeedId);
  const feedHex = Buffer.from(feedId).toString("hex");
  const isMockFeed = feedId.every((b) => b === 1) || feedId.every((b) => b === 0);
  if (isMockFeed) {
    console.log(`[keeper]  mock feed — $100 (sandbox only)`);
    return mockPriceMark(100);
  }
  const fetched = await fetchHermesPrice(feedHex);
  if (fetched) {
    console.log(`[keeper]  mark for ${mint} via Hermes price=${fetched.price} expo=${fetched.expo}`);
    return priceMarkFromPyth(fetched.price, fetched.conf, fetched.expo, fetched.publishTime);
  }
  if (ALLOW_MOCK_PRICES) {
    console.log(
      `[keeper]  !! hermes miss for ${feedHex.slice(0, 12)}... — ALLOW_MOCK_PRICES set, falling back to mock $100 (NOT production safe)`,
    );
    return mockPriceMark(100);
  }
  throw new Error(
    `hermes miss for ${feedHex.slice(0, 12)}... — refusing to fabricate a price (set ALLOW_MOCK_PRICES=1 only for local sandbox)`,
  );
}

export async function runEnvKeeper(mode: { once: boolean; loop: boolean }): Promise<void> {
  const keeperSigner = await loadKeeperSigner();

  const client = createClient()
    .use(signer(keeperSigner))
    .use(solanaRpcConnection({ rpcUrl: RPC_URL }))
    .use(rpcTransactionPlanner())
    .use(rpcTransactionPlanSendingExecutor())
    .use(ledgerlineProgram());

  console.log(
    `[keeper] program=${PROGRAM_ID} rpc=${RPC_URL} wallet=${keeperSigner.address} mode=${mode.once ? "once" : "loop"}`,
  );

  const tick = async (n: number) => {
    const ts = new Date().toISOString();
    console.log(`\n[keeper] ── tick #${n} at ${ts} ──`);
    try {
      const [configPda] = await findConfigPda({ programAddress: PROGRAM_ID });
      const configMaybe = await client.ledgerline.accounts.config.fetchMaybe(configPda);
      if (!configMaybe.exists) {
        console.log("[keeper] no config yet — skipping");
        return;
      }
      const config = configMaybe.data;
      const isKeeper = config.keeper === keeperSigner.address;
      console.log(`[keeper] config keeper=${config.keeper} isKeeper=${isKeeper} pythReceiver=${config.pythReceiver}`);

      const programAccounts = await client.rpc.getProgramAccounts(PROGRAM_ID, { encoding: "base64" }).send();
      const lines: Array<{ linePda: Address; line: CreditLine }> = [];
      for (const { pubkey, account } of programAccounts) {
        try {
          const line = getCreditLineDecoder().decode(Buffer.from(account.data[0], "base64"));
          lines.push({ linePda: pubkey, line });
        } catch {
          /* skip */
        }
      }
      console.log(`[keeper] found ${lines.length} credit lines`);
      if (lines.length === 0) return;

      for (const { linePda, line } of lines) {
        console.log(
          `\n[keeper] line ${linePda} owner=${line.owner} n=${line.nCollateral} debt=${line.usdcDebt.toString()} avail=${line.availableCreditUsdc.toString()}`,
        );

        const collateral: {
          slot: CreditLine["collateral"][number];
          mint: Address;
          asset: NonNullable<Awaited<ReturnType<typeof client.ledgerline.accounts.asset.fetchMaybe>>["data"]>;
          assetPda: Address;
          index: number;
        }[] = [];

        for (let i = 0; i < line.nCollateral; i++) {
          const slot = line.collateral[i];
          if (!slot.inUse) continue;
          const mint = slot.mint;
          const [assetPda] = await findAssetPda({ mint }, { programAddress: PROGRAM_ID });
          const assetMaybe = await client.ledgerline.accounts.asset.fetchMaybe(assetPda);
          if (!assetMaybe.exists) {
            console.log(`[keeper]  slot ${i} mint ${mint} — no asset, skipping`);
            continue;
          }
          collateral.push({ slot, mint, asset: assetMaybe.data, assetPda, index: i });
        }
        if (collateral.length === 0) {
          console.log("[keeper]  no active collateral");
          continue;
        }

        const marks: PriceMark[] = [];
        let marksFailed: string | null = null;
        for (const c of collateral) {
          try {
            marks.push(await resolveMark(c.asset, c.mint));
          } catch (e: unknown) {
            marksFailed = e instanceof Error ? e.message : String(e);
            console.log(`[keeper]  ${marksFailed}`);
            break;
          }
        }
        if (marksFailed) {
          console.log(`[keeper]  line ${linePda}: no usable prices — skipping resize & harvest this tick`);
          continue;
        }

        if (isKeeper) {
          try {
            const baseInstr = await client.ledgerline.instructions.resizeLine({
              config: configPda,
              line: linePda,
              keeper: keeperSigner,
              marks,
            });
            const instrWithAssets: Instruction = {
              ...baseInstr,
              accounts: [
                ...(baseInstr.accounts ?? []),
                ...collateral.map((c) => ({ address: c.assetPda, role: AccountRole.READONLY })),
              ],
            } as Instruction;
            const res = await client.sendTransaction(instrWithAssets);
            console.log(`[keeper]  resize_line ok sig=${res.context.signature.slice(0, 16)}...`);
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message?.slice(0, 300) : String(e);
            console.log(`[keeper]  resize_line err: ${msg}`);
          }
        } else {
          console.log("[keeper]  not keeper — skip resize_line (would require keeper signer)");
        }

        for (const c of collateral) {
          const state = await readMultiplier(client.rpc, c.mint);
          if (!state) {
            console.log(`[keeper]  mint ${c.mint} — no multiplier extension`);
            continue;
          }
          const now = Math.floor(Date.now() / 1000);
          const live = actionIsLive(state, now);
          console.log(
            `[keeper]  mint ${c.mint} mult=${state.multiplier} new=${state.newMultiplier} effTs=${state.newEffectiveTs} live=${live} deltaBps=${deltaBps(state)}`,
          );

          if (!live) continue;
          const slotBits = c.slot.multiplierBits;
          if (slotBits !== state.multiplierBits) {
            console.log(`[keeper]   slot baseline ${slotBits} != mint baseline ${state.multiplierBits} — skip harvest`);
            continue;
          }
          const d = deltaBps(state);
          if (d === null || d <= 0 || d > c.asset.maxMultiplierDeltaBps) {
            console.log(`[keeper]   corporate action guard: delta ${d} bps — skip harvest`);
            continue;
          }
          if (!isKeeper) continue;

          const markForHarvest = marks[c.index] ?? mockPriceMark(100);
          const effectiveTs = state.newEffectiveTs;
          const [vaultPda] = await findVaultPda({ line: linePda, mint: c.mint }, { programAddress: PROGRAM_ID });
          const [treasuryPda] = await findTreasuryPda({ mint: c.mint }, { programAddress: PROGRAM_ID });
          const [divPda] = await findDividendEventPda(
            { line: linePda, mint: c.mint, effectiveTs },
            { programAddress: PROGRAM_ID },
          );

          try {
            const res = await client.ledgerline.instructions
              .harvestDividend({
                config: configPda,
                line: linePda,
                asset: c.assetPda,
                mint: c.mint,
                vault: vaultPda,
                treasury: treasuryPda,
                dividendEvent: divPda,
                keeper: keeperSigner,
                tokenProgram: TOKEN_2022_PROGRAM,
                effectiveTs,
                mark: markForHarvest,
              })
              .sendTransaction();
            console.log(`[keeper]   harvest ok sig=${res.context.signature.slice(0, 16)}...`);
          } catch (e: unknown) {
            const msg = String(e instanceof Error ? e.message : e);
            if (msg.includes("AlreadyHarvested") || msg.includes("already") || msg.includes("0x17")) {
              console.log(`[keeper]   harvest rejected (idempotent): ${msg.slice(0, 200)}`);
            } else {
              console.log(`[keeper]   harvest err: ${msg.slice(0, 400)}`);
            }
          }
        }
      }
    } catch (e: unknown) {
      console.error(`[keeper] tick failed: ${e instanceof Error ? (e.stack ?? e.message) : e}`);
    }
  };

  let n = 0;
  await tick(n++);
  if (mode.once) {
    console.log("[keeper] once done");
    process.exit(0);
  }
  const interval = setInterval(() => tick(n++), 60_000);
  process.on("SIGINT", () => {
    clearInterval(interval);
    console.log("[keeper] stopped");
    process.exit(0);
  });
}
