# Floe Protocol

**Spend your tokenized stocks without selling them.** Floe is onchain credit backed by tokenized equities (for example SPYx and QQQx) and pre-IPO collateral. Lines are sized using session-aware loan-to-value rules; dividends detected via Token-2022 `ScaledUiAmount` multiplier bumps can repay debt automatically.

- **Website:** [floeprotocol.com](https://floeprotocol.com) (when live)
- **GitHub:** [Houss-Dev/Floe-Protocol](https://github.com/Houss-Dev/Floe-Protocol)
- **X:** [@Floeprotocol](https://x.com/Floeprotocol)

The deployed Anchor program and TypeScript client still use the internal name **`ledgerline`** until a redeploy under a new program id.

---

## What Floe does

1. **Collateral** — Users deposit Token-2022 mints that carry a `ScaledUiAmount` extension (tokenized stocks and pre-IPO marks).
2. **Credit line** — The program opens a per-user line, tracks collateral slots, debt in USDC, and health.
3. **Sizing** — Loan-to-value depends on asset tier and NYSE session (regular, extended, overnight, closed). Pre-IPO collateral uses stricter fixed haircuts, a short draw-freshness window, and issuer mark divergence limits.
4. **Draw & repay** — Borrow USDC against collateral; repay to restore health. Draws for merchant flows are keeper-signed in v1.
5. **Dividends** — When a stock dividend lands as a multiplier bump on the mint, `harvest_dividend` computes the economic trim, records an idempotent `DividendEvent`, and `settle_dividend` applies proceeds to debt (or payout mode).
6. **Liquidation** — Permissionless liquidators can repay debt and receive collateral at a bonus when health falls below protocol thresholds.

All monetary math uses fixed-point integers (no `f64` in the program).

---

## Architecture

| Layer | Location | Role |
|--------|-----------|------|
| On-chain program | `programs/ledgerline/` | Config, assets, lines, vault, reserve, dividend events |
| IDL | `idl/ledgerline.json`, `app/public/idl/` | Anchor interface |
| TypeScript client | `clients/ts/ledgerline/` | Codama-generated instructions and accounts |
| Web app | `app/` | Next.js UI (marketing + dashboard + devnet sandbox) |
| Keeper | `keeper/` | Marks, resize, draw API, demo state publisher (v1) |
| Integration tests | `tests/` | Validator-backed flows |

---

## Collateral tiers

**Public equities** — Session-aware LTV using configured tiers; suited to liquid tokenized ETFs and listed xStocks-style mints.

**Pre-IPO** — `MarketKind::PreIpo`: conservative LTV, 120s sizing freshness for draws, issuer divergence cap, no dividend harvest until IPO, deferred liquidation between soft and hard floors when there is no on-chain book.

---

## Dividend engine (core idea)

A dividend on a tokenized stock often **does not change raw token balances**. The issuer updates the **`ScaledUiAmount` multiplier** on the mint. Floe reads that multiplier on-chain (never from an untrusted caller), verifies schedule and corporate-action bounds, and treats the bump as economic value that can be trimmed from collateral, swapped to USDC, and applied to debt.

---

## Quick start (web app)

```bash
cd app
cp .env.example .env.local
# Set NEXT_PUBLIC_PROGRAM_ID and NEXT_PUBLIC_RPC_URL (devnet or local)
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). For devnet sandbox instructions see [docs/DEVNET.md](docs/DEVNET.md).

---

## Build on-chain program

```bash
anchor build
cargo test -p ledgerline --lib
```

Integration tests (local validator):

```bash
bash scripts/run-tests.sh
```

---

## Keeper (optional, devnet / demo)

```bash
cd keeper
cp .env.example .env
npm install
npm start
```

See [keeper/KEEPER.md](keeper/KEEPER.md).

---

## License

MIT
