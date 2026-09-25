/**
 * One-off: compare devnet on-chain config vs app/lib/devnet-mints.ts for each program ID.
 */
const anchor = require("@coral-xyz/anchor");
const { PublicKey, Connection } = require("@solana/web3.js");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const RPC = process.env.ANCHOR_PROVIDER_URL || "https://api.devnet.solana.com";
function repoProgramId() {
  return fs
    .readFileSync(path.join(ROOT, "programs/ledgerline/src/lib.rs"), "utf8")
    .match(/declare_id!\("([^"]+)"/)[1];
}

const PROGRAM_IDS = [repoProgramId()];

function loadDevnetMints() {
  const t = fs.readFileSync(path.join(ROOT, "app/lib/devnet-mints.ts"), "utf8");
  const g = (k) => t.match(new RegExp(`${k}:\\s*"(\\w+)"`))[1];
  return { stockMint: g("stockMint"), usdcMint: g("usdcMint") };
}

async function main() {
  const mints = loadDevnetMints();
  const idlRaw = fs.readFileSync(path.join(ROOT, "idl/ledgerline.json"), "utf8").replace(/^\uFEFF/, "");
  const idl = JSON.parse(idlRaw);
  const conn = new Connection(RPC, "confirmed");
  const provider = new anchor.AnchorProvider(conn, { publicKey: PublicKey.default }, {});
  anchor.setProvider(provider);

  const out = { rpc: RPC, devnetMintsFile: mints, programs: [] };

  for (const programIdStr of PROGRAM_IDS) {
    idl.address = programIdStr;
    const programId = new PublicKey(programIdStr);
    const program = new anchor.Program(idl, provider);
    const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], programId);
    const info = await conn.getAccountInfo(configPda);
    const row = { programId: programIdStr, configPda: configPda.toBase58(), configExists: !!info };
    if (!info) {
      out.programs.push(row);
      continue;
    }
    const cfg = await program.account.config.fetch(configPda);
    row.admin = cfg.admin.toBase58();
    row.keeper = cfg.keeper.toBase58();
    row.usdcMint = cfg.usdcMint.toBase58();
    row.usdcReserve = cfg.usdcReserve.toBase58();
    row.usdcMintMatchesDevnetMintsTs = row.usdcMint === mints.usdcMint;

    const [assetPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("asset"), new PublicKey(mints.stockMint).toBuffer()],
      programId,
    );
    row.mockStockAssetPda = assetPda.toBase58();
    row.mockStockAssetListed = !!(await conn.getAccountInfo(assetPda));

    try {
      const bal = await conn.getTokenAccountBalance(cfg.usdcReserve);
      row.reserveUsdc = bal.value.uiAmountString;
    } catch (e) {
      row.reserveUsdc = null;
      row.reserveError = String(e.message || e);
    }

    const accts = await conn.getProgramAccounts(programId, { encoding: "base64" });
    row.programAccountCount = accts.length;
    row.accounts = accts.map((a) => ({
      pubkey: a.pubkey.toBase58(),
      dataLen: Buffer.isBuffer(a.account.data)
        ? a.account.data.length
        : Buffer.from(a.account.data[0], "base64").length,
    }));
    out.programs.push(row);
  }

  out.repoProgramId = repoProgramId();
  out.appEnvProgramId = (() => {
    try {
      const env = fs.readFileSync(path.join(ROOT, "app/.env.local"), "utf8");
      const m = env.match(/NEXT_PUBLIC_PROGRAM_ID=(\w+)/);
      return m ? m[1] : null;
    } catch {
      return null;
    }
  })();

  for (const row of out.programs) {
    if (!row.configExists) continue;
    idl.address = row.programId;
    const program = new anchor.Program(idl, provider);
    try {
      const lines = await program.account.creditLine.all();
      row.creditLines = lines.map((l) => ({
        pda: l.publicKey.toBase58(),
        owner: l.account.owner.toBase58(),
        usdcDebt: l.account.usdcDebt.toString(),
        collateralUsdc: l.account.collateralUsdc.toString(),
      }));
    } catch (e) {
      row.creditLinesError = String(e.message || e);
    }
  }

  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
