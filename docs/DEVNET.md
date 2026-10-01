# Devnet deployment — private key handling

> **Never paste a private key in chat, in a GitHub issue, or in a committed file.**
> Wallets and program keypairs live under gitignored paths (`dev-wallet.json`, `target/deploy/ledgerline-keypair.json`).

## Fresh start (recommended after wallet/program confusion)

From repo root (Floe). This replaces the old one-shot reset scripts.

```bash
bash scripts/devnet-setup.sh
# Drop local operator state if you are rotating the wallet or program id:
#   delete dev-wallet.json, target/mints, and target/deploy/ledgerline-keypair.json
solana-keygen new -o target/deploy/ledgerline-keypair.json --no-bip39-passphrase -f
export ANCHOR_WALLET=$PWD/dev-wallet.json
export ANCHOR_PROVIDER_URL=https://api.devnet.solana.com
anchor keys sync && anchor build
anchor deploy --provider.cluster devnet
npm run devnet:mints && npm run devnet:bootstrap
npm run client:sync
```

`devnet:bootstrap` initializes config (upgrade authority only), turns on permissive pricing for the no-Pyth sandbox, lists the mock asset, and sizes the operator's line. Draws from the dashboard are owner-signed and also write a spend policy for the keeper.

Old devnet programs (`G8SS…`, `Atmk…`, etc.) are **ignored** — they remain on-chain but are not used.

## Manual setup

```bash
bash scripts/bootstrap.sh          # if you don't have solana/anchor yet
bash scripts/devnet-setup.sh       # generates ./dev-wallet.json (gitignored) if missing
export ANCHOR_WALLET=$PWD/dev-wallet.json
export ANCHOR_PROVIDER_URL=https://api.devnet.solana.com
solana config get                  # should show devnet
solana balance                     # airdropped 2 SOL by the setup script
```

Program ID always comes from `programs/ledgerline/src/lib.rs` (`declare_id!`) and must match `target/deploy/ledgerline-keypair.json` after `anchor keys sync`.

## Deploy

```bash
anchor build
anchor deploy --provider.cluster devnet
# or
bash scripts/deploy.sh devnet
# Windows:
powershell -File scripts/deploy-devnet.ps1
```

## After deploy

```bash
# Write app/.env.local by hand:
# NEXT_PUBLIC_PROGRAM_ID=<declare_id from lib.rs>
# NEXT_PUBLIC_RPC_URL=https://api.devnet.solana.com
cd app && npm install && npm run dev   # http://localhost:3000

cd keeper && npm install
ANCHOR_WALLET=$PWD/../dev-wallet.json npm run keeper:once
```

## GitHub Actions keeper

Do **not** paste the keypair JSON into chat. Add it as a repository secret:

```bash
cat dev-wallet.json | gh secret set KEEPER_KEYPAIR_JSON --repo yourname/Ledgerline
gh secret set KEEPER_CONFIG_JSON < keeper/config.devnet.json --repo yourname/Ledgerline
```

The workflow writes that JSON to `keeper/config.devnet.json` at runtime. It does not expect the file to be committed.

## Pyth on devnet

- For **real Pyth** pull feeds, set the receiver: `cargo run -p ledgerline-cli -- set-pyth-receiver rec5EKMGg6MxZYaQw7izjX77suqyJpgyythF94b37Fz`
- For **mock** feeds (no Hermes), an admin must call `set_permissive_pricing(true)`. An unset receiver no longer accepts keeper marks on its own. The program logs `PERMISSIVE PRICING` when that flag is on. Bootstrap does this for the sandbox.

## What is real vs synthetic on devnet

Real: the Floe program (`ledgerline` on-chain), Token-2022 ScaledUiAmount multiplier, on-chain Pyth verification when `pyth_receiver` is set.
Synthetic: the xStock mint (mock, 6dp, multiplier bumps administered by you), USDC (mock SPL), and price marks when permissive pricing is explicitly on (keeper-trusted, logged). Label it in your demo — judges reward honesty.

## Verify alignment

```bash
node scripts/check-devnet-mismatch.cjs
```

Expect one program with `configExists: true`, `usdcMintMatchesDevnetMintsTs: true`, and `keeper` equal to your operator pubkey.
