/**
 * Send mock stock + USDC from the operator wallet (dev-wallet.json) to a
 * Phantom address so the Devnet sandbox can deposit/draw.
 *
 * Usage (from Ledgerline/):
 *   node scripts/send-demo-tokens.cjs <PHANTOM_ADDRESS>
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Connection, Keypair, PublicKey, Transaction } = require("@solana/web3.js");
const {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAccount,
} = require("@solana/spl-token");

const ROOT = path.resolve(__dirname, "..");
const RPC = process.env.ANCHOR_PROVIDER_URL || "https://api.devnet.solana.com";
const STOCK_RAW = 50_000_000n; // 50 shares, 6dp
const USDC_RAW = 5_000_000_000n; // 5,000 USDC, 6dp

function loadMints() {
  const t = fs.readFileSync(path.join(ROOT, "app/lib/devnet-mints.ts"), "utf8");
  const g = (k) => t.match(new RegExp(`${k}:\\s*"(\\w+)"`))[1];
  return {
    stockMint: new PublicKey(g("stockMint")),
    usdcMint: new PublicKey(g("usdcMint")),
    stockToken: new PublicKey(g("stockToken")),
    usdcToken: new PublicKey(g("usdcToken")),
  };
}

function loadOperator() {
  const candidates = [
    process.env.ANCHOR_WALLET,
    path.join(ROOT, "dev-wallet.json"),
    path.join(os.homedir(), ".config", "solana", "id.json"),
  ].filter(Boolean);
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    const kp = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(p, "utf8"))));
    return { kp, p };
  }
  throw new Error("no operator wallet (dev-wallet.json or ANCHOR_WALLET)");
}

async function main() {
  const destStr = process.argv[2];
  if (!destStr) {
    console.error("usage: node scripts/send-demo-tokens.cjs <PHANTOM_ADDRESS>");
    process.exit(1);
  }
  const dest = new PublicKey(destStr);
  const mints = loadMints();
  const { kp: payer, p: walletPath } = loadOperator();
  const connection = new Connection(RPC, "confirmed");

  console.log("operator", payer.publicKey.toBase58(), `(${walletPath})`);
  console.log("recipient", dest.toBase58());

  const stockSrc = await getAccount(connection, mints.stockToken, "confirmed", TOKEN_2022_PROGRAM_ID);
  if (!stockSrc.owner.equals(payer.publicKey)) {
    throw new Error(
      `operator ${payer.publicKey.toBase58()} does not own the mock stock account (owner ${stockSrc.owner.toBase58()})`
    );
  }

  const stockAta = getAssociatedTokenAddressSync(mints.stockMint, dest, false, TOKEN_2022_PROGRAM_ID);
  const usdcAta = getAssociatedTokenAddressSync(mints.usdcMint, dest, false, TOKEN_PROGRAM_ID);

  const ix = [
    createAssociatedTokenAccountIdempotentInstruction(
      payer.publicKey, stockAta, dest, mints.stockMint, TOKEN_2022_PROGRAM_ID
    ),
    createAssociatedTokenAccountIdempotentInstruction(
      payer.publicKey, usdcAta, dest, mints.usdcMint, TOKEN_PROGRAM_ID
    ),
    createTransferCheckedInstruction(
      mints.stockToken, mints.stockMint, stockAta, payer.publicKey,
      STOCK_RAW, 6, [], TOKEN_2022_PROGRAM_ID
    ),
    createTransferCheckedInstruction(
      mints.usdcToken, mints.usdcMint, usdcAta, payer.publicKey,
      USDC_RAW, 6, [], TOKEN_PROGRAM_ID
    ),
  ];

  const sig = await connection.sendTransaction(new Transaction().add(...ix), [payer]);
  await connection.confirmTransaction(sig, "confirmed");
  console.log("sent", sig);
  console.log("stock ATA", stockAta.toBase58(), " +50 shares");
  console.log("usdc ATA ", usdcAta.toBase58(), " +5000 USDC");
  console.log("https://explorer.solana.com/tx/" + sig + "?cluster=devnet");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
