/**
 * One-shot devnet bootstrap (operator wallet):
 *   init_config -> add_asset (public equity mock mint) -> open_line -> deposit -> fund reserve
 *
 * Requires: node app/scripts-devnet-mints.cjs first (writes app/lib/devnet-mints.ts).
 * Uses root Anchor IDL at idl/ledgerline.json.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const anchor = require("@coral-xyz/anchor");
const {
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Keypair,
  Transaction,
} = require("@solana/web3.js");
const {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
} = require("@solana/spl-token");

const ROOT = path.resolve(__dirname, "..");
const RPC = process.env.ANCHOR_PROVIDER_URL || "https://api.devnet.solana.com";
const SCALE = new anchor.BN("1000000000");

function loadDevnetMints() {
  const t = fs.readFileSync(path.join(ROOT, "app/lib/devnet-mints.ts"), "utf8");
  const g = (k) => t.match(new RegExp(`${k}:\\s*"(\\w+)"`))[1];
  return {
    stockMint: g("stockMint"),
    usdcMint: g("usdcMint"),
    stockToken: g("stockToken"),
    usdcToken: g("usdcToken"),
  };
}

function assetParams(stockMintPk) {
  return {
    stockMint: stockMintPk,
    equityFeedId: new Array(32).fill(1),
    tokenFeedId: new Array(32).fill(2),
    maxLtvRegularBps: 5500,
    maxLtvExtendedBps: 4500,
    maxLtvClosedBps: 3000,
    liqThresholdBps: 6500,
    liqFloorBps: 8500,
    liquidationBonusBps: 500,
    maxConfRatioBps: 500,
    confFloorBps: new anchor.BN(200),
    maxMultiplierDeltaBps: 500,
    minPoolDepthUsd: new anchor.BN(250_000),
    decimals: 6,
    enabled: true,
    bump: 0,
    marketKind: { publicEquity: {} },
    maxValuationDivergenceBps: 0,
    maxTransferFeeBps: 0,
    issuerControls: 0,
    _reserved: new Array(58).fill(0),
  };
}

const mark = () => ({
  price: { v: new anchor.BN(100).mul(SCALE) },
  conf: { v: SCALE.div(new anchor.BN(2)) },
  publishTs: new anchor.BN(Math.floor(Date.now() / 1000)),
  dislocationBps: 0,
});

async function main() {
  const mints = loadDevnetMints();
  const secret = JSON.parse(
    fs.readFileSync(process.env.ANCHOR_WALLET || path.join(os.homedir(), ".config/solana/id.json"), "utf8"),
  );
  const admin = Keypair.fromSecretKey(new Uint8Array(secret));
  const connection = new anchor.web3.Connection(RPC, "confirmed");
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(admin), { commitment: "confirmed" });
  anchor.setProvider(provider);

  const idl = JSON.parse(fs.readFileSync(path.join(ROOT, "idl/ledgerline.json"), "utf8"));
  const program = new anchor.Program(idl, provider);
  const PID = program.programId;
  console.log("program", PID.toString());
  console.log("admin  ", admin.publicKey.toString());

  const find = (seeds) => PublicKey.findProgramAddressSync(seeds, PID)[0];
  const B = (s) => Buffer.from(s);
  const stockMint = new PublicKey(mints.stockMint);
  const usdcMint = new PublicKey(mints.usdcMint);
  const config = find([B("config")]);
  const reserve = find([B("reserve")]);
  const line = find([B("line"), admin.publicKey.toBuffer()]);
  const asset = find([B("asset"), stockMint.toBuffer()]);
  const vault = find([B("vault"), line.toBuffer(), stockMint.toBuffer()]);

  let configExists = false;
  try {
    await program.account.config.fetch(config);
    configExists = true;
    console.log("config already exists — skipping init_config");
  } catch {
    console.log("init_config…");
    await program.methods
      .initConfig(admin.publicKey, 25, 50, 1000)
      .accounts({
        config,
        reserveAta: reserve,
        usdcMint,
        admin: admin.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc();
  }

  const assetInfo = await connection.getAccountInfo(asset);
  const assetExists = Boolean(assetInfo && assetInfo.owner.equals(PID));
  if (assetExists) {
    console.log("asset PDA already exists — skipping add_asset");
  } else {
    console.log("add_asset (publicEquity mock xStock)…");
    await program.methods
      .addAsset(assetParams(stockMint))
      .accounts({
        config,
        assetAccount: asset,
        stockMint,
        admin: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  const lineInfo = await connection.getAccountInfo(line);
  let lineExists = Boolean(lineInfo && lineInfo.owner.equals(PID));
  if (lineExists) {
    try {
      await program.account.creditLine.fetch(line);
      console.log("credit line PDA already initialized — skipping open_line");
    } catch {
      console.log(
        "credit line PDA exists but is not decodable (older layout). Skipping open/deposit; fund reserve only.",
      );
    }
  }

  if (!lineExists) {
    console.log("open_line…");
    await program.methods
      .openLine({ repayDebt: {} })
      .accounts({ config, line, owner: admin.publicKey, systemProgram: SystemProgram.programId })
      .rpc();

    console.log("deposit 10 shares…");
    await program.methods
      .deposit(new anchor.BN(10_000_000))
      .accounts({
        config,
        line,
        asset,
        owner: admin.publicKey,
        vault,
        mint: stockMint,
        from: new PublicKey(mints.stockToken),
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .rpc();

    console.log("resize_line…");
    await program.methods
      .resizeLine([mark()])
      .remainingAccounts([{ pubkey: asset, isWritable: false, isSigner: false }])
      .accounts({ config, line, keeper: admin.publicKey })
      .rpc();
  }

  const cfg = await program.account.config.fetch(config);
  const configUsdc = cfg.usdcMint;
  if (!configUsdc.equals(usdcMint)) {
    console.warn(
      `devnet-mints usdc (${usdcMint.toString()}) != config.usdc (${configUsdc.toString()}). Using config mint for reserve funding.`,
    );
  }
  let usdcFrom = new PublicKey(mints.usdcToken);
  if (!configUsdc.equals(usdcMint)) {
    usdcFrom = getAssociatedTokenAddressSync(configUsdc, admin.publicKey, true, TOKEN_PROGRAM_ID);
    const ataInfo = await connection.getAccountInfo(usdcFrom);
    if (!ataInfo) {
      await provider.sendAndConfirm(
        new Transaction().add(
          createAssociatedTokenAccountInstruction(
            admin.publicKey,
            usdcFrom,
            admin.publicKey,
            configUsdc,
            TOKEN_PROGRAM_ID,
          ),
        ),
      );
    }
  }

  console.log("fund reserve $2000 USDC…");
  const fundTx = new Transaction().add(
    createTransferInstruction(usdcFrom, cfg.usdcReserve, admin.publicKey, 2000 * 1e6, [], TOKEN_PROGRAM_ID),
  );
  await provider.sendAndConfirm(fundTx);

  const ln = await program.account.creditLine.fetch(line).catch(() => null);
  console.log("\nBootstrap complete.");
  console.log("  config PDA ", config.toString());
  console.log("  reserve    ", reserve.toString());
  console.log("  asset PDA  ", asset.toString());
  if (ln) {
    console.log("  line PDA   ", line.toString());
    console.log("  collateral ", Number(ln.collateralUsdc) / 1e6, "USD");
    console.log("  limit      ", Number(ln.creditLimitUsdc) / 1e6, "USD");
  }
  console.log("  keeper     ", cfg.keeper.toString());
  console.log("\nApp: cd app && npm run dev  → Devnet sandbox (connect same wallet as admin for keeper role).");
}

main().catch((e) => {
  console.error(e);
  if (e.logs) console.error(e.logs.join("\n"));
  process.exit(1);
});
