# Floe Protocol

**Spend your tokenized stocks without selling them.** Floe is onchain credit backed by tokenized equities (for example SPYx and QQQx) and pre-IPO collateral. Lines are sized using session-aware loan-to-value rules; dividends detected via Token-2022 `ScaledUiAmount` multiplier bumps can repay debt when the keeper runs harvest and settle.

- **Website:** [floeprotocol.com](https://floeprotocol.com)
- **GitHub:** [Houss-Dev/Floe-Protocol](https://github.com/Houss-Dev/Floe-Protocol)
- **X:** [@Floeprotocol](https://x.com/Floeprotocol)

The deployed Anchor program and TypeScript client still use the internal name **`ledgerline`**. Current devnet program id: `CK5xutaXUwmdcLR8qh7cCZMXJ5fkqopk1P5NZEM3cLrN` (see `programs/ledgerline/src/lib.rs`).

---

## What Floe does

1. **Listing** — Admin registers each collateral mint with `add_asset`. The program reads the mint account (extensions, decimals, issuer controls such as freeze/fee config); callers cannot lie about issuer power or omit required extensions.
2. **Collateral** — Users deposit Token-2022 mints with a `ScaledUiAmount` extension. Collateral credited is what the vault **actually receives** (transfer fees are measured on-chain, not trusted from config).
3. **Credit line** — Per-user line: collateral slots, USDC debt, accrued interest, health, and available credit. Debt accrues interest at the line’s APR (`base_apr_bps` set at config init).
4. **Sizing** — `resize_line` (keeper-signed) applies marks. LTV depends on asset tier and NYSE session (regular, extended, overnight, closed). Optional Pyth verification when `config.pyth_receiver` is set; devnet may use keeper marks (logged) when unset.
5. **Draw & repay** — Draws disburse USDC from the protocol reserve and charge a configurable draw fee (`fee_bps_draw`). **Draws are keeper-signed in v1** (card/terminal model). Repay restores health. Draw freshness: **120s** since last sizing if the line holds pre-IPO collateral; **300s** if it holds public-equity collateral.
6. **Dividends** — On a multiplier bump, `harvest_dividend` trims collateral and records an idempotent `DividendEvent`; `settle_dividend` routes USDC to debt or payout mode per the line’s setting. **Pre-IPO assets reject harvest until IPO.** The keeper drives harvest/settle off-chain; the program enforces idempotency and amounts.
7. **Liquidation** — Permissionless liquidators may repay debt and receive collateral at a bonus when LTV crosses the hard threshold. **Pre-IPO and closed-session public lines defer liquidation** between soft and hard floors when there is no on-chain book (`LiquidationDeferred`).

**Math:** lending and risk use fixed-point integers (`math::Fixed`). Token multipliers are stored on-chain as IEEE-754 bits and decoded to fixed point—there is no floating-point arithmetic in LTV, debt, or fee math.

**Safety:** admin can pause via operating state; draws and other user flows respect `require_normal()`.

---

## Architecture

| Layer | Location | Role |
|--------|-----------|------|
| On-chain program | `programs/ledgerline/` | Config, assets, lines, vault, reserve, dividend events |
| IDL | `idl/ledgerline.json`, `app/public/idl/` | Anchor interface |
| TypeScript client | `clients/ts/ledgerline/` | Codama-generated instructions and accounts |
| Web app | `app/` | Next.js UI (marketing + dashboard + devnet sandbox) |
| Keeper | `keeper/` | Marks, `resize_line`, draw API, dividend harvest/settle, demo state (v1) |
| Integration tests | `tests/` | Validator-backed flows |

---

## Collateral tiers

**Public equities** (`MarketKind::PublicEquity`) — Session-aware LTV (regular / extended+overnight / closed). Draws require sizing no older than **300 seconds**. Suited to liquid tokenized ETFs and xStocks-style mints with Pyth or keeper marks.

**Pre-IPO** (`MarketKind::PreIpo`) — LTV pinned to the **closed-tier** haircut regardless of clock session. Draws require sizing no older than **120 seconds**. Issuer mark **divergence cap** enforced at `resize_line` (`max_valuation_divergence_bps`). No dividend harvest until IPO. Liquidation deferred between soft and hard floors when there is no on-chain book.

---

## Dividend engine (core idea)

A dividend on a tokenized stock often **does not change raw token balances**. The issuer updates the **`ScaledUiAmount` multiplier** on the mint. Floe reads that multiplier from the mint account (never from an untrusted caller), verifies schedule and corporate-action bounds, and treats the bump as economic value.

**On-chain flow:** `harvest_dividend` → collateral trim + `DividendEvent` → `settle_dividend` applies USDC to debt or user payout. A configurable dividend fee (`fee_bps_dividend`) applies on settlement paths. Retries are safe: the same corporate action cannot create a second event.

---

## Devnet demo (what is real vs mock)

**Real:** the `ledgerline` program on Solana devnet, Token-2022 deposit/withdraw paths, line state, keeper-signed resize/draw, on-chain guards (pre-IPO staleness, divergence, harvest block).

**Synthetic / operator-run:** mock xStock and USDC mints, price marks when no Pyth receiver is configured, and reserve funding for demos. Label this in submissions—see [docs/DEVNET.md](docs/DEVNET.md).

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
npm start   # one resize/mark tick; see KEEPER.md for loop and demo config
```

See [keeper/KEEPER.md](keeper/KEEPER.md).

---

## License

MIT
