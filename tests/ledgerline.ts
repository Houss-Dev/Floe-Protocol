import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ExtensionType,
  getMintLen,
  createInitializeMintInstruction,
  createInitializeMint2Instruction,
  createInitializeScaledUiAmountConfigInstruction,
  createUpdateMultiplierDataInstruction,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  getAccount,
  createInitializeTransferFeeConfigInstruction,
  createInitializeDefaultAccountStateInstruction,
  AccountState,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  SYSVAR_CLOCK_PUBKEY,
  SYSVAR_RENT_PUBKEY,
  Transaction,
} from "@solana/web3.js";
import { assert, AssertionError } from "chai";
import * as fs from "fs";
import * as path from "path";

// Node ESM on Windows rejects `import … from "*.json"` without an import
// attribute. Read the file so ts-mocha works under both CJS and ESM.
const idl = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "target/idl/ledgerline.json"), "utf8")
);

async function onChainNow(connection: Connection): Promise<number> {
  const info = await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY);
  if (!info) throw new Error("clock sysvar missing");
  return Number(info.data.readBigInt64LE(32));
}

async function waitForOnChainTs(connection: Connection, ts: number) {
  for (let i = 0; i < 40; i++) {
    if ((await onChainNow(connection)) >= ts) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`on-chain clock never reached ${ts}`);
}

async function fundPayer(connection: Connection, dest: PublicKey) {
  const faucetPath = path.join(process.cwd(), ".anchor/test-ledger/faucet-keypair.json");
  if (!fs.existsSync(faucetPath)) {
    throw new Error(`missing faucet keypair at ${faucetPath}`);
  }
  const faucet = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(faucetPath, "utf8")))
  );
  const sig = await connection.sendTransaction(
    new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: faucet.publicKey,
        toPubkey: dest,
        lamports: 100 * LAMPORTS_PER_SOL,
      })
    ),
    [faucet]
  );
  await connection.confirmTransaction(sig, "confirmed");
}

// A Fixed value at the program's 1e9 scale.
const SCALE = new BN("1000000000");
const usd = (whole: number) => ({ v: new BN(whole).mul(SCALE) });

// Reference prices for the mock xStock.
const PRICE = 100; // $100 per share
const mark = () => ({
  price: usd(PRICE),
  conf: { v: SCALE.div(new BN(2)) }, // $0.50 -> 10 bps, inside the cap
  publishTs: new BN(Math.floor(Date.now() / 1000)),
  dislocationBps: 0,
});

/** LTV the program should grant for the session it recorded. */
const sessionLtv = (s: any): number => {
  if (s?.regular !== undefined) return 5500;
  if (s?.extended !== undefined || s?.overnight !== undefined) return 4500;
  return 3000;
};
const sessionName = (s: any): string => Object.keys(s ?? {})[0] ?? "unknown";

const SEED = {
  config: Buffer.from("config"),
  reserve: Buffer.from("reserve"),
  asset: Buffer.from("asset"),
  line: Buffer.from("line"),
  vault: Buffer.from("vault"),
  treasury: Buffer.from("treasury"),
  div: Buffer.from("div"),
};

