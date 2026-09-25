/**
 * Keeper-signed resize + draw for a borrower (Phantom cannot sign these).
 *
 * Usage (from Ledgerline/):
 *   node scripts/keeper-draw.cjs <OWNER_ADDRESS> [USD]
 */
const fs = require("fs");
const path = require("path");
const anchor = require("@coral-xyz/anchor");
const { PublicKey, SystemProgram } = require("@solana/web3.js");
const { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } = require("@solana/spl-token");

const ROOT = path.resolve(__dirname, "..");
const RPC = process.env.ANCHOR_PROVIDER_URL || "https://api.devnet.solana.com";
const SCALE = new anchor.BN("1000000000");

function loadMints() {
  const t = fs.readFileSync(path.join(ROOT, "app/lib/devnet-mints.ts"), "utf8");
  const g = (k) => t.match(new RegExp(`${k}:\\s*"(\\w+)"`))[1];
  return {
    stockMint: new PublicKey(g("stockMint")),
    usdcMint: new PublicKey(g("usdcMint")),
  };
}

const mark = () => ({
  price: { v: new anchor.BN(100).mul(SCALE) },
  conf: { v: SCALE.div(new anchor.BN(2)) },
  publishTs: new anchor.BN(Math.floor(Date.now() / 1000)),
  dislocationBps: 0,
});

async function main() {
  const owner = new PublicKey(process.argv[2] || "");
  const usd = Number(process.argv[3] || "50");
  if (!process.argv[2]) {
    console.error("usage: node scripts/keeper-draw.cjs <OWNER_ADDRESS> [USD]");
    process.exit(1);
  }

  const secret = JSON.parse(fs.readFileSync(path.join(ROOT, "dev-wallet.json"), "utf8"));
  const keeper = anchor.web3.Keypair.fromSecretKey(new Uint8Array(secret));
  const connection = new anchor.web3.Connection(RPC, "confirmed");
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(keeper), {
    commitment: "confirmed",
  });
  const idl = JSON.parse(fs.readFileSync(path.join(ROOT, "idl/ledgerline.json"), "utf8"));
  const program = new anchor.Program(idl, provider);
  const mints = loadMints();
  const B = (s) => Buffer.from(s);
  const find = (seeds) => PublicKey.findProgramAddressSync(seeds, program.programId)[0];

  const config = find([B("config")]);
  const line = find([B("line"), owner.toBuffer()]);
  const asset = find([B("asset"), mints.stockMint.toBuffer()]);
  const reserve = find([B("reserve")]);
  const recipient = getAssociatedTokenAddressSync(mints.usdcMint, owner, false, TOKEN_PROGRAM_ID);

  const cfg = await program.account.config.fetch(config);
  if (!cfg.keeper.equals(keeper.publicKey)) {
    throw new Error(`dev-wallet ${keeper.publicKey.toBase58()} is not config.keeper ${cfg.keeper.toBase58()}`);
  }

  console.log("keeper", keeper.publicKey.toBase58());
  console.log("owner ", owner.toBase58());
  console.log("line  ", line.toBase58());

  console.log("resize_line @ $100…");
  const resizeSig = await program.methods
    .resizeLine([mark()])
    .remainingAccounts([{ pubkey: asset, isWritable: false, isSigner: false }])
    .accounts({ config, line, keeper: keeper.publicKey })
    .rpc();
  console.log("resize", resizeSig);

  const before = await program.account.creditLine.fetch(line);
  console.log(
    `limit $${before.creditLimitUsdc.toNumber() / 1e6}  available $${before.availableCreditUsdc.toNumber() / 1e6}`
  );

  const amount = new anchor.BN(Math.round(usd * 1_000_000));
  console.log(`draw $${usd}…`);
  const drawSig = await program.methods
    .draw(amount)
    .accounts({
      config,
      line,
      reserveAta: reserve,
      usdcMint: mints.usdcMint,
      recipient,
      keeper: keeper.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
  console.log("draw", drawSig);
  console.log("https://explorer.solana.com/tx/" + drawSig + "?cluster=devnet");

  const after = await program.account.creditLine.fetch(line);
  console.log(`debt $${after.usdcDebt.toNumber() / 1e6}  available $${after.availableCreditUsdc.toNumber() / 1e6}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
