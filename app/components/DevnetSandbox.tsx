"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Address, Instruction } from "@solana/kit";
import { AccountRole, getAddressDecoder, getAddressEncoder, getProgramDerivedAddress } from "@solana/kit";
import {
  getU64Encoder,
  getU8Encoder,
  getStructEncoder,
  fixEncoderSize,
} from "@solana/codecs";
import { useClient } from "@solana/react";
import type { AppClient } from "../lib/solana";
import {
  findConfigPda,
  findLinePda,
  findAssetPda,
  findVaultPda,
  findReserveAtaPda,
  MarketKind,
  PayoutMode,
} from "@ledgerline/ledgerline";
import { DEVNET_MINTS } from "../lib/devnet-mints";
import { RPC_URL } from "../lib/constants";
import { devnetAdminEnabled } from "../lib/flags";

const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" as Address;
const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL" as Address;
const SCALE = BigInt(1_000_000_000); // u128 scale (1e9) for Fixed price/conf
const MARKET_PRICE_USD = 100; // $100 per share
const MARKET_CONF_USD = 0.5;

function toFixedUsd(usd: number): { v: bigint } {
  return { v: BigInt(Math.round(usd * Number(SCALE))) };
}
function toU64(n: number): bigint {
  return BigInt(Math.round(n * 1_000_000));
}

async function findAta(owner: Address, mint: Address, tokenProgram: Address): Promise<Address> {
  const [ata] = await getProgramDerivedAddress({
    programAddress: ASSOCIATED_TOKEN_PROGRAM,
    seeds: [
      getAddressEncoder().encode(owner),
      getAddressEncoder().encode(tokenProgram),
      getAddressEncoder().encode(mint),
    ],
  });
  return ata;
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function accountExists(address: string): Promise<boolean> {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getAccountInfo",
      params: [address, { encoding: "base64" }],
    }),
  });
  const json = await res.json();
  return json.result?.value != null;
}

async function readTokenAccount(address: string): Promise<{ owner: string; amount: bigint } | null> {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getAccountInfo",
      params: [address, { encoding: "base64" }],
    }),
  });
  const json = await res.json();
  const b64 = json.result?.value?.data?.[0];
  if (!b64) return null;
  const raw = b64ToBytes(b64);
  if (raw.length < 72) return null;
  return {
    owner: getAddressDecoder().decode(raw.subarray(32, 64)),
    amount: new DataView(raw.buffer, raw.byteOffset + 64, 8).getBigUint64(0, true),
  };
}

async function destTokenAccountForWallet(
  wallet: Address,
  mint: Address,
  tokenProgram: Address,
  fallback?: Address
): Promise<Address> {
  if (fallback) {
    const fb = await readTokenAccount(fallback);
    if (fb && fb.owner === wallet) return fallback;
  }
  const ata = await findAta(wallet, mint, tokenProgram);
  const got = await readTokenAccount(ata);
  if (got && got.owner === wallet) return ata;
  throw new Error(
    `No token account for this wallet. From repo root (Floe): node scripts/send-demo-tokens.cjs ${wallet}`
  );
}

async function tokenAccountForWallet(
  wallet: Address,
  mint: Address,
  tokenProgram: Address,
  fallback?: Address
): Promise<Address> {
  const dest = await destTokenAccountForWallet(wallet, mint, tokenProgram, fallback).catch(() => null);
  if (dest) {
    const got = await readTokenAccount(dest);
    if (got && got.amount > BigInt(0)) return dest;
  }
  throw new Error(
    `This wallet has no tokens for mint ${mint.slice(0, 8)}… Run from repo root (Floe): node scripts/send-demo-tokens.cjs ${wallet}`
  );
}

