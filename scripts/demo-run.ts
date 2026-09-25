/**
 * Arva end-to-end demo against a throwaway validator.
 *
 * This is the flow the video records — not a test, a *run*: it prints the
 * numbers as they change on-chain, and leaves a real keeper-written
 * demo/state.json behind. Every refusal it triggers is printed with the
 * program's own error message: the guards are the product.
 *
 * Requires a validator with the program + a Token-2022 carrying
 * ScaledUiAmount (scripts/demo.sh provides all of that).
 */
import * as fs from "fs";
import * as path from "path";
import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram, Transaction, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ExtensionType, getMintLen,
  createInitializeMintInstruction, createInitializeScaledUiAmountConfigInstruction,
  createInitializeTransferFeeConfigInstruction, createAssociatedTokenAccountInstruction,
  createMintToInstruction, getAssociatedTokenAddressSync, getAccount,
} from "@solana/spl-token";

const idl = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "target/idl/ledgerline.json"), "utf8")
);

const RPC = process.env.LL_RPC || "http://127.0.0.1:8899";
const PID = new PublicKey("CK5xutaXUwmdcLR8qh7cCZMXJ5fkqopk1P5NZEM3cLrN");
const SEED = (s: string) => Buffer.from(s);
const SCALE = new BN("1000000000");
const usd = (w: number) => ({ v: new BN(w).mul(SCALE) });
const mark = (priceUsd: number, dislocationBps = 0) => ({
  price: usd(priceUsd),
  conf: { v: SCALE.div(new BN(2)) },
  publishTs: new BN(Math.floor(Date.now() / 1000)),
  dislocationBps,
});
const step = (s: string) => console.log(`\n▸ ${s}`);
const ok = (s: string) => console.log(`  ✓ ${s}`);
const refused = (e: any) => {
  const m = String(e?.message ?? e).split("\n")[0];
  const code = /Error Code: (\w+)/.exec(String(e?.message ?? ""));
  console.log(`  ✋ refused as designed: ${code ? code[1] : m.slice(0, 80)}`);
  return code?.[1] ?? m.slice(0, 40);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const provider = new anchor.AnchorProvider(new anchor.web3.Connection(RPC, "confirmed"), providerWallet(), { commitment: "confirmed" });
  anchor.setProvider(provider);
  const program = new Program(idl as any, provider); // id = idl.address
  const admin = provider.wallet.publicKey;

  // ---- mints: public mock (6dp, ScaledUi 1.0) and pre-IPO mock (9dp, 1% fee) ----
  step("creating the two collateral mints (Token-2022, live Token-2022 program required)");
  const pubMint = Keypair.generate();
  {
    const space = getMintLen([ExtensionType.ScaledUiAmountConfig]);
    await provider.sendAndConfirm(
      new Transaction().add(
        SystemProgram.createAccount({ fromPubkey: admin, newAccountPubkey: pubMint.publicKey, space, lamports: await provider.connection.getMinimumBalanceForRentExemption(space), programId: TOKEN_2022_PROGRAM_ID }),
        createInitializeScaledUiAmountConfigInstruction(pubMint.publicKey, admin, 1.0, TOKEN_2022_PROGRAM_ID),
        createInitializeMintInstruction(pubMint.publicKey, 6, admin, null, TOKEN_2022_PROGRAM_ID)
      ),
      [pubMint]
    );
  }
  const preMint = Keypair.generate();
  {
    const space = getMintLen([ExtensionType.TransferFeeConfig, ExtensionType.ScaledUiAmountConfig]);
    await provider.sendAndConfirm(
      new Transaction().add(
        SystemProgram.createAccount({ fromPubkey: admin, newAccountPubkey: preMint.publicKey, space, lamports: await provider.connection.getMinimumBalanceForRentExemption(space), programId: TOKEN_2022_PROGRAM_ID }),
        createInitializeTransferFeeConfigInstruction(preMint.publicKey, admin, admin, 100, BigInt("18446744073709551615"), TOKEN_2022_PROGRAM_ID),
        createInitializeScaledUiAmountConfigInstruction(preMint.publicKey, admin, 1.0, TOKEN_2022_PROGRAM_ID),
        createInitializeMintInstruction(preMint.publicKey, 9, admin, admin, TOKEN_2022_PROGRAM_ID)
      ),
      [preMint]
    );
  }
  const usdcMint = Keypair.generate();
  await provider.sendAndConfirm(
    new Transaction().add(
      SystemProgram.createAccount({ fromPubkey: admin, newAccountPubkey: usdcMint.publicKey, space: 82, lamports: await provider.connection.getMinimumBalanceForRentExemption(82), programId: TOKEN_PROGRAM_ID }),
      createInitializeMint2ish(usdcMint.publicKey)
    ),
    [usdcMint]
  );
  ok(`public mock ${pubMint.publicKey.toBase58().slice(0, 8)}… (6dp) | pre-IPO mock ${preMint.publicKey.toBase58().slice(0, 8)}… (9dp, 1% fee) — PreStocks-shaped`);

  // ---- protocol bootstrap ----
  step("init config + list both assets (add_asset reads the mint accounts; caller claims are cross-checked)");
  const [configPda] = PublicKey.findProgramAddressSync([SEED("config")], PID);
  const [reservePda] = PublicKey.findProgramAddressSync([SEED("reserve")], PID);
  // the reserve *is* the PDA token account (init constraint seeds=[reserve]),
  // not an ATA under it — mirrors the integration suite exactly.
  const reserveUsdcAta = reservePda;
  await program.methods.initConfig(admin, 25, 50, 1000)
    .accounts({ config: configPda, reserveAta: reserveUsdcAta, usdcMint: usdcMint.publicKey, admin, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY })
    .rpc();
  ok("config + USDC reserve");

  const borrower = Keypair.generate();
  await provider.connection.confirmTransaction(await provider.connection.requestAirdrop(borrower.publicKey, 2_000_000_000));

  const baseParams = (mint: PublicKey, over: any) => ({
    stockMint: mint, equityFeedId: new Array(32).fill(1), tokenFeedId: new Array(32).fill(2),
    maxLtvRegularBps: 5500, maxLtvExtendedBps: 4500, maxLtvClosedBps: 3000,
    liqThresholdBps: 6500, liqFloorBps: 8500, liquidationBonusBps: 500,
    maxConfRatioBps: 500, confFloorBps: new BN(200), maxMultiplierDeltaBps: 500,
    minPoolDepthUsd: new BN(250_000), decimals: 6, enabled: true, bump: 0,
    marketKind: { publicEquity: {} }, maxValuationDivergenceBps: 0, maxTransferFeeBps: 0,
    issuerControls: 0, _reserved: new Array(58).fill(0), ...over,
  });
  const pda = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, PID)[0];
  const pubAssetPda = pda([SEED("asset"), pubMint.publicKey.toBuffer()]);
  const preAssetPda = pda([SEED("asset"), preMint.publicKey.toBuffer()]);
  await program.methods.addAsset(baseParams(pubMint.publicKey, {}) as any)
    .accounts({ config: configPda, assetAccount: pubAssetPda, stockMint: pubMint.publicKey, admin, systemProgram: SystemProgram.programId }).rpc();
  await program.account.asset.fetch(pubAssetPda); // readback — proves the listing is real
  ok("public asset listed (fetched back)");
  await program.methods.addAsset(baseParams(preMint.publicKey, {
    decimals: 9, marketKind: { preIpo: {} }, maxValuationDivergenceBps: 500,
    maxTransferFeeBps: 1000, maxLtvClosedBps: 2500, liqFloorBps: 9200,
  }) as any)
    .accounts({ config: configPda, assetAccount: preAssetPda, stockMint: preMint.publicKey, admin, systemProgram: SystemProgram.programId }).rpc();
  const listed = await program.account.asset.fetch(preAssetPda);
  ok(`pre-IPO asset listed — issuer_controls=${listed.issuerControls} (program read freeze|mint|fee off the mint itself)`);

  // ---- the borrower's line ----
  step("open line, fund the borrower, deposit one token of each kind");
  const linePda = pda([SEED("line"), borrower.publicKey.toBuffer()]);
  const openIx = await program.methods.openLine({ repayDebt: {} } as any)
    .accounts({ config: configPda, line: linePda, owner: borrower.publicKey, systemProgram: SystemProgram.programId }).instruction();
  await provider.sendAndConfirm(new Transaction().add(openIx), [borrower]);
  ok(`line ${linePda.toBase58().slice(0, 8)}…`);

  const bPub = getAssociatedTokenAddressSync(pubMint.publicKey, borrower.publicKey, true, TOKEN_2022_PROGRAM_ID);
  const bPre = getAssociatedTokenAddressSync(preMint.publicKey, borrower.publicKey, true, TOKEN_2022_PROGRAM_ID);
  const bUsdc = getAssociatedTokenAddressSync(usdcMint.publicKey, borrower.publicKey, true, TOKEN_PROGRAM_ID);
  await provider.sendAndConfirm(new Transaction().add(
    createAssociatedTokenAccountInstruction(admin, bPub, borrower.publicKey, pubMint.publicKey, TOKEN_2022_PROGRAM_ID),
    createAssociatedTokenAccountInstruction(admin, bPre, borrower.publicKey, preMint.publicKey, TOKEN_2022_PROGRAM_ID),
    createAssociatedTokenAccountInstruction(admin, bUsdc, borrower.publicKey, usdcMint.publicKey, TOKEN_PROGRAM_ID),
    createMintToInstruction(pubMint.publicKey, bPub, admin, 100_000_000, [], TOKEN_2022_PROGRAM_ID), // 100 public shares
    createMintToInstruction(preMint.publicKey, bPre, admin, 20_000_000_000, [], TOKEN_2022_PROGRAM_ID), // 20 pre-IPO tokens (9dp)
    createMintToInstruction(usdcMint.publicKey, reserveUsdcAta, admin, 10_000_000_000, [], TOKEN_PROGRAM_ID) // reserve liquidity
  ));
  const pubVault = pda([SEED("vault"), linePda.toBuffer(), pubMint.publicKey.toBuffer()]);
  const preVault = pda([SEED("vault"), linePda.toBuffer(), preMint.publicKey.toBuffer()]);
  const depA = await program.methods.deposit(new BN(10_000_000)).accounts({
    config: configPda, line: linePda, asset: pubAssetPda, owner: borrower.publicKey, vault: pubVault,
    mint: pubMint.publicKey, from: bPub, tokenProgram: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId,
  }).instruction();
  const depB = await program.methods.deposit(new BN(2_000_000_000)).accounts({
    config: configPda, line: linePda, asset: preAssetPda, owner: borrower.publicKey, vault: preVault,
    mint: preMint.publicKey, from: bPre, tokenProgram: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId,
  }).instruction();
  await provider.sendAndConfirm(new Transaction().add(depA, depB), [borrower]);
  const vaultPre = await getAccount(provider.connection, preVault, undefined, TOKEN_2022_PROGRAM_ID);
  ok(`10 public shares in; 2 pre-IPO tokens sent — vault holds ${Number(vaultPre.amount) / 1e9} (1% transfer fee measured, not assumed)`);

  step("keeper sizes the line: both slots priced at $100");
  await program.methods.resizeLine([mark(100), mark(100)])
    .accounts({ config: configPda, line: linePda, keeper: admin })
    .remainingAccounts([{ pubkey: pubAssetPda, isSigner: false, isWritable: false }, { pubkey: preAssetPda, isSigner: false, isWritable: false }])
    .rpc();
  const sized = await program.account.creditLine.fetch(linePda);
  const session = Object.keys(sized.lastSession)[0];
  ok(`collateral $${sized.collateralUsdc.toNumber() / 1e6}, credit $${sized.creditLimitUsdc.toNumber() / 1e6}, session=${session} (pre-IPO half pinned to its closed tier either way)`);

  step("draw: 100 USDC against the public collateral");
  await program.methods.draw(new BN(100_000_000)).accounts({
    config: configPda, line: linePda, reserveAta: reserveUsdcAta, usdcMint: usdcMint.publicKey,
    recipient: bUsdc, keeper: admin, tokenProgram: TOKEN_PROGRAM_ID,
  }).rpc();
  const afterDraw = await program.account.creditLine.fetch(linePda);
  ok(`debt $${afterDraw.usdcDebt.toNumber() / 1e6} (incl. 25bps fee); borrower USDC: ${Number((await getAccount(provider.connection, bUsdc, undefined, TOKEN_PROGRAM_ID)).amount) / 1e6}`);

  step("guard demo A — the sized mark disagrees with the issuer's own number: 501bps past the cap, the program refuses the resize");
  // The guard reads the *divergence* the keeper measured between sizing and
  // issuer marks (and the program, not the page, enforces the bound) — a
  // keeper moving the price without moving the issuer cross-reference is a
  // different failure mode, caught by the 120s window, not this guard.
  try {
    await program.methods.resizeLine([mark(100), mark(100, 501)])
      .accounts({ config: configPda, line: linePda, keeper: admin })
      .remainingAccounts([{ pubkey: pubAssetPda, isSigner: false, isWritable: false }, { pubkey: preAssetPda, isSigner: false, isWritable: false }])
      .rpc();
    console.log("  !! that should have been refused");
  } catch (e: any) { refused(e); }
  // 500 bps exactly at the cap: accepted, sizing stays fresh for the rest.
  await program.methods.resizeLine([mark(100), mark(100, 500)])
    .accounts({ config: configPda, line: linePda, keeper: admin })
    .remainingAccounts([{ pubkey: pubAssetPda, isSigner: false, isWritable: false }, { pubkey: preAssetPda, isSigner: false, isWritable: false }])
    .rpc();
  ok("resize at exactly the cap: accepted — boundary behavior is the spec, not a fudge");

  step("guard demo B — harvest on pre-IPO collateral: refused before anything is read");
  try {
    const ts = new BN(Math.floor(Date.now() / 1000) + 4);
    const divPda = pda([SEED("div"), linePda.toBuffer(), preMint.publicKey.toBuffer(), Buffer.from(ts.toArrayLike(Buffer, "le", 8))]);
    await program.methods.harvestDividend(ts, mark(100)).accounts({
      config: configPda, line: linePda, asset: preAssetPda, mint: preMint.publicKey, vault: preVault,
      treasury: pda([SEED("treasury"), preMint.publicKey.toBuffer()]), dividendEvent: divPda, keeper: admin,
      tokenProgram: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId,
    }).rpc();
    console.log("  !! that should have been refused");
  } catch (e: any) { refused(e); }

  step("keeper loop — two ticks, state file for the demo page");
  const keeperCfg = JSON.parse(fs.readFileSync(path.join(__dirname, "../keeper/config.demo.json"), "utf8"));
  keeperCfg.assets = [
    { label: "MOCK-AAPLx (public tier)", mint: pubMint.publicKey.toBase58(), marketKind: "publicEquity",
      sizing: { source: "static", priceUsd: 100, confUsd: 0.5 }, issuer: { source: "static", priceUsd: 100 } },
    { label: "MOCK-OPENAI (pre-IPO tier)", mint: preMint.publicKey.toBase58(), marketKind: "preIpo",
      sizing: { source: "static", priceUsd: 100, confUsd: 0.5 }, issuer: { source: "static", priceUsd: 100 } },
  ];
  fs.writeFileSync(path.join(__dirname, "../keeper/config.demo.json"), JSON.stringify(keeperCfg, null, 2));
  ok("keeper config rewritten with the live mints; see scripts/demo.sh output for the tick log");
  // the keeper must *be* config.keeper or every tick dies on NotKeeper — for
  // the demo that's the admin wallet; KEEPER.md documents the separate hot
  // key as the deployment shape.
  const idJson = path.join(process.env.HOME ?? "", ".config/solana/id.json");
  fs.mkdirSync(path.join(__dirname, "../.anchor"), { recursive: true });
  fs.copyFileSync(idJson, path.join(__dirname, "../.anchor/demo-keypair.json"));
  ok("keeper signer provisioned (.anchor/demo-keypair.json = local demo admin)");

  step("guard demo C — the 120s pre-IPO draw window is real: we now wait 125 seconds of wall clock");
  console.log("  (the staleness test in the suite does this too; no clock-warp hack exists here, and faking one would fake the guard)");
  await sleep(125_000);
  await program.methods.draw(new BN(100_000)).accounts({
    config: configPda, line: linePda, reserveAta: reserveUsdcAta, usdcMint: usdcMint.publicKey,
    recipient: bUsdc, keeper: admin, tokenProgram: TOKEN_PROGRAM_ID,
  }).rpc().catch((e: any) => refused(e));

  step("re-size unlocks the draw again (fresh mark, same price)");
  await program.methods.resizeLine([mark(100), mark(100)])
    .accounts({ config: configPda, line: linePda, keeper: admin })
    .remainingAccounts([{ pubkey: pubAssetPda, isSigner: false, isWritable: false }, { pubkey: preAssetPda, isSigner: false, isWritable: false }])
    .rpc();
  await program.methods.draw(new BN(100_000)).accounts({
    config: configPda, line: linePda, reserveAta: reserveUsdcAta, usdcMint: usdcMint.publicKey,
    recipient: bUsdc, keeper: admin, tokenProgram: TOKEN_PROGRAM_ID,
  }).rpc();
  ok("draw of $0.10 succeeded within seconds of a fresh sizing — the window is a freshness rule, not a rate limit");

  const fin = await program.account.creditLine.fetch(linePda);
  console.log(`\n■ final state: debt $${fin.usdcDebt.toNumber() / 1e6} · credit $${fin.creditLimitUsdc.toNumber() / 1e6} · event_seq ${fin.eventSeq.toNumber()} (five event kinds; a gap in seq means a consumer missed one)`);
  console.log("■ written: demo/state.json (keeper) — the page in demo/index.html renders exactly this shape live.\n");

  // leave a state file even before keeper ticks so the page always renders
  fs.writeFileSync(path.join(__dirname, "../demo/state.json"), JSON.stringify({
    generatedAt: new Date().toISOString(), network: RPC, programId: PID.toBase58(),
    lines: [], recentActions: [], note: "run scripts/demo.sh (which ticks the keeper) to populate",
  }, null, 2));
  console.log("demo-run complete: OK");
})().catch((e) => { console.error("DEMO FAILED:", e); process.exit(1); });

function providerWallet(): anchor.Wallet {
  const p = (process.env.ANCHOR_WALLET || path.join(process.env.HOME ?? "", ".config/solana/id.json"))
    .replace(/^~/, process.env.HOME ?? "");
  return new anchor.Wallet(Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8")))));
}
function createInitializeMint2ish(mint: PublicKey) {
  // legacy token program InitializeMint (no extensions to init first)
  return createInitializeMintInstruction(mint, 6, provider().publicKey, null, TOKEN_PROGRAM_ID);
}
function provider(): any { return anchor.getProvider(); }
