import * as anchor from "@coral-xyz/anchor";
import {
  TOKEN_2022_PROGRAM_ID,
  ExtensionType,
  getMintLen,
  createInitializeMintInstruction,
  createInitializeScaledUiAmountConfigInstruction,
  createUpdateMultiplierDataInstruction,
} from "@solana/spl-token";
import { Keypair, SystemProgram, Transaction } from "@solana/web3.js";

/**
 * Diagnostic: dump the raw bytes of a Token-2022 mint carrying ScaledUiAmount.
 *
 * Arva reads the multiplier at fixed offsets inside the extension
 * (multiplier @32, new_effective_ts @40, new_multiplier @48), so the extension
 * header has to be where spl-token-2022 8.0.1 expects it. Rather than trusting
 * either client's parser, walk the account data by hand.
 */
const BASE_MINT_LEN = 82;
const ACCOUNT_TYPE_OFFSET = 82;

function walk(data: Buffer) {
  console.log("  account length :", data.length);
  console.log("  account type   :", data.readUInt8(ACCOUNT_TYPE_OFFSET), "(1 = Mint)");
  let off = ACCOUNT_TYPE_OFFSET + 1;
  let found = false;
  while (off + 4 <= data.length) {
    const type = data.readUInt16LE(off);
    const len = data.readUInt16LE(off + 2);
    console.log(`  ext @${off}: type=${type} len=${len}`);
    if (type === ExtensionType.ScaledUiAmountConfig) {
      found = true;
      const body = data.subarray(off + 4, off + 4 + len);
      const asF64 = (bits: bigint) =>
        new DataView(new BigUint64Array([bits]).buffer).getFloat64(0, true);
      console.log("    authority      :", body.subarray(0, 32).toString("hex"));
      const oldBits = body.readBigUInt64LE(32);
      const effTs = body.readBigInt64LE(40);
      const newBits = body.readBigUInt64LE(48);
      console.log("    multiplier     :", oldBits.toString(), "=", asF64(oldBits));
      console.log("    new_eff_ts     :", effTs.toString());
      console.log("    new_multiplier :", newBits.toString(), "=", asF64(newBits));
      const o = asF64(oldBits), n = asF64(newBits);
      if (o !== 0) console.log("    delta bps      :", Math.round((n / o - 1) * 10000));
      break;
    }
    if (len === 0) break;
    off += 4 + len;
  }
  if (!found) {
    console.log("  !! ScaledUiAmountConfig extension NOT FOUND; full hex:");
    console.log("  " + data.toString("hex"));
  }
  return found;
}

describe("multiplier layout", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const admin = provider.wallet.publicKey;

  it("stores the extension where Arva expects it", async () => {
    const mint = Keypair.generate();
    const space = getMintLen([ExtensionType.ScaledUiAmountConfig]);
    console.log("\ngetMintLen([ScaledUiAmountConfig]) =", space);

    await provider.sendAndConfirm(
      new Transaction().add(
        SystemProgram.createAccount({
          fromPubkey: admin,
          newAccountPubkey: mint.publicKey,
          space,
          lamports: await provider.connection.getMinimumBalanceForRentExemption(space),
          programId: TOKEN_2022_PROGRAM_ID,
        }),
        createInitializeScaledUiAmountConfigInstruction(mint.publicKey, admin, 1.0, TOKEN_2022_PROGRAM_ID),
        createInitializeMintInstruction(mint.publicKey, 6, admin, null, TOKEN_2022_PROGRAM_ID)
      ),
      [mint]
    );

    console.log("\nafter init:");
    walk((await provider.connection.getAccountInfo(mint.publicKey))!.data as unknown as Buffer);

    const ts = BigInt(Math.floor(Date.now() / 1000) - 5);
    console.log("\nupdating to 1.007 effective", ts.toString());
    await provider.sendAndConfirm(
      new Transaction().add(
        createUpdateMultiplierDataInstruction(mint.publicKey, admin, 1.007, ts, [], TOKEN_2022_PROGRAM_ID)
      )
    );

    console.log("\nafter update:");
    const found = walk((await provider.connection.getAccountInfo(mint.publicKey))!.data as unknown as Buffer);
    console.log("\nfound:", found, " passed ts:", ts.toString());
  });
});
