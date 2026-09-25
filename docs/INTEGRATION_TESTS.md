# Integration tests

`scripts/run-tests.sh` starts a throwaway `solana-test-validator`, loads the
built program, runs the suite and tears the validator down. Everything happens
inside one process because background jobs do not survive between invocations
in the sandbox this was developed in.

```bash
scripts/run-tests.sh                      # the main suite
scripts/run-tests.sh tests/diag-multiplier.ts   # raw-bytes diagnostics
```

**Result at the time of writing: 15 passing, 0 failing**, alongside 44 Rust
unit tests. The suite exercises the path the demo depends on: list an asset →
open a line → deposit xStocks → get sized for the current session → draw USDC →
a dividend lands as a multiplier bump → the engine trims the vault → the
proceeds retire debt.

## What the suite covers

| Test | Property it pins |
| --- | --- |
| `initialises config and the USDC reserve` | admin, fee and reserve wiring |
| `lists the mock xStock` | per-asset PDA and parameter persistence |
| `rejects an asset whose risk parameters are inconsistent` | `validate_asset` on-chain, not just in unit tests |
| `opens a credit line` | owner-bound PDA |
| `takes a deposit and sizes the line for the current session` | collateral valuation and the session haircut |
| `records the on-chain multiplier, not a caller-supplied one` | the deposit reads the mint, it does not trust an argument |
| `disburses a draw with a 0.25% fee` | USDC actually moves; debt includes the fee |
| `refuses a draw larger than the available credit` | limit enforcement |
| **`harvests a dividend when the multiplier bumps`** | $7.00 gross, $0.035 fee, $6.965 net, `raw_trim = 69165`, and the vault really loses exactly that |
| **`refuses to harvest the same corporate action twice`** | idempotency — the safety property the whole design rests on |
| `refuses a split-sized multiplier change as a corporate action` | a 2:1 split is rejected, not paid out as income |
| `settles the dividend against the debt` | debt falls by exactly the event's net value |
| `refuses to settle the same dividend twice` | single-use events |
| `repays debt` | interest-first repayment |
| `blocks a withdrawal that would breach the health factor` | collateral cannot be pulled out from under debt |

The two rows in bold are the ones that justify the project existing: the
dividend arithmetic matches the hand-computed reference scenario to the minor
unit, and a replayed harvest cannot pay twice.

## Findings that changed the design or the test harness

### 1. Agave 2.1.21 ships a Token-2022 that predates `ScaledUiAmount`

The bundled program rejects the extension's instruction with
`custom program error: 0xc` ("invalid instruction"). `scripts/fetch-token-2022.py`
pulls the live binary off devnet — it walks `Program` → `ProgramData`, strips
the 45-byte header, checks the ELF magic — and `run-tests.sh` loads it over the
same program id with `--bpf-program`. Without that there is no way to mint a
test asset that behaves like an xStock.

### 2. An already-effective multiplier update destroys the signal

This is the important one. `UpdateMultiplierData` with a timestamp **in the
past** does not leave a pending pair behind: the processor promotes
`multiplier` to `new_multiplier` on the spot. Verified on chain:

```
after init:   multiplier=1.0     new_eff_ts=0           new_multiplier=1.0
after update (ts in the past):
              multiplier=1.007   new_eff_ts=1789685620  new_multiplier=1.007
```

`action_is_live` requires `new != old`, so once the two collapse the bump is
indistinguishable from an uneventful mint and the dividend is invisible. The
program is right to refuse — paying out on `old == new` would mean inventing a
dividend that the chain never announced.

The consequence is a hard constraint on the keeper: **it has to observe the
pending pair before it becomes effective.** Kraken publishes multiplier updates
around 20:00 EST the day before the ex-date, so there is roughly a day of
warning in practice, but the keeper must poll on a schedule shorter than that
window and must not assume it can reconstruct a bump after the fact. Both
dividend tests schedule forward and wait, which is the realistic sequence.

### 3. The extension does not start at byte 82

For a mint carrying `ScaledUiAmount`, the account-type byte is at offset **165**,
not `Mint::LEN` (82); bytes 82–165 are zero padding. From there the extension
header is `type=25, len=56` and the body layout matches what the program
assumes:

```
body[0:32]   authority
body[32:40]  multiplier              f64 LE
body[40:48]  new_effective_timestamp i64 LE
body[48:56]  new_multiplier          f64 LE
```

`spl-token-2022` 8.0.1 parses this correctly, so `read_multiplier` is fine.
`@solana/spl-token` 0.4.15 does **not** — its `getExtensionData` returns
`undefined` for this account because it looks for the type byte at 82. Any
TypeScript that needs to read the multiplier off a real xStock mint has to
hand-parse or use a newer client; the tests only use the JS package to *write*
instructions, which works.

### 4. The validator clock decides the haircut

LTV is 55% in regular session, 45% extended and overnight, 30% closed. A test
that asserts `55%` is only correct four hours a day. The sizing test derives its
expectation from the session the program actually recorded (`lastSession`) and
prints which one it hit, so it is meaningful at any hour instead of passing by
accident.

## A bug the suite caught

`withdraw` returned `ZeroAmount` when the caller asked for more collateral than
the slot held — true but useless, and it conflated "you passed 0" with "you do
not have that much". It now returns a distinct `InsufficientCollateral`
(error **6010**), which is covered by the error-uniqueness test.

Note that Anchor assigns error codes by declaration order, so inserting the
variant shifted every later code up by one (`ZeroAmount` moved 6019 → 6020).
That is only safe because the program has not been deployed anywhere yet; after
a mainnet launch a new variant has to go at the end of the enum.
