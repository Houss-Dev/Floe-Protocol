import fs from "fs";
import path from "path";
import {
  AccountRole,
  type Address,
  type Instruction,
  type Signer,
} from "@solana/kit";
import {
  findAssetPda,
  findConfigPda,
  getCreditLineDecoder,
  PayoutMode,
  Session,
  type CreditLine,
  type PriceMarkArgs,
} from "@ledgerline/ledgerline";
import { applyIssuerDislocation, prestocksMarks, sizingMark, USD_SCALE } from "./marks.js";
import type { KeeperConfig, LineView } from "./types.js";

/** Kit client with ledgerline plugin (createClient + ledgerlineProgram). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ConfigKeeperClient = any;

export const PRE_IPO_DRAW_WINDOW = 120;

function sessionLabel(session: Session): string {
  return Session[session] ?? "unknown";
}

function payoutLabel(mode: PayoutMode): string {
  return PayoutMode[mode] ?? "unknown";
}

function writeState(cfg: KeeperConfig, repoRoot: string, state: unknown): void {
  const statePath = path.join(repoRoot, cfg.stateFile);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

export async function runConfigTick(
  cfg: KeeperConfig,
  repoRoot: string,
  programId: Address,
  client: ConfigKeeperClient,
  keeper: Signer,
  log: (s: string) => void,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const snapshotPath = path.join(repoRoot, "docs/data/prestocks.json");

  const [configPda] = await findConfigPda({ programAddress: programId });
  const configMaybe = await client.ledgerline.accounts.config.fetchMaybe(configPda);
  if (!configMaybe.exists) {
    log(`program ${cfg.programId} not initialized on ${cfg.rpc}; empty tick`);
    writeState(cfg, repoRoot, {
      generatedAt: new Date().toISOString(),
      network: cfg.rpc,
      programId: cfg.programId,
      keeper: keeper.address,
      lines: [],
      recentActions: [],
    });
    return;
  }

  const programAccounts = await client.rpc
    .getProgramAccounts(programId, { encoding: "base64" })
    .send();

  const lineEntries: { linePda: Address; line: CreditLine }[] = [];
  for (const { pubkey, account } of programAccounts) {
    try {
      const line = getCreditLineDecoder().decode(Buffer.from(account.data[0], "base64"));
      if (line.nCollateral > 0) lineEntries.push({ linePda: pubkey, line });
    } catch {
      /* not a credit line */
    }
  }

  const prestocks = await prestocksMarks(cfg, snapshotPath).catch(() => null);
  const assetByMint = new Map(cfg.assets.map((a) => [a.mint, a]));
  const actions: Record<string, unknown>[] = [];
  const lines: LineView[] = [];

  for (const { linePda, line } of lineEntries) {
    const activeWithIdx = line.collateral
      .map((c, i) => ({ c, i }))
      .filter((x) => x.c.inUse);
    const active = activeWithIdx.map((x) => x.c);
    const age = now - Number(line.lastSizingTs);
    const hasPreIpo = active.some((c) => assetByMint.get(String(c.mint))?.marketKind === "preIpo");
    const cadence = cfg.refreshSecs ?? 30;
    const mustRefresh = hasPreIpo ? age > PRE_IPO_DRAW_WINDOW / 2 : age > cadence;

    const slots: LineView["slots"] = [];
    for (const c of active) {
      const a = assetByMint.get(String(c.mint));
      slots.push({
        mint: String(c.mint),
        label: a?.label ?? "unlisted",
        marketKind: a?.marketKind ?? "publicEquity",
        raw: Number(c.rawAmount),
        decimals: 0,
        estimatedUsd: 0,
      });
    }

    let markOk = true;
    const marks: PriceMarkArgs[] = [];
    const assetPdas: Address[] = [];

    for (let i = 0; i < active.length; i++) {
      const c = active[i];
      const a = assetByMint.get(String(c.mint));
      if (!a) {
        markOk = false;
        break;
      }
      try {
        const m = await sizingMark(cfg, a, snapshotPath);
        applyIssuerDislocation(m, a.issuer, prestocks, a.mint);
        marks.push(m);
        const [assetPda] = await findAssetPda({ mint: c.mint }, { programAddress: programId });
        assetPdas.push(assetPda);

        const mintInfo = await client.rpc.getAccountInfo(c.mint, { encoding: "base64" }).send();
        const data = mintInfo.value?.data[0];
        const dec =
          data && Buffer.from(data, "base64").length >= 82 ? Buffer.from(data, "base64")[44] : 9;
        slots[i].decimals = dec;
        slots[i].estimatedUsd = (Number(m.price.v) / Number(USD_SCALE)) * (Number(c.rawAmount) / 10 ** dec);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        log(`  ! ${a.label}: mark unavailable (${msg.slice(0, 90)})`);
        markOk = false;
        break;
      }
    }

    if (markOk && mustRefresh && active.length > 0) {
      try {
        const baseInstr = await client.ledgerline.instructions.resizeLine({
          config: configPda,
          line: linePda,
          keeper,
          marks,
        });
        const instrWithAssets: Instruction = {
          ...baseInstr,
          accounts: [
            ...(baseInstr.accounts ?? []),
            ...assetPdas.map((address) => ({ address, role: AccountRole.READONLY })),
          ],
        } as Instruction;
        await client.sendTransaction(instrWithAssets);
        actions.push({ ts: now, line: linePda, ok: true, marks: marks.length });
        log(`  ~ resized ${String(linePda).slice(0, 6)}… (${marks.length} marks)`);
      } catch (e: unknown) {
        const msg = (e instanceof Error ? e.message : String(e)).split("\n")[0];
        actions.push({ ts: now, line: linePda, ok: false, error: msg.slice(0, 160) });
        log(`  x resize refused: ${msg.slice(0, 120)}`);
      }
    } else if (!markOk && active.length > 0) {
      actions.push({
        ts: now,
        line: linePda,
        ok: false,
        error: "skipped: incomplete marks (fail closed)",
      });
    }

    lines.push({
      owner: String(line.owner),
      session: sessionLabel(line.lastSession),
      collateralUsd: Number(line.collateralUsdc) / 1e6,
      creditUsd: Number(line.creditLimitUsdc) / 1e6,
      debtUsd: Number(line.usdcDebt) / 1e6,
      availableUsd: Number(line.availableCreditUsdc) / 1e6,
      ltvBps: line.collateralUsdc
        ? Math.floor((Number(line.usdcDebt) * 10_000) / Number(line.collateralUsdc))
        : 0,
      lastSizingAgeSecs: age,
      preIpoDrawWindowSecs: PRE_IPO_DRAW_WINDOW,
      payoutMode: payoutLabel(line.payoutMode),
      eventSeq: 0,
      slots,
    });
  }

  writeState(cfg, repoRoot, {
    generatedAt: new Date().toISOString(),
    network: cfg.rpc,
    programId: cfg.programId,
    keeper: keeper.address,
    lines,
    recentActions: actions,
  });
}