function errText(e: any): string {
  const parts = [e?.message ?? String(e)];
  let cur = e?.cause;
  for (let i = 0; i < 6 && cur; i++) {
    if (cur.message && !parts.includes(cur.message)) parts.push(cur.message);
    if (String(cur.message ?? cur).includes("7050003") || String(cur).includes("7050003")) {
      parts.push(
        "Root cause: an account in this transaction does not exist on devnet (often missing config/asset, credit line not opened, or no mock-stock token account). Check config ✓ asset ✓ line ✓ in the panel above."
      );
    }
    const logs = cur.context?.logs ?? cur.logs;
    if (Array.isArray(logs) && logs.length) {
      const hit = logs.filter((l: string) => /Error|failed|denied|custom/i.test(l)).slice(-8);
      if (hit.length) parts.push(hit.join(" | "));
    }
    cur = cur.cause;
  }
  return parts.join(" — ");
}

const splTransferEncoder = getStructEncoder([
  ["command", fixEncoderSize(getU8Encoder(), 1)],
  ["amount", getU64Encoder()],
]);

export function DevnetSandbox() {
  const client = useClient<AppClient>();
  const [state, setState] = useState<{ config: any; asset: any; line: any; legacy: string[] } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState<{ t: string; k?: "ok" | "err" }[]>([]);
  const [depositShares, setDepositShares] = useState("10");
  const [drawUsd, setDrawUsd] = useState("200");
  const [repayUsd, setRepayUsd] = useState("50");
  const [fundUsd, setFundUsd] = useState("2000");

  const connected = client.wallet?.getState().status === "connected";
  const wpk = client.wallet?.getState().connected?.account?.address as Address | undefined;

  const pdas = useMemo(async () => {
    if (!wpk) return null;
    const [config, reserve, line, asset, vault] = await Promise.all([
      findConfigPda(),
      findReserveAtaPda(),
      findLinePda({ owner: wpk }),
      findAssetPda({ mint: DEVNET_MINTS.stockMint as Address }),
      findVaultPda({ line: (await findLinePda({ owner: wpk }))[0], mint: DEVNET_MINTS.stockMint as Address }),
    ]);
    return { config: config[0], reserve: reserve[0], line: line[0], asset: asset[0], vault: vault[0] };
  }, [wpk]);

  const logIt = useCallback((t: string, k?: "ok" | "err") => setLog((l) => [...l.slice(-40), { t, k }]), []);
  const explorer = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;

  // fetchMaybe returns {exists:false} when the account is missing, but THROWS
  // when bytes exist that don't match the current codec (e.g. a line written
  // by a pre-interest_apr_bps program build). Surface those as "legacy" so
  // the UI can explain instead of misreporting "missing".
  const refresh = useCallback(async () => {
    if (!connected || !pdas) return;
    try {
      const resolvedPdas = await pdas;
      const fetchLenient = async (
        kind: "config" | "asset" | "creditLine",
        address: Address
      ): Promise<{ status: "ok" | "missing" | "legacy"; data: any }> => {
        try {
          const m: any = await (client.ledgerline.accounts[kind] as any).fetchMaybe(address);
          return m.exists ? { status: "ok", data: m.data } : { status: "missing", data: null };
        } catch {
          return { status: "legacy", data: null };
        }
      };
      const [config, asset, line] = await Promise.all([
        fetchLenient("config", resolvedPdas.config),
        fetchLenient("asset", resolvedPdas.asset),
        fetchLenient("creditLine", resolvedPdas.line),
      ]);
      setState({
        config: config.data,
        asset: asset.data,
        line: line.data,
        legacy: [config, asset, line]
          .map((r, i) => (r.status === "legacy" ? ["config", "asset", "line"][i] : null))
          .filter(Boolean) as string[],
      });
    } catch (e: any) {
      logIt(`refresh: ${e.message}`, "err");
    }
  }, [connected, pdas, client, logIt]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const run = useCallback(
    async (label: string, fn: () => Promise<string>) => {
      if (!connected) return logIt("connect a wallet first", "err");
      if (typeof window !== "undefined") {
        const ok = window.confirm(
          `Send on devnet: ${label}\n\nCluster: solana:devnet\nFee payer: your wallet\n\nRPC preflight simulates before the wallet asks you to sign. Proceed?`,
        );
        if (!ok) return logIt(`${label} cancelled`, "err");
      }
      setBusy(label);
      try {
        logIt(`${label}: preflight simulation via RPC…`);
        const sig = await fn();
        logIt(`${label} sent: ${sig}`);
        logIt(`  view: ${explorer(sig)}`);
        await refresh();
      } catch (e: any) {
        logIt(`${label} FAILED: ${errText(e)}`, "err");
        console.error(e);
      } finally {
        setBusy(null);
      }
    },
    [connected, refresh, logIt]
  );

  const mark = () => ({
    price: toFixedUsd(MARKET_PRICE_USD),
    conf: toFixedUsd(MARKET_CONF_USD),
    publishTs: BigInt(Math.floor(Date.now() / 1000)),
    dislocationBps: 0,
  });

  const assetParams = () => ({
    stockMint: DEVNET_MINTS.stockMint as Address,
    equityFeedId: new Uint8Array(32).fill(1),
    tokenFeedId: new Uint8Array(32).fill(2),
    maxLtvRegularBps: 5500,
    maxLtvExtendedBps: 4500,
    maxLtvClosedBps: 3000,
    liqThresholdBps: 6500,
    liqFloorBps: 8500,
    liquidationBonusBps: 500,
    maxConfRatioBps: 500,
    confFloorBps: BigInt(200),
    maxMultiplierDeltaBps: 500,
    minPoolDepthUsd: BigInt(250_000),
    decimals: 6,
    enabled: true,
    bump: 0,
    marketKind: MarketKind.PublicEquity,
    maxValuationDivergenceBps: 0,
    maxTransferFeeBps: 0,
    issuerControls: 0,
    reserved: new Uint8Array(58),
  });

  const actions = {
    initConfig: async () => {
      const resolvedPdas = await pdas;
      const res = await client.ledgerline.instructions.initConfig({
        config: resolvedPdas!.config,
        reserveAta: resolvedPdas!.reserve,
        usdcMint: DEVNET_MINTS.usdcMint as Address,
        admin: client.identity,
        keeper: wpk!,
        feeBpsDraw: 25,
        feeBpsDividend: 50,
        baseAprBps: 1000,
      }).sendTransaction();
      return res.context.signature;
    },
    addAsset: async () => {
      const resolvedPdas = await pdas;
      const res = await client.ledgerline.instructions.addAsset({
        config: resolvedPdas!.config,
        assetAccount: resolvedPdas!.asset,
        stockMint: DEVNET_MINTS.stockMint as Address,
        admin: client.identity,
        params: assetParams(),
      }).sendTransaction();
      return res.context.signature;
    },
    openLine: async (mode: "repayDebt" | "payout") => {
      const resolvedPdas = await pdas;
      const payoutMode = mode === "repayDebt" ? PayoutMode.RepayDebt : PayoutMode.Payout;
      const res = await client.ledgerline.instructions.openLine({
        config: resolvedPdas!.config,
        line: resolvedPdas!.line,
        owner: client.identity,
        payoutMode,
      }).sendTransaction();
      return res.context.signature;
    },
    deposit: async (shares: number) => {
      if (!Number.isFinite(shares) || shares <= 0) {
        throw new Error("Enter a positive number of shares to deposit.");
      }
      const resolvedPdas = await pdas;
      const missing: string[] = [];
      if (!(await accountExists(resolvedPdas!.config))) missing.push("config (run devnet bootstrap or Init config)");
      if (!(await accountExists(resolvedPdas!.asset))) missing.push("asset (Add asset / bootstrap)");
      if (missing.length) {
        throw new Error(`On-chain setup missing: ${missing.join(", ")}.`);
      }
      const lineAcc = await client.ledgerline.accounts.creditLine.fetchMaybe(resolvedPdas!.line);
      if (!lineAcc.exists) {
        await client.ledgerline.instructions.openLine({
          config: resolvedPdas!.config,
          line: resolvedPdas!.line,
          owner: client.identity,
          payoutMode: PayoutMode.RepayDebt,
        }).sendTransaction();
        const again = await client.ledgerline.accounts.creditLine.fetchMaybe(resolvedPdas!.line);
        if (!again.exists) {
          throw new Error("Open line did not create a credit line PDA — check devnet SOL and console.");
        }
      }
      const from = await tokenAccountForWallet(
        wpk!,
        DEVNET_MINTS.stockMint as Address,
        TOKEN_2022_PROGRAM,
        DEVNET_MINTS.stockToken as Address
      );
      const res = await client.ledgerline.instructions.deposit({
        config: resolvedPdas!.config,
        line: resolvedPdas!.line,
        asset: resolvedPdas!.asset,
        owner: client.identity,
        vault: resolvedPdas!.vault,
        mint: DEVNET_MINTS.stockMint as Address,
        from,
        tokenProgram: TOKEN_2022_PROGRAM,
        amount: toU64(shares),
      }).sendTransaction();
      return res.context.signature;
    },
    resize: async () => {
      if (!state?.line) {
        throw new Error(`No line for this wallet yet — click "Open line" first, then Resize.`);
      }
      if (state?.config?.keeper && wpk && String(state.config.keeper) !== wpk) {
        throw new Error(
          `Resize is keeper-signed. Config keeper is ${String(state.config.keeper).slice(0, 8)}… — your wallet is not the keeper. From repo root (Floe): node scripts/keeper-draw.cjs ${wpk} 50`
        );
      }
      const resolvedPdas = await pdas;
      const baseInstr = await client.ledgerline.instructions.resizeLine({
        config: resolvedPdas!.config,
        line: resolvedPdas!.line,
        keeper: client.identity,
        marks: [mark()],
      });
      // The Anchor IDL does not declare `resize_line`'s remaining accounts (one
      // per collateral slot), so append the asset meta here. Instruction data
      // still comes from the Codama builder; we only append an account meta.
      const instrWithAsset: Instruction = {
        ...baseInstr,
        accounts: [
          ...(baseInstr.accounts ?? []),
          { address: resolvedPdas!.asset, role: AccountRole.READONLY },
        ],
      } as Instruction;
      const res = await client.sendTransaction(instrWithAsset);
      return res.context.signature;
    },
    fundReserve: async (usd: number) => {
      const amount = toU64(usd);
      const from = await tokenAccountForWallet(
        wpk!,
        DEVNET_MINTS.usdcMint as Address,
        TOKEN_PROGRAM,
        DEVNET_MINTS.usdcToken as Address
      );
      const transferIx: Instruction = {
        programAddress: TOKEN_PROGRAM,
        accounts: [
          { address: from, role: AccountRole.WRITABLE },
          { address: DEVNET_MINTS.usdcMint as Address, role: AccountRole.READONLY },
          { address: (await pdas)!.reserve, role: AccountRole.WRITABLE },
          { address: wpk!, role: AccountRole.WRITABLE_SIGNER },
        ],
        data: splTransferEncoder.encode({ command: 3, amount }),
      };
      const res = await client.sendTransaction(transferIx);
      return res.context.signature;
    },
    draw: async (usd: number) => {
      if (state?.config?.keeper && wpk && String(state.config.keeper) !== wpk) {
        throw new Error(
          `Draw is keeper-signed (card/terminal flow). Run from repo root (Floe): node scripts/keeper-draw.cjs ${wpk} ${usd}`
        );
      }
      const resolvedPdas = await pdas;
      const recipient = await destTokenAccountForWallet(
        wpk!,
        DEVNET_MINTS.usdcMint as Address,
        TOKEN_PROGRAM,
        DEVNET_MINTS.usdcToken as Address
      );
      const res = await client.ledgerline.instructions.draw({
        config: resolvedPdas!.config,
        line: resolvedPdas!.line,
        reserveAta: resolvedPdas!.reserve,
        usdcMint: DEVNET_MINTS.usdcMint as Address,
        recipient,
        keeper: client.identity,
        tokenProgram: TOKEN_PROGRAM,
        amount: toU64(usd),
      }).sendTransaction();
      return res.context.signature;
    },
    repay: async (usd: number) => {
      const resolvedPdas = await pdas;
      const from = await tokenAccountForWallet(
        wpk!,
        DEVNET_MINTS.usdcMint as Address,
        TOKEN_PROGRAM,
        DEVNET_MINTS.usdcToken as Address
      );
      const res = await client.ledgerline.instructions.repay({
        config: resolvedPdas!.config,
        line: resolvedPdas!.line,
        reserveAta: resolvedPdas!.reserve,
        usdcMint: DEVNET_MINTS.usdcMint as Address,
        from,
        payerAuthority: client.identity,
        tokenProgram: TOKEN_PROGRAM,
        amount: toU64(usd),
      }).sendTransaction();
      return res.context.signature;
    },
    setPayoutMode: async (mode: "repayDebt" | "payout") => {
      const resolvedPdas = await pdas;
      const payoutMode = mode === "repayDebt" ? PayoutMode.RepayDebt : PayoutMode.Payout;
      const res = await client.ledgerline.instructions.setPayoutMode({
        line: resolvedPdas!.line,
        owner: client.identity,
        payoutMode,
      }).sendTransaction();
      return res.context.signature;
    },
    closeLine: async () => {
      const resolvedPdas = await pdas;
      const res = await client.ledgerline.instructions.closeLine({
        config: resolvedPdas!.config,
        line: resolvedPdas!.line,
        owner: client.identity,
      }).sendTransaction();
      return res.context.signature;
    },
    withdrawAll: async () => {
      const resolvedPdas = await pdas;
      // The program rejects amount 0 (ZeroAmount): withdraw the slot's exact
      // raw amount, read from the decoded line.
      const maybeLine = await client.ledgerline.accounts.creditLine.fetchMaybe(resolvedPdas!.line);
      const rawAmount = maybeLine.exists ? (maybeLine.data.collateral[0]?.rawAmount ?? BigInt(0)) : BigInt(0);
      if (rawAmount === BigInt(0)) throw new Error("no collateral to withdraw");
      const res = await client.ledgerline.instructions.withdraw({
        config: resolvedPdas!.config,
        line: resolvedPdas!.line,
        owner: client.identity,
        vault: resolvedPdas!.vault,
        mint: DEVNET_MINTS.stockMint as Address,
        to: await destTokenAccountForWallet(
          wpk!,
          DEVNET_MINTS.stockMint as Address,
          TOKEN_2022_PROGRAM,
          DEVNET_MINTS.stockToken as Address
        ),
        tokenProgram: TOKEN_2022_PROGRAM,
        amount: rawAmount,
      }).sendTransaction();
      return res.context.signature;
    },
  };

  const cfg = state?.config;
  const aset = state?.asset;
  const ln = state?.line;
  const legacy = state?.legacy ?? [];
  const legacyLine = legacy.includes("line");
  const debtUsd = ln?.usdcDebt ? Number(ln.usdcDebt) / 1_000_000 : 0;
  const availUsd = ln?.availableCreditUsdc ? Number(ln.availableCreditUsdc) / 1_000_000 : 0;
  const collUsd = ln?.collateralUsdc ? Number(ln.collateralUsdc) / 1_000_000 : 0;
  const limitUsd = ln?.creditLimitUsdc ? Number(ln.creditLimitUsdc) / 1_000_000 : 0;

  return (
    <div className="pro-card space-y-4 p-5 md:p-6">
      <div className="flex flex-wrap items-center gap-2 justify-between">
        <div>
          <h2 className="text-lg font-semibold text-pro-text">Devnet sandbox</h2>
          <p className="text-xs text-pro-muted">
            Exercises the deployed program with your wallet on Solana devnet. Mock xStock at ${MARKET_PRICE_USD}/share.
            Keeper is set to your wallet at <code className="font-mono">initConfig</code> so you can draw and resize.
          </p>
        </div>
        <div className="text-xs font-mono text-right">
          <div>config {cfg ? "✓" : legacy.includes("config") ? "legacy" : "–"}</div>
          <div>asset {aset ? "✓" : legacy.includes("asset") ? "legacy" : "–"}</div>
          <div>line {ln ? "✓" : legacyLine ? "legacy" : "– (open first)"}</div>
        </div>
      </div>

      {!connected && (
        <div className="rounded-xl bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-800">
          Connect a wallet (Phantom or Solflare) to use the sandbox.
        </div>
      )}

      {legacy.length > 0 && (
        <div className="rounded-xl bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-800">
          Legacy {legacy.join(", ")} account detected — written by an older program build and unreadable by the
          current codec. The program cannot act on it; use a fresh wallet for the demo.
        </div>
      )}

      <div className="grid md:grid-cols-4 gap-3 text-sm">
        <div className="rounded-xl bg-foreground p-3 text-paper">
          <div className="text-[11px] uppercase tracking-wider text-paper/60">Debt</div>
          <div className="text-xl font-semibold mt-1">${debtUsd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
        </div>
        <div className="rounded-xl bg-foreground p-3 text-paper">
          <div className="text-[11px] uppercase tracking-wider text-paper/60">Collateral</div>
          <div className="text-xl font-semibold mt-1">${collUsd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
        </div>
        <div className="rounded-xl bg-foreground p-3 text-paper">
          <div className="text-[11px] uppercase tracking-wider text-paper/60">Limit</div>
          <div className="text-xl font-semibold mt-1">${limitUsd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
        </div>
        <div className="rounded-xl border border-accent/30 bg-tint-green p-3">
          <div className="text-[11px] uppercase tracking-wider text-accent">Available</div>
          <div className="text-xl font-semibold mt-1">${availUsd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
        </div>
      </div>

      {cfg && (
        <div className="grid grid-cols-2 gap-2 rounded-xl border border-pro-border bg-pro-elevated p-3 font-mono text-xs text-pro-muted md:grid-cols-4">
          <span>keeper {cfg.keeper.toString().slice(0, 10)}…</span>
          <span>fee draw {cfg.feeBpsDraw}/10k · div {cfg.feeBpsDividend}/10k</span>
          <span>baseApr {cfg.baseAprBps}bps</span>
          <span>{cfg.paused ? "PAUSED" : "live"}</span>
        </div>
      )}

      <div className="grid sm:grid-cols-2 gap-3">
        <div className="border border-pro-border rounded-2xl p-4 space-y-3">
          <h3 className="text-sm font-semibold">1 · Setup</h3>
          <div className="grid grid-cols-2 gap-2">
            {devnetAdminEnabled ? (
              <>
                <button disabled={!!busy || !connected} onClick={() => run("initConfig", actions.initConfig)} className="btn">
                  Init config
                </button>
                <button disabled={!!busy || !connected} onClick={() => run("addAsset", actions.addAsset)} className="btn">
                  Add asset
                </button>
              </>
            ) : (
              <p className="col-span-2 text-xs text-pro-muted">
                Protocol admin actions are disabled in this build. Use local dev or set{" "}
                <code className="font-mono">NEXT_PUBLIC_ENABLE_DEVNET_ADMIN=1</code> only on private devnet deploys.
              </p>
            )}
            <button disabled={!!busy || !connected || legacyLine} onClick={() => run("openLine(repayDebt)", () => actions.openLine("repayDebt"))} className="btn">Open line</button>
            <button disabled={!!busy || !connected} onClick={() => run("resizeLine @$100", actions.resize)} className="btn">Resize (price mark)</button>
          </div>
          <div className="flex items-center gap-2 text-sm">
            <span className="text-pro-muted">Mints:</span>
            <code className="font-mono text-[11px] break-all">{DEVNET_MINTS.stockMint.slice(0, 12)}… / {DEVNET_MINTS.usdcMint.slice(0, 12)}…</code>
          </div>
        </div>

        <div className="border border-pro-border rounded-2xl p-4 space-y-3">
          <h3 className="text-sm font-semibold">2 · Collateral & borrow</h3>
          <div className="space-y-2">
            <div className="grid grid-cols-[6rem_minmax(0,1fr)_7rem] items-center gap-x-2">
              <input
                value={depositShares}
                onChange={(e) => setDepositShares(e.target.value)}
                className="inp w-full max-w-[6rem]"
                autoComplete="off"
                suppressHydrationWarning
              />
              <span className="text-xs text-pro-muted">shares to deposit</span>
              <button
                disabled={!!busy || !connected}
                onClick={() => run("deposit", () => actions.deposit(parseFloat(depositShares) || 0))}
                className="btn inline-flex w-full items-center justify-center"
              >
                Deposit
              </button>
            </div>
            <div className="grid grid-cols-[6rem_minmax(0,1fr)_7rem] items-center gap-x-2">
              <input
                value={drawUsd}
                onChange={(e) => setDrawUsd(e.target.value)}
                className="inp w-full max-w-[6rem]"
                autoComplete="off"
                suppressHydrationWarning
              />
              <span className="text-xs text-pro-muted">USD to draw</span>
              <button
                disabled={!!busy || !connected}
                onClick={() => run("draw", () => actions.draw(parseFloat(drawUsd) || 0))}
                className="btn inline-flex w-full items-center justify-center"
              >
                Draw
              </button>
            </div>
            <div className="grid grid-cols-[6rem_minmax(0,1fr)_7rem] items-center gap-x-2">
              <input
                value={repayUsd}
                onChange={(e) => setRepayUsd(e.target.value)}
                className="inp w-full max-w-[6rem]"
                autoComplete="off"
                suppressHydrationWarning
              />
              <span className="text-xs text-pro-muted">USD to repay</span>
              <button
                disabled={!!busy || !connected}
                onClick={() => run("repay", () => actions.repay(parseFloat(repayUsd) || 0))}
                className="btn inline-flex w-full items-center justify-center"
              >
                Repay
              </button>
            </div>
            <div className="grid grid-cols-[6rem_minmax(0,1fr)_7rem] items-center gap-x-2">
              <input
                value={fundUsd}
                onChange={(e) => setFundUsd(e.target.value)}
                className="inp w-full max-w-[6rem]"
                autoComplete="off"
                suppressHydrationWarning
              />
              <span className="text-xs text-pro-muted leading-snug">USDC to seed reserve (before draw)</span>
              <button
                disabled={!!busy || !connected}
                onClick={() => run("fundReserve", () => actions.fundReserve(parseFloat(fundUsd) || 0))}
                className="btn inline-flex w-full items-center justify-center"
              >
                Fund reserve
              </button>
            </div>
          </div>
        </div>

        <div className="border border-pro-border rounded-2xl p-4 space-y-3">
          <h3 className="text-sm font-semibold">3 · Dividends / lifecycle</h3>
          <div className="grid grid-cols-2 gap-2">
            <button disabled={!!busy || !connected} onClick={() => run("setPayoutMode(repayDebt)", () => actions.setPayoutMode("repayDebt"))} className="btn">Mode: repay debt</button>
            <button disabled={!!busy || !connected} onClick={() => run("setPayoutMode(payout)", () => actions.setPayoutMode("payout"))} className="btn">Mode: payout</button>
            <button disabled={!!busy || !connected} onClick={() => run("withdrawAll", actions.withdrawAll)} className="btn">Withdraw ALL</button>
            <button disabled={!!busy || !connected} onClick={() => run("closeLine", actions.closeLine)} className="btn">Close line</button>
          </div>
          <div className="text-xs text-pro-muted">
            Harvest + settle dividends happen off-chain via the keeper; if the keeper is online, a harvested event will
            show up here. Liquidations also need a keeper.
          </div>
        </div>

        <div className="border border-pro-border rounded-2xl p-4 space-y-2">
          <h3 className="text-sm font-semibold">Console</h3>
          <div className="max-h-52 overflow-auto rounded-lg bg-foreground p-3 font-mono text-[11px] text-paper/85">
            {log.length === 0 && <div className="text-white/40">Actions will show here.</div>}
            {log.map((l, i) => (
              <div key={i} className={l.k === "err" ? "text-red-400" : l.k === "ok" ? "text-emerald-300" : undefined}>
                {l.t}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}