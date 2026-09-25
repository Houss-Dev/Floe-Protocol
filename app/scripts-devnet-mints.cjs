/**
 * One-time devnet bootstrap: creates the mock collateral mint (Token-2022 with
 * ScaledUiAmount) and the mock USDC mint, tops up the operator wallet, and
 * writes app/lib/devnet-mints.ts for the web sandbox.
 *
 * Browser wallets cannot sign brand-new mint keypairs, so this script uses the
 * on-disk operator keypair (~/.config/solana/id.json or ANCHOR_WALLET).
 *
 * Run from anywhere: node app/scripts-devnet-mints.cjs
 */
const fs = require("fs");
const path = require("path");
const os = require("os");

const {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
} = require("@solana/web3.js");
const {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createInitializeScaledUiAmountConfigInstruction,
  createInitializeMintInstruction,
  createInitializeMint2Instruction,
  createMintToInstruction,
  createInitializeAccount3Instruction,
  getMintLen,
  ExtensionType,
  ACCOUNT_SIZE,
} = require("@solana/spl-token");

const RPC = process.env.ANCHOR_PROVIDER_URL || process.env.NEXT_PUBLIC_RPC_URL || "https://api.devnet.solana.com";
const STOCK_DECIMALS = 6;
const USDC_DECIMALS = 6;
const STOCK_SHARES_RAW = 1_000_000_000n; // 1000.000000 shares
const USDC_SEED_RAW = 50_000_000_000n; // 50,000.000000 USDC
const OUT_FILE = path.resolve(__dirname, "lib", "devnet-mints.ts");
const KEY_DIR = path.resolve(__dirname, "..", "target", "mints");

async function sendOk(connection, tx, signers) {
  const sig = await connection.sendTransaction(tx, signers);
  await connection.confirmTransaction({ signature: sig, commitment: "confirmed" }).catch(() => {});
  return sig;
}

function loadWallet() {
  const walletPath = process.env.ANCHOR_WALLET
    ? path.resolve(process.env.ANCHOR_WALLET)
    : path.join(os.homedir(), ".config", "solana", "id.json");
  const secret = JSON.parse(fs.readFileSync(walletPath, "utf8"));
  return { keypair: Keypair.fromSecretKey(new Uint8Array(secret)), path: walletPath };
}

function loadOrCreateMint(name) {
  const file = path.join(KEY_DIR, `${name}.json`);
  if (fs.existsSync(file)) {
    return { keypair: Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(file, "utf8")))), created: false };
  }
  const kp = Keypair.generate();
  fs.mkdirSync(KEY_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(Array.from(kp.secretKey)));
  return { keypair: kp, created: true };
}

async function createToken2022StockMint(connection, payer, mint) {
  const mintLen = getMintLen([ExtensionType.ScaledUiAmountConfig]);
  const lamports = await connection.getMinimumBalanceForRentExemption(mintLen);
  const multiplier = 1.0; // ScaledUiAmount: u64 double-bits; 1.0 == 2^32 in adjacent form
  const tx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: mint.publicKey,
      space: mintLen,
      lamports,
      programId: TOKEN_2022_PROGRAM_ID,
    }),
    createInitializeScaledUiAmountConfigInstruction(mint.publicKey, payer.publicKey, multiplier),
    createInitializeMintInstruction(mint.publicKey, STOCK_DECIMALS, payer.publicKey, null, TOKEN_2022_PROGRAM_ID)
  );
return sendOk(connection, tx, [payer, mint]);
}

async function createUsdcMint(connection, payer, mint) {
  const mintLen = getMintLen([]);
  const lamports = await connection.getMinimumBalanceForRentExemption(mintLen);
  const tx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: mint.publicKey,
      space: mintLen,
      lamports,
      programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeMint2Instruction(mint.publicKey, USDC_DECIMALS, payer.publicKey, null, TOKEN_PROGRAM_ID)
  );