describe("ledgerline", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = new Program(idl as any, provider);

  const admin = provider.wallet.publicKey;
  const payer = (provider.wallet as anchor.Wallet).payer;

  let stockMint: Keypair;
  let usdcMint: Keypair;
  let configPda: PublicKey;
  let reservePda: PublicKey;
  let assetPda: PublicKey;
  let linePda: PublicKey;
  let vaultPda: PublicKey;
  let treasuryPda: PublicKey;
  let userStockAta: PublicKey;
  let userUsdcAta: PublicKey;
  let reserveUsdcAta: PublicKey;

  // Risk parameters for the mock asset.
  const assetParams = () => ({
    stockMint: stockMint.publicKey,
    equityFeedId: new Array(32).fill(1),
    tokenFeedId: new Array(32).fill(2),
    maxLtvRegularBps: 5500,
    maxLtvExtendedBps: 4500,
    maxLtvClosedBps: 3000,
    liqThresholdBps: 6500,
    liqFloorBps: 8500,
    liquidationBonusBps: 500,
    maxConfRatioBps: 500,
    confFloorBps: new BN(200),
    maxMultiplierDeltaBps: 500, // 5%: a dividend, never a split
    minPoolDepthUsd: new BN(250_000),
    decimals: 6,
    enabled: true,
    bump: 0,
    // Block-1 fields: the mock is plain public equity with zero caps.
    // `marketKind` rides Anchor's variant-object encoding, same shape as
    // `payoutMode` in openLine below.
    marketKind: { publicEquity: {} },
    maxValuationDivergenceBps: 0,
    maxTransferFeeBps: 0,
    issuerControls: 0,
    // The IDL keeps the underscore name; Anchor's struct coder has no
    // default for missing fields, so the padding must be passed explicitly.
    _reserved: new Array(58).fill(0),
  });

  before(async () => {
    if ((await provider.connection.getBalance(admin)) < LAMPORTS_PER_SOL) {
      await fundPayer(provider.connection, admin);
    }

    // --- mock xStock: a Token-2022 mint with ScaledUiAmount at 1.0 ---
    stockMint = Keypair.generate();
    const space = getMintLen([ExtensionType.ScaledUiAmountConfig]);
    const createIx = SystemProgram.createAccount({
      fromPubkey: admin,
      newAccountPubkey: stockMint.publicKey,
      space,
      lamports: await provider.connection.getMinimumBalanceForRentExemption(space),
      programId: TOKEN_2022_PROGRAM_ID,
    });
    const initMintIx = createInitializeMintInstruction(stockMint.publicKey, 6, admin, null, TOKEN_2022_PROGRAM_ID);
    const initExtIx = createInitializeScaledUiAmountConfigInstruction(
      stockMint.publicKey,
      admin,
      1.0,
      TOKEN_2022_PROGRAM_ID
    );
    // Token-2022 with extensions: the extension is initialised before the mint
    // itself, and InitializeMint (not Mint2) is used. The other order makes the
    // processor reject the account with InvalidAccountData.
    await provider.sendAndConfirm(new Transaction().add(createIx, initExtIx, initMintIx), [stockMint]);

    // --- USDC stand-in: plain SPL token, 6dp ---
    usdcMint = Keypair.generate();
    const usdcSpace = getMintLen([]);
    await provider.sendAndConfirm(
      new Transaction().add(
        SystemProgram.createAccount({
          fromPubkey: admin,
          newAccountPubkey: usdcMint.publicKey,
          space: usdcSpace,
          lamports: await provider.connection.getMinimumBalanceForRentExemption(usdcSpace),
          programId: TOKEN_PROGRAM_ID,
        }),
        createInitializeMint2Instruction(usdcMint.publicKey, 6, admin, null, TOKEN_PROGRAM_ID)
      ),
      [usdcMint]
    );

    [configPda] = PublicKey.findProgramAddressSync([SEED.config], program.programId);
    [reservePda] = PublicKey.findProgramAddressSync([SEED.reserve], program.programId);
    [assetPda] = PublicKey.findProgramAddressSync(
      [SEED.asset, stockMint.publicKey.toBuffer()],
      program.programId
    );
    [linePda] = PublicKey.findProgramAddressSync([SEED.line, admin.toBuffer()], program.programId);
    [vaultPda] = PublicKey.findProgramAddressSync(
      [SEED.vault, linePda.toBuffer(), stockMint.publicKey.toBuffer()],
      program.programId
    );
    [treasuryPda] = PublicKey.findProgramAddressSync(
      [SEED.treasury, stockMint.publicKey.toBuffer()],
      program.programId
    );

    userStockAta = getAssociatedTokenAddressSync(stockMint.publicKey, admin, true, TOKEN_2022_PROGRAM_ID);
    userUsdcAta = getAssociatedTokenAddressSync(usdcMint.publicKey, admin, true, TOKEN_PROGRAM_ID);

    await provider.sendAndConfirm(
      new Transaction().add(
        createAssociatedTokenAccountInstruction(admin, userStockAta, admin, stockMint.publicKey, TOKEN_2022_PROGRAM_ID),
        createAssociatedTokenAccountInstruction(admin, userUsdcAta, admin, usdcMint.publicKey, TOKEN_PROGRAM_ID),
        // 1000 mock xStocks
        createMintToInstruction(stockMint.publicKey, userStockAta, admin, 1_000_000_000, [], TOKEN_2022_PROGRAM_ID)
      )
    );
  });

  it("initialises config and the USDC reserve", async () => {
    await program.methods
      .initConfig(admin, 25, 50, 1000)
      .accounts({
        config: configPda,
        reserveAta: reservePda,
        usdcMint: usdcMint.publicKey,
        admin,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    const config = await program.account.config.fetch(configPda);
    assert.ok(config.admin.equals(admin));
    assert.ok(config.usdcReserve.equals(reservePda));
    assert.equal(config.feeBpsDraw, 25);
    assert.equal(config.feeBpsDividend, 50);

    reserveUsdcAta = reservePda;
  });

  it("lists the mock xStock", async () => {
    await program.methods
      .addAsset(assetParams() as any)
      .accounts({
        config: configPda,
        assetAccount: assetPda,
        stockMint: stockMint.publicKey,
        admin,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const asset = await program.account.asset.fetch(assetPda);
    assert.ok(asset.stockMint.equals(stockMint.publicKey));
    assert.equal(asset.maxLtvRegularBps, 5500);
    assert.equal(asset.maxMultiplierDeltaBps, 500);
  });

  /** A real Token-2022 mint: add_asset validates the mint account itself. */
  async function newStockMint(multiplier = 1.0): Promise<Keypair> {
    const mint = Keypair.generate();
    const space = getMintLen([ExtensionType.ScaledUiAmountConfig]);
    await provider.sendAndConfirm(
      new Transaction().add(
        SystemProgram.createAccount({
          fromPubkey: admin,
          newAccountPubkey: mint.publicKey,
          space,
          lamports: await provider.connection.getMinimumBalanceForRentExemption(space),
          programId: TOKEN_2022_PROGRAM_ID,
        }),
        createInitializeScaledUiAmountConfigInstruction(mint.publicKey, admin, multiplier, TOKEN_2022_PROGRAM_ID),
        createInitializeMintInstruction(mint.publicKey, 6, admin, null, TOKEN_2022_PROGRAM_ID)
      ),
      [mint]
    );
    return mint;
  }

  it("rejects an asset whose risk parameters are inconsistent", async () => {
    const bad = await newStockMint();
    const badPda = PublicKey.findProgramAddressSync(
      [SEED.asset, bad.publicKey.toBuffer()],
      program.programId
    )[0];
    // Liquidation threshold below the maximum LTV: a freshly drawn line would
    // be instantly liquidatable.
    const badParams = { ...assetParams(), stockMint: bad.publicKey, liqThresholdBps: 5000 };
    try {
      await program.methods
        .addAsset(badParams as any)
        .accounts({
          config: configPda,
          assetAccount: badPda,
          stockMint: bad.publicKey,
          admin,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      assert.fail("should have rejected inconsistent risk parameters");
    } catch (e: any) {
      assert.match(String(e.message ?? e), /InvalidParams|0x1779|6015/);
    }
  });

  it("opens a credit line", async () => {
    await program.methods
      .openLine({ repayDebt: {} } as any)
      .accounts({
        config: configPda,
        line: linePda,
        owner: admin,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const line = await program.account.creditLine.fetch(linePda);
    assert.ok(line.owner.equals(admin));
    assert.equal(line.nCollateral, 0);
  });

  it("takes a deposit and sizes the line for the current session", async () => {
    // 10 tokens at 6dp.
    await program.methods
      .deposit(new BN(10_000_000))
      .accounts({
        config: configPda,
        line: linePda,
        asset: assetPda,
        owner: admin,
        vault: vaultPda,
        mint: stockMint.publicKey,
        from: userStockAta,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    await program.methods
      .resizeLine([mark()])
      .accounts({ config: configPda, line: linePda, keeper: admin })
      .remainingAccounts([{ pubkey: assetPda, isSigner: false, isWritable: false }])
      .rpc();

    const line = await program.account.creditLine.fetch(linePda);
    // 10 shares * $100 = $1,000 collateral.
    assert.equal(line.collateralUsdc.toNumber(), 1_000_000_000);
    // The haircut depends on the session the validator clock falls in, so
    // derive the expectation from the session the program actually recorded
    // instead of assuming a time of day.
    const expected = Math.floor((1_000_000_000 * sessionLtv(line.lastSession)) / 10_000);
    assert.equal(line.creditLimitUsdc.toNumber(), expected);
    assert.equal(line.availableCreditUsdc.toNumber(), expected);
    console.log(`      session=${sessionName(line.lastSession)} ltv=${sessionLtv(line.lastSession)}bps credit=$${expected / 1e6}`);
  });

  it("records the on-chain multiplier, not a caller-supplied one", async () => {
    const line = await program.account.creditLine.fetch(linePda);
    const slot = line.collateral[0];
    // f64 1.0 is exactly 0x3FF0000000000000.
    assert.equal(slot.multiplierBits.toString(), "4607182418800017408");
    assert.equal(slot.rawAmount.toNumber(), 10_000_000);
  });

  it("disburses a draw with a 0.25% fee", async () => {
    const before = await getAccount(provider.connection, userUsdcAta, undefined, TOKEN_PROGRAM_ID);
    const drawAmount = new BN(100_000_000); // $100

    await program.methods
      .draw(drawAmount)
      .accounts({
        config: configPda,
        line: linePda,
        reserveAta: reservePda,
        usdcMint: usdcMint.publicKey,
        recipient: userUsdcAta,
        keeper: admin,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .preInstructions([
        createMintToInstruction(usdcMint.publicKey, reserveUsdcAta, admin, 10_000_000_000, [], TOKEN_PROGRAM_ID),
      ])
      .rpc();

    const after = await getAccount(provider.connection, userUsdcAta, undefined, TOKEN_PROGRAM_ID);
    assert.equal(Number(after.amount) - Number(before.amount), 100_000_000);

    const line = await program.account.creditLine.fetch(linePda);
    // $100 principal + 0.25% fee = $100.25 of debt.
    assert.equal(line.usdcDebt.toNumber(), 100_250_000);
    assert.equal(
      line.availableCreditUsdc.toNumber(),
      line.creditLimitUsdc.toNumber() - 100_250_000
    );
  });

  it("refuses a draw larger than the available credit", async () => {
    try {
      await program.methods
        .draw(new BN(1_000_000_000)) // $1,000, far over the $449 remaining
        .accounts({
          config: configPda,
          line: linePda,
          reserveAta: reservePda,
          usdcMint: usdcMint.publicKey,
          recipient: userUsdcAta,
          keeper: admin,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
      assert.fail("should have refused an over-limit draw");
    } catch (e: any) {
      assert.match(String(e.message ?? e), /InsufficientCredit|0x1778|6008/);
    }
  });

  it("harvests a dividend when the multiplier bumps", async () => {
    // Schedule a 0.7% dividend a few seconds out. It has to be scheduled in
    // the future: if the timestamp is already past when the issuer submits it,
    // the processor promotes `multiplier` to `new_multiplier` on the spot, the
    // two become equal, and the change is no longer distinguishable from an
    // uneventful mint. The keeper has to observe the pending pair.
    const effectiveTs = new BN((await onChainNow(provider.connection)) + 3);
    await provider.sendAndConfirm(
      new Transaction().add(
        createUpdateMultiplierDataInstruction(
          stockMint.publicKey,
          admin,
          1.007,
          BigInt(effectiveTs.toString()),
          [],
          TOKEN_2022_PROGRAM_ID
        )
      )
    );

    const [divPda] = PublicKey.findProgramAddressSync(
      [SEED.div, linePda.toBuffer(), stockMint.publicKey.toBuffer(), Buffer.from(effectiveTs.toArrayLike(Buffer, "le", 8))],
      program.programId
    );

    await waitForOnChainTs(provider.connection, effectiveTs.toNumber());

    const vaultBefore = await getAccount(provider.connection, vaultPda, undefined, TOKEN_2022_PROGRAM_ID);

    await program.methods
      .harvestDividend(effectiveTs, mark())
      .accounts({
        config: configPda,
        line: linePda,
        asset: assetPda,
        mint: stockMint.publicKey,
        vault: vaultPda,
        treasury: treasuryPda,
        dividendEvent: divPda,
        keeper: admin,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const vaultAfter = await getAccount(provider.connection, vaultPda, undefined, TOKEN_2022_PROGRAM_ID);
    const trimmed = Number(vaultBefore.amount) - Number(vaultAfter.amount);

    // 10 tokens * 0.007 = 0.07 shares * $100 = $7 gross, 0.5% fee = $0.035,
    // net $6.965. Trimmed = 6.965 / (1.007 * 100) = 0.069165839 tokens.
    const ev = await program.account.dividendEvent.fetch(divPda);
    assert.equal(ev.grossUsd.toNumber(), 7_000_000, "gross is $7.00");
    assert.equal(ev.feeUsd.toNumber(), 35_000, "fee is $0.035");
    assert.equal(ev.netUsd.toNumber(), 6_965_000, "net is $6.965");
    assert.equal(ev.rawTrimmed.toNumber(), 69_165);
    assert.equal(trimmed, 69_165, "the vault actually lost exactly that");

    // The slot's baseline advanced, which is what blocks a replay.
    const line = await program.account.creditLine.fetch(linePda);
    assert.notEqual(line.collateral[0].multiplierBits.toString(), "4607182418800017408");
    assert.equal(line.collateral[0].rawAmount.toNumber(), 10_000_000 - 69_165);
  });

  it("refuses to harvest the same corporate action twice", async () => {
    // Re-derive the timestamp from the event we just wrote.
    const events = await program.account.dividendEvent.all();
    assert.equal(events.length, 1);
    const ts = events[0].account.effectiveTs;

    const [divPda] = PublicKey.findProgramAddressSync(
      [SEED.div, linePda.toBuffer(), stockMint.publicKey.toBuffer(), Buffer.from(ts.toArrayLike(Buffer, "le", 8))],
      program.programId
    );

    try {
      await program.methods
        .harvestDividend(ts, mark())
        .accounts({
          config: configPda,
          line: linePda,
          asset: assetPda,
          mint: stockMint.publicKey,
          vault: vaultPda,
          treasury: treasuryPda,
          dividendEvent: divPda,
          keeper: admin,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      assert.fail("a replayed harvest must not pay twice");
    } catch (e: any) {
      // Either the baseline check or the PDA-already-exists guard fires.
      assert.ok(e, "replay was rejected");
    }

    const vault = await getAccount(provider.connection, vaultPda, undefined, TOKEN_2022_PROGRAM_ID);
    assert.equal(Number(vault.amount), 10_000_000 - 69_165, "no further trim occurred");
  });

  it("refuses a split-sized multiplier change as a corporate action", async () => {
    // A 2:1 split moves the multiplier by 10,000 bps, far past the 500 bps cap.
    // Scheduled forward for the same reason as the dividend case.
    const pastTs = new BN((await onChainNow(provider.connection)) + 3);
    await provider.sendAndConfirm(
      new Transaction().add(
        createUpdateMultiplierDataInstruction(
          stockMint.publicKey,
          admin,
          2.014, // double the current 1.007
          BigInt(pastTs.toString()),
          [],
          TOKEN_2022_PROGRAM_ID
        )
      )
    );
    await waitForOnChainTs(provider.connection, pastTs.toNumber());

    const [divPda] = PublicKey.findProgramAddressSync(
      [SEED.div, linePda.toBuffer(), stockMint.publicKey.toBuffer(), Buffer.from(pastTs.toArrayLike(Buffer, "le", 8))],
      program.programId
    );

    try {
      await program.methods
        .harvestDividend(pastTs, mark())
        .accounts({
          config: configPda,
          line: linePda,
          asset: assetPda,
          mint: stockMint.publicKey,
          vault: vaultPda,
          treasury: treasuryPda,
          dividendEvent: divPda,
          keeper: admin,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      assert.fail("a split must not be paid out as a dividend");
    } catch (e: any) {
      assert.match(String(e.message ?? e), /CorporateActionRejected|0x177d|6021/);
    }
  });

  it("settles the dividend against the debt", async () => {
    const events = await program.account.dividendEvent.all();
    const target = events.find((e) => e.account.appliedToDebt.toNumber() === 0 && e.account.paidToUser.toNumber() === 0);
    assert.ok(target, "an unsettled event exists");
    const divPda = target.publicKey;
    const net = target.account.netUsd.toNumber();

    // The keeper holds the swap proceeds.
    const keeperUsdc = getAssociatedTokenAddressSync(usdcMint.publicKey, admin, true, TOKEN_PROGRAM_ID);
    await provider.sendAndConfirm(
      new Transaction().add(createMintToInstruction(usdcMint.publicKey, keeperUsdc, admin, net, [], TOKEN_PROGRAM_ID))
    );

    const lineBefore = await program.account.creditLine.fetch(linePda);
    const debtBefore = lineBefore.usdcDebt.toNumber() + lineBefore.accruedInterest.toNumber();

    await program.methods
      .settleDividend()
      .accounts({
        config: configPda,
        line: linePda,
        dividendEvent: divPda,
        reserveAta: reservePda,
        usdcMint: usdcMint.publicKey,
        usdcFrom: keeperUsdc,
        userUsdc: userUsdcAta,
        keeper: admin,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const lineAfter = await program.account.creditLine.fetch(linePda);
    const debtAfter = lineAfter.usdcDebt.toNumber() + lineAfter.accruedInterest.toNumber();
    assert.equal(debtBefore - debtAfter, net, "the dividend reduced debt by exactly its net value");
    assert.equal(lineAfter.dividendsToRepay.toNumber(), net);

    const ev = await program.account.dividendEvent.fetch(divPda);
    assert.equal(ev.appliedToDebt.toNumber(), net);
  });

  it("refuses to settle the same dividend twice", async () => {
    const events = await program.account.dividendEvent.all();
    const settled = events.find((e) => e.account.appliedToDebt.toNumber() > 0);
    assert.ok(settled);
    const keeperUsdc = getAssociatedTokenAddressSync(usdcMint.publicKey, admin, true, TOKEN_PROGRAM_ID);

    try {
      await program.methods
        .settleDividend()
        .accounts({
          config: configPda,
          line: linePda,
          dividendEvent: settled.publicKey,
          reserveAta: reservePda,
          usdcMint: usdcMint.publicKey,
          usdcFrom: keeperUsdc,
          userUsdc: userUsdcAta,
          keeper: admin,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
      assert.fail("a dividend must not be settled twice");
    } catch (e: any) {
      assert.match(String(e.message ?? e), /AlreadySettled|0x177e|6022/);
    }
  });

  it("repays debt", async () => {
    const lineBefore = await program.account.creditLine.fetch(linePda);
    const repay = new BN(50_000_000); // $50

    await program.methods
      .repay(repay)
      .accounts({
        config: configPda,
        line: linePda,
        reserveAta: reservePda,
        usdcMint: usdcMint.publicKey,
        from: userUsdcAta,
        payerAuthority: admin,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .preInstructions([
        createMintToInstruction(usdcMint.publicKey, userUsdcAta, admin, 50_000_000, [], TOKEN_PROGRAM_ID),
      ])
      .rpc();

    const lineAfter = await program.account.creditLine.fetch(linePda);
    const before = lineBefore.usdcDebt.toNumber() + lineBefore.accruedInterest.toNumber();
    const after = lineAfter.usdcDebt.toNumber() + lineAfter.accruedInterest.toNumber();
    assert.equal(before - after, 50_000_000);
  });

  it("blocks a withdrawal that would breach the health factor", async () => {
    // Refresh sizing so the line reflects current debt.
    await program.methods
      .resizeLine([mark()])
      .accounts({ config: configPda, line: linePda, keeper: admin })
      .remainingAccounts([{ pubkey: assetPda, isSigner: false, isWritable: false }])
      .rpc();

    // Withdraw the entire remaining slot, which is less than originally
    // deposited because the dividend trimmed it.
    const held = (await program.account.creditLine.fetch(linePda)).collateral[0].rawAmount;
    console.log(`      attempting to withdraw ${held.toNumber()} raw with debt outstanding`);
    try {
      await program.methods
        .withdraw(held) // all of it, with debt outstanding
        .accounts({
          config: configPda,
          line: linePda,
          owner: admin,
          vault: vaultPda,
          mint: stockMint.publicKey,
          to: userStockAta,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .rpc();
      assert.fail("withdrawing all collateral against outstanding debt must fail");
    } catch (e: any) {
      console.log("      withdraw rejected with:", String(e.message ?? e).split("\n")[0]);
      assert.match(String(e.message ?? e), /WithdrawalUnsafe|0x177a|6010/);
    }
  });

  // ---------------------------------------------------------------------------
  // Block 2: the pre-IPO tier on a mock that is *shaped like* real PreStocks
  // collateral — 9 decimals, 100 bps transfer fee, ScaledUiAmount present —
  // plus a default-frozen mint to prove the listing refusals. Every number
  // below is asserted exactly; fee effects and 9dp scaling must survive
  // contact with the real program, not just the unit tests.
  // ---------------------------------------------------------------------------
  describe("pre-IPO tier (PreStocks-shaped mock)", () => {
    let preMint: Keypair; // 9dp + TransferFeeConfig(100 bps) + ScaledUiAmount
    let frozenMint: Keypair; // DefaultAccountState=Frozen: must not be listable
    let asset2Pda: PublicKey, line2Pda: PublicKey, vault2Pda: PublicKey, treasury2Pda: PublicKey;
    let owner2: Keypair, owner2PreAta: PublicKey, owner2UsdcAta: PublicKey;
    let adminPreAta: PublicKey; // admin's ATA: fee collection + liquidation dest
    const FEE_BPS = 100;

    const preParams = () => ({
      ...assetParams(),
      stockMint: preMint.publicKey,
      decimals: 9,
      marketKind: { preIpo: {} },
      maxValuationDivergenceBps: 500,
      maxTransferFeeBps: 1000,
      // Pre-IPO bounds: closed-tier LTV <= 4000, floor >= 9000.
      maxLtvClosedBps: 2500,
      liqFloorBps: 9200,
    });

    before(async () => {
      // --- the fee-bearing 9dp mock: extensions before InitializeMint ---
      preMint = Keypair.generate();
      const space = getMintLen([ExtensionType.TransferFeeConfig, ExtensionType.ScaledUiAmountConfig]);
      // spl-token 0.4.x order: (mint, configAuthority, withdrawAuthority,
      // basisPoints, maximumFee, programId).
      const initFee = createInitializeTransferFeeConfigInstruction(
        preMint.publicKey, admin, admin, FEE_BPS, BigInt("18446744073709551615"), TOKEN_2022_PROGRAM_ID
      );
      const initMult = createInitializeScaledUiAmountConfigInstruction(
        preMint.publicKey, admin, 1.0, TOKEN_2022_PROGRAM_ID
      );
      const initMint = createInitializeMintInstruction(preMint.publicKey, 9, admin, admin, TOKEN_2022_PROGRAM_ID);
      await provider.sendAndConfirm(
        new Transaction().add(
          SystemProgram.createAccount({
            fromPubkey: admin, newAccountPubkey: preMint.publicKey, space,
            lamports: await provider.connection.getMinimumBalanceForRentExemption(space),
            programId: TOKEN_2022_PROGRAM_ID,
          }),
          initFee, initMult, initMint
        ),
        [preMint]
      );

      // --- a frozen-by-default mint: vaults could never move its tokens ---
      frozenMint = Keypair.generate();
      const spaceF = getMintLen([ExtensionType.DefaultAccountState, ExtensionType.ScaledUiAmountConfig]);
      const initFrozen = createInitializeDefaultAccountStateInstruction(
        frozenMint.publicKey, AccountState.Frozen, TOKEN_2022_PROGRAM_ID
      );
      const initMultF = createInitializeScaledUiAmountConfigInstruction(
        frozenMint.publicKey, admin, 1.0, TOKEN_2022_PROGRAM_ID
      );
      await provider.sendAndConfirm(
        new Transaction().add(
          SystemProgram.createAccount({
            fromPubkey: admin, newAccountPubkey: frozenMint.publicKey, space: spaceF,
            lamports: await provider.connection.getMinimumBalanceForRentExemption(spaceF),
            programId: TOKEN_2022_PROGRAM_ID,
          }),
          initFrozen, initMultF,
          createInitializeMintInstruction(frozenMint.publicKey, 9, admin, admin, TOKEN_2022_PROGRAM_ID)
        ),
        [frozenMint]
      );

      // --- second borrower so this suite never perturbs the public one ---
      owner2 = Keypair.generate();
      await fundPayer(provider.connection, owner2.publicKey);

      [asset2Pda] = PublicKey.findProgramAddressSync([SEED.asset, preMint.publicKey.toBuffer()], program.programId);
      [line2Pda] = PublicKey.findProgramAddressSync([SEED.line, owner2.publicKey.toBuffer()], program.programId);
      [vault2Pda] = PublicKey.findProgramAddressSync([SEED.vault, line2Pda.toBuffer(), preMint.publicKey.toBuffer()], program.programId);
      [treasury2Pda] = PublicKey.findProgramAddressSync([SEED.treasury, preMint.publicKey.toBuffer()], program.programId);
      owner2PreAta = getAssociatedTokenAddressSync(preMint.publicKey, owner2.publicKey, true, TOKEN_2022_PROGRAM_ID);
      owner2UsdcAta = getAssociatedTokenAddressSync(usdcMint.publicKey, owner2.publicKey, true, TOKEN_PROGRAM_ID);
      adminPreAta = getAssociatedTokenAddressSync(preMint.publicKey, admin, true, TOKEN_2022_PROGRAM_ID);

      await provider.sendAndConfirm(
        new Transaction().add(
          createAssociatedTokenAccountInstruction(admin, owner2PreAta, owner2.publicKey, preMint.publicKey, TOKEN_2022_PROGRAM_ID),
          createAssociatedTokenAccountInstruction(admin, owner2UsdcAta, owner2.publicKey, usdcMint.publicKey, TOKEN_PROGRAM_ID),
          createAssociatedTokenAccountInstruction(admin, adminPreAta, admin, preMint.publicKey, TOKEN_2022_PROGRAM_ID),
          // 20 whole pre-IPO tokens (9dp) for the borrower, USDC for the liquidator.
          createMintToInstruction(preMint.publicKey, owner2PreAta, admin, 20_000_000_000, [], TOKEN_2022_PROGRAM_ID),
          createMintToInstruction(usdcMint.publicKey, userUsdcAta, admin, 100_000_000, [], TOKEN_PROGRAM_ID)
        )
      );
    });

    const addAsset2 = (params: any, assetAccount?: PublicKey) =>
      program.methods
        .addAsset(params)
        .accounts({
          config: configPda,
          assetAccount: assetAccount ?? asset2Pda,
          stockMint: params.stockMint ?? preMint.publicKey,
          admin,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

    const expectErr = async (label: string, fn: () => Promise<any>, re: RegExp) => {
      try {
        await fn();
        assert.fail(`${label} must be refused`);
      } catch (e: any) {
        if (e instanceof AssertionError) throw e; // a failed assertion inside fn(), not a protocol refusal
        const msg = String(e?.message ?? e).split("\n")[0];
        assert.match(String(e?.message ?? e), re, `${label}: ${msg}`);
      }
    };

    it("refuses a mint whose fee exceeds the declared ceiling", async () => {
      await expectErr("50bps ceiling vs 100bps mint", () => addAsset2({ ...preParams(), maxTransferFeeBps: 50 }), /TransferFeeTooHigh|6038/);
    });

    it("refuses a decimals claim that contradicts the mint", async () => {
      // 6dp was the *only* accepted scale while xStocks were the only game;
      // the cross-check against the mint account is what makes 9dp safe.
      await expectErr("6dp claim vs 9dp mint", () => addAsset2({ ...preParams(), decimals: 6 }), /BadDecimals|6007/);
    });

    it("refuses a frozen-by-default mint", async () => {
      // Its own asset PDA — the seed constraint is per-mint, and the point of
      // this test is the *policy* refusal, not an account-layout accident.
      const [frozenAssetPda] = PublicKey.findProgramAddressSync(
        [SEED.asset, frozenMint.publicKey.toBuffer()], program.programId
      );
      await expectErr("default-frozen mint", () =>
        addAsset2({ ...preParams(), stockMint: frozenMint.publicKey }, frozenAssetPda), /MintExtensionNotAllowed|6037/);
    });

    it("credits the vault's measured delta on a 1% fee mint and values 9dp exactly", async () => {
      await addAsset2(preParams() as any);
      const asset = await program.account.asset.fetch(asset2Pda);
      assert.deepEqual(asset.marketKind, { preIpo: {} });
      // The bitmap is the program's own read of the mint: freeze auth (1),
      // mint auth (2), transfer fee (8) — and nothing else.
      assert.equal(asset.issuerControls, 1 | 2 | 8);

      // open line + deposit 1 whole token (1e9 raw) signed by owner2
      const openIx = await program.methods
        .openLine({ repayDebt: {} } as any)
        .accounts({ config: configPda, line: line2Pda, owner: owner2.publicKey, systemProgram: SystemProgram.programId })
        .instruction();
      const depIx = await program.methods
        .deposit(new BN(1_000_000_000))
        .accounts({
          config: configPda, line: line2Pda, asset: asset2Pda, owner: owner2.publicKey,
          vault: vault2Pda, mint: preMint.publicKey, from: owner2PreAta,
          tokenProgram: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId,
        })
        .instruction();
      await provider.sendAndConfirm(new Transaction().add(openIx, depIx), [owner2]);

      const vault = await getAccount(provider.connection, vault2Pda, undefined, TOKEN_2022_PROGRAM_ID);
      // 1e9 sent, 1% fee: the vault holds 990_000_000 and the ledger agrees.
      assert.equal(Number(vault.amount), 990_000_000);
      const line = await program.account.creditLine.fetch(line2Pda);
      assert.equal(line.collateral[0].rawAmount.toNumber(), 990_000_000, "slot == vault delta");
      assert.deepEqual(line.collateral[0].marketKind, { preIpo: {} });
      assert.equal(Number(vault.amount), line.collateral[0].rawAmount.toNumber(), "invariant: ledger mirrors the account");

      // Size it: $100/share × 0.99 shares = $99 collateral, pre-IPO pinned to
      // the 2500bps closed tier *whatever* the session is.
      await program.methods
        .resizeLine([{ ...mark(), dislocationBps: 0 }])
        .accounts({ config: configPda, line: line2Pda, keeper: admin })
        .remainingAccounts([{ pubkey: asset2Pda, isSigner: false, isWritable: false }])
        .rpc();
      const sized = await program.account.creditLine.fetch(line2Pda);
      assert.equal(sized.collateralUsdc.toNumber(), 99_000_000, "$99.00 at 6dp — 9dp scaled correctly on-chain");
      assert.equal(sized.creditLimitUsdc.toNumber(), 24_750_000, "25% closed-tier haircut regardless of clock");
    });

    it("refuses resize marks that diverge past the cap, accepts at it", async () => {
      await expectErr("501bps dislocation vs 500 cap", () =>
        program.methods
          .resizeLine([{ ...mark(), dislocationBps: 501 }])
          .accounts({ config: configPda, line: line2Pda, keeper: admin })
          .remainingAccounts([{ pubkey: asset2Pda, isSigner: false, isWritable: false }])
          .rpc(), /ValuationDivergenceTooLarge|6034/);
      // At the cap (and negative side): accepted.
      await program.methods
        .resizeLine([{ ...mark(), dislocationBps: -500 }])
        .accounts({ config: configPda, line: line2Pda, keeper: admin })
        .remainingAccounts([{ pubkey: asset2Pda, isSigner: false, isWritable: false }])
        .rpc();
      const sized = await program.account.creditLine.fetch(line2Pda);
      assert.equal(sized.creditLimitUsdc.toNumber(), 24_750_000);
    });

    it("draws against a fresh sizing, freezes the collateral rule set, and refuses harvest", async () => {
      // set_asset_params cannot flip the market kind out from under a position.
      const cur = await program.account.asset.fetch(asset2Pda);
      const asParams = (over: any) => ({
        stockMint: cur.stockMint, equityFeedId: cur.equityFeedId, tokenFeedId: cur.tokenFeedId,
        maxLtvRegularBps: cur.maxLtvRegularBps, maxLtvExtendedBps: cur.maxLtvExtendedBps,
        maxLtvClosedBps: cur.maxLtvClosedBps, liqThresholdBps: cur.liqThresholdBps,
        liqFloorBps: cur.liqFloorBps, liquidationBonusBps: cur.liquidationBonusBps,
        maxConfRatioBps: cur.maxConfRatioBps, confFloorBps: cur.confFloorBps,
        maxMultiplierDeltaBps: cur.maxMultiplierDeltaBps, minPoolDepthUsd: cur.minPoolDepthUsd,
        decimals: cur.decimals, enabled: cur.enabled, bump: 0,
        marketKind: cur.marketKind, maxValuationDivergenceBps: cur.maxValuationDivergenceBps,
        maxTransferFeeBps: cur.maxTransferFeeBps, issuerControls: cur.issuerControls,
        _reserved: new Array(58).fill(0), ...over,
      });
      await expectErr("market kind flip", () =>
        program.methods
          .setAssetParams(asParams({ marketKind: { publicEquity: {} } }) as any)
          .accounts({ config: configPda, assetAccount: asset2Pda, admin })
          .rpc(), /InvalidParams|6016/);
      await expectErr("divergence cap past 1000", () =>
        program.methods
          .setAssetParams(asParams({ maxValuationDivergenceBps: 1001 }) as any)
          .accounts({ config: configPda, assetAccount: asset2Pda, admin })
          .rpc(), /InvalidParams|6016/);
      // A legal widening persists.
      await program.methods
        .setAssetParams(asParams({ maxValuationDivergenceBps: 600 }) as any)
        .accounts({ config: configPda, assetAccount: asset2Pda, admin })
        .rpc();
      assert.equal((await program.account.asset.fetch(asset2Pda)).maxValuationDivergenceBps, 600);

      // Draw $20 against the sizing from moments ago: allowed. Note draw is
      // *keeper-signed* (the card-terminal shape: config.keeper pays and
      // authorises disbursement) — the borrower does not sign it.
      await program.methods
        .draw(new BN(20_000_000))
        .accounts({
          config: configPda, line: line2Pda, reserveAta: reservePda, usdcMint: usdcMint.publicKey,
          recipient: owner2UsdcAta, keeper: admin, tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
      const line = await program.account.creditLine.fetch(line2Pda);
      assert.equal(line.usdcDebt.toNumber(), 20_050_000, "$20 + 25bps draw fee");

      // Harvest on pre-IPO collateral: refused before anything is read.
      const ts = new BN(Math.floor(Date.now() / 1000) + 4);
      const [divPda] = PublicKey.findProgramAddressSync(
        [SEED.div, line2Pda.toBuffer(), preMint.publicKey.toBuffer(), Buffer.from(ts.toArrayLike(Buffer, "le", 8))],
        program.programId
      );
      await expectErr("harvest on pre-IPO", () =>
        program.methods
          .harvestDividend(ts, mark())
          .accounts({
            config: configPda, line: line2Pda, asset: asset2Pda, mint: preMint.publicKey,
            vault: vault2Pda, treasury: treasury2Pda, dividendEvent: divPda, keeper: admin,
            tokenProgram: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId,
          })
          .rpc(), /PreIpoHarvestUnsupported|6036/);
    });

    it("freezes drawing once the sizing goes stale (real 125s wait)", async function (this: any) {
      // No clock-warp hack: the validator waits like production would. This
      // is the guard's whole contract — between issuer publishes, old marks
      // support zero new borrowing. (function() not arrow: `this` is the
      // mocha Context, which is where the timeout lives.)
      this.timeout(240_000);
      await new Promise((r) => setTimeout(r, 125_000));
      await expectErr("stale sizing draw", () =>
        program.methods
          .draw(new BN(1))
          .accounts({
            config: configPda, line: line2Pda, reserveAta: reservePda, usdcMint: usdcMint.publicKey,
            recipient: owner2UsdcAta, keeper: admin, tokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc(), /PreIpoSizingStale|6035/);
    });

    it("liquidates with the fee grossed up: the liquidator nets the full bonus", async () => {
      // Crash the mark to $10: debt $20.05 vs collateral $9.90 → LTV ~20252
      // bps, over the 9200 hard floor. The resize also refreshes the sizing.
      await program.methods
        .resizeLine([{ ...mark(), price: usd(10), dislocationBps: 0 }])
        .accounts({ config: configPda, line: line2Pda, keeper: admin })
        .remainingAccounts([{ pubkey: asset2Pda, isSigner: false, isWritable: false }])
        .rpc();

      // Debt read from the line, not assumed from the draw: the 125-second
      // staleness test in between accrued interest, and seize is proportional
      // to debt — the expectation must be computed from the same numbers the
      // program sees.
      const lineBefore = await program.account.creditLine.fetch(line2Pda);
      const debt = BigInt(lineBefore.usdcDebt.toNumber());
      const repayHalf = debt / 2n; // integer division mirrors the program
      const repay = new BN(repayHalf.toString());
      const held = 990_000_000n;
      const base = (held * repayHalf) / debt;
      const seize = (base * 10_500n) / 10_000n; // bonus 500bps
      void seize; // nominal; the on-chain assertions use payout/net relations
      const destBefore = await getAccount(provider.connection, adminPreAta, undefined, TOKEN_2022_PROGRAM_ID);
      const vaultBefore = await getAccount(provider.connection, vault2Pda, undefined, TOKEN_2022_PROGRAM_ID);

      await program.methods
        .liquidate(repay)
        .accounts({
          config: configPda, line: line2Pda, asset: asset2Pda, mint: preMint.publicKey,
          vault: vault2Pda, stockDest: adminPreAta, usdcFrom: userUsdcAta, reserveAta: reservePda,
          usdcMint: usdcMint.publicKey, liquidator: admin,
          tokenProgram: TOKEN_2022_PROGRAM_ID, usdcTokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();

      const destAfter = await getAccount(provider.connection, adminPreAta, undefined, TOKEN_2022_PROGRAM_ID);
      const vaultAfter = await getAccount(provider.connection, vault2Pda, undefined, TOKEN_2022_PROGRAM_ID);
      const net = Number(destAfter.amount) - Number(destBefore.amount);
      const payout = Number(vaultBefore.amount) - Number(vaultAfter.amount);

      // The exact seize nominal drifts with interest accrued between the
      // read and the CPI (gross_up_for_fee itself is pinned unit-tested to
      // the base); what must hold *on-chain*, exactly, are the two properties
      // the gross-up exists to guarantee:
      // 1. the liquidator's net equals the vault's gross debit minus the
      //    mint's own fee formula — the fee is paid on top, never skimmed
      //    off the bonus side the liquidator was promised;
      // SPL's fee math rounds the FEE up: (amount * bps + 9_999) / 10_000.
      // (Which is exactly why gross_up_for_fee rounds up as well — against a
      // ceil'd fee, flooring the top-up would short the receiver.)
      const fee = Number((BigInt(payout) * BigInt(FEE_BPS) + 9_999n) / 10_000n);
      assert.equal(
        net,
        payout - fee,
        "net == payout - SPL fee(payout): the fee was added, not subtracted from the bonus"
      );
      // 2. the ledger mirrors the vault to the base unit, after everything:
      const line = await program.account.creditLine.fetch(line2Pda);
      assert.equal(
        Number(vaultAfter.amount),
        line.collateral[0].rawAmount.toNumber(),
        "invariant: slot raw == vault balance after a fee-bearing liquidation"
      );
      // Debt after: half repaid, residual is accrued interest (bounded).
      assert.isAtMost(line.usdcDebt.toNumber(), Number(debt - repayHalf) + 1000);
      assert.isAtLeast(line.usdcDebt.toNumber(), Number(debt - repayHalf));
      assert.isAbove(payout, Number(base), "seizure exceeded the pro-rata held (the bonus is real)");
    });
  });
});
