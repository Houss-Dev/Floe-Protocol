# Floe keeper (v1 — API only)

One process, no database, no queue: it sizes lines and publishes state. That
is the whole job in v1, because the *program* holds every safety property —
the keeper can only make things fresher, never weaker (a refused or skipped
tick just lets the 120s pre-IPO window expire, which freezes draws).

## Run

```bash
cd keeper
npm run keeper:selftest
npx tsx src/cli.ts --config config.demo.json
npx tsx src/cli.ts --config config.demo.json --loop 20 30   # 20 ticks, 30s apart
npx tsx src/cli.ts --once                                     # env-based Hermes keeper
```

`config.demo.json` fields: `rpc`, `keypair` (the keeper signer — on mainnet
this is a hot key with *nothing but* resize authority; that is exactly what
the program allows it), `programId`, `stateFile`, `refreshSecs`, and per
asset: `mint`, `marketKind`, `sizing` and (for pre-IPO) `issuer` sources.

## Sources

| source | pricing | confidence | dislocation |
|---|---|---|---|
| `pyth` | Hermes `/v2/updates/price/latest` on the asset's two feed ids | the feed's own band | `token_feed / equity_feed − 1` |
| `prestocks` | `prestocks.com/api/prestocks` `markPrice` (offline fallback: the committed snapshot in `docs/data/prestocks.json`, sha256-pinned) | **0, deliberately** — a private mark has no band | sizing vs. issuer (below) |
| `static` | fixed numbers (localnet demo / CI determinism) | configurable | `issuer` config if present |

## The unresolved units question (and why it is not a risk)

The API's `markPrice` for OPENAI is ~$1017.88 while the mint's
`ScaledUiAmount` multiplier is 1.486. Whether issuer marks are **per raw
token** or **per displayed share** could not be established from public data
— the two readings differ by the multiplier, ~48.6% on that asset.

v1 does not guess. A pre-IPO asset config must say which reading its sizing
uses, and `issuer` supplies the cross-reference; the **program** then enforces
the asset's divergence cap at `resize_line` (501 bps past a 500 bps cap
fails the transaction — the integration test proves it, and the keeper's
`--selftest` proves the unit mismatch surfaces as a >8000 bps dislocation,
i.e. a refusal, not a silent mid-price). A wrong units choice therefore
freezes sizing for that asset — loudly, in the log — instead of mispricing
collateral. Fixing it is a one-line config decision once PreStocks documents
the scale; nothing in the program changes.

## What v1 deliberately does not do

- No `valuation_post` HTTP endpoint: it writes `demo/state.json` in the same
  shape instead, and the page polls the file (static-hosting friendly; the
  hosted endpoint is a drop-in later).
- No retries/backoff beyond the tick cadence; no multi-keeper coordination
  (the program tolerates any keeper set; last write wins on sizing, which is
  safe because every write must independently satisfy every guard).
- No harvesting scheduling: `harvest_dividend` is triggered by the mint's own
  pending-multiplier state, and the pre-IPO tier refuses harvest outright.