return sendOk(connection, tx, [payer, mint]);
}

async function ensureTokenAccount(connection, payer, mint, owner, programId, keyName) {
  const kp = loadOrCreateMint(keyName).keypair;
  const info = await connection.getAccountInfo(kp.publicKey, { commitment: "confirmed" });
  if (!info) {
    const lamports = await connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE);
    const tx = new Transaction().add(
      SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: kp.publicKey, space: ACCOUNT_SIZE, lamports, programId }),
      createInitializeAccount3Instruction(kp.publicKey, mint, owner, programId)
    );
    await sendOk(connection, tx, [payer, kp]);
  }
  const bal = await connection.getTokenAccountBalance(kp.publicKey, { commitment: "confirmed" }).catch(() => ({ value: { amount: "0" } }));
  return { address: kp.publicKey, amount: BigInt(bal.value.amount) };
}

async function main() {
  const { keypair: payer, path: walletPath } = loadWallet();
  const connection = new Connection(RPC, "confirmed");
  console.log(`RPC:      ${RPC}`);
  console.log(`Wallet:   ${payer.publicKey.toString()}  (${walletPath})`);
  console.log(`Balance:  ${(await connection.getBalance(payer.publicKey)) / LAMPORTS_PER_SOL} SOL`);

  const stock = loadOrCreateMint("stock");
  const usdc = loadOrCreateMint("usdc");
  console.log(`stockMint ${stock.created ? "created" : "reused"}  ${stock.keypair.publicKey.toString()}`);
  console.log(`usdcMint  ${usdc.created ? "created" : "reused"}  ${usdc.keypair.publicKey.toString()}`);

  if (stock.created) await createToken2022StockMint(connection, payer, stock.keypair);
  if (usdc.created) await createUsdcMint(connection, payer, usdc.keypair);

const stockTok = await ensureTokenAccount(connection, payer, stock.keypair.publicKey, payer.publicKey, TOKEN_2022_PROGRAM_ID, "stock-ata");
  const usdcTok = await ensureTokenAccount(connection, payer, usdc.keypair.publicKey, payer.publicKey, TOKEN_PROGRAM_ID, "usdc-ata");

  const stockBal = stockTok.amount;
  const usdcBal = usdcTok.amount;
  const txs = [];
  if (stockBal < STOCK_SHARES_RAW) {
    txs.push(await sendOk(connection,
      new Transaction().add(createMintToInstruction(stock.keypair.publicKey, stockTok.address, payer.publicKey, STOCK_SHARES_RAW, [], TOKEN_2022_PROGRAM_ID)),
      [payer]
    ));
  }
  if (usdcBal < USDC_SEED_RAW) {
    txs.push(await sendOk(connection,
      new Transaction().add(createMintToInstruction(usdc.keypair.publicKey, usdcTok.address, payer.publicKey, USDC_SEED_RAW, [], TOKEN_PROGRAM_ID)),
      [payer]
    ));
  }
  if (txs.length) console.log(`minted:   ${txs.join(", ")}`);

  const ts = `export const DEVNET_MINTS = {\n  stockMint: "${stock.keypair.publicKey.toString()}",\n  usdcMint: "${usdc.keypair.publicKey.toString()}",\n  stockToken: "${stockTok.address.toString()}",\n  usdcToken: "${usdcTok.address.toString()}",\n  decimals: ${STOCK_DECIMALS},\n  stockMultiplier: 1,\n};\n`;
  fs.writeFileSync(OUT_FILE, ts);
  console.log(`wrote ${OUT_FILE}`);
  console.log(`stock token      ${stockTok.address.toString()}: ${(await connection.getTokenAccountBalance(stockTok.address)).value.uiAmount} shares`);
  console.log(`usdc token       ${usdcTok.address.toString()}: ${(await connection.getTokenAccountBalance(usdcTok.address)).value.uiAmount} USDC`);
  console.log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
