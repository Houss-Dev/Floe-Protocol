#!/usr/bin/env bash
# Deploy to devnet (or localnet) — builds, deploys, and initializes a demo market.
set -euo pipefail
cd "$(dirname "$0")/.."

CLUSTER="${1:-devnet}"
WALLET="${ANCHOR_WALLET:-$HOME/.config/solana/id.json}"
if [ ! -f "$WALLET" ]; then
  echo "Missing wallet $WALLET"
  echo "Run: bash scripts/devnet-setup.sh"
  exit 1
fi

# 1) Build
echo "==> anchor build"
anchor build

# 2) Deploy
echo "==> anchor deploy --provider.cluster $CLUSTER"
anchor deploy --provider.cluster "$CLUSTER"

# 3) Fetch Token-2022 for localnet only (devnet already has it)
if [ "$CLUSTER" = "localnet" ] && [ ! -f target/deploy/spl_token_2022.so ]; then
  echo "==> fetching Token-2022 program for ScaledUiAmount"
  python3 scripts/fetch-token-2022.py || echo "fetch-token-2022 failed — localnet ScaledUiAmount tests will fail"
fi

# 4) Initialize demo (config + one asset) — optional, for quick demo
echo "==> demo init (if you want a seeded market, run: npm --prefix app run dev)"
echo "Deploy done. Program ID: $(grep -oP '(?<=declare_id!\(\")[^\"]+' programs/ledgerline/src/lib.rs)"
echo "RPC: $CLUSTER  Wallet: $WALLET"
echo
echo "Next — open the app:"
echo "  cd app && npm install && npm run dev   # http://localhost:3000"
echo "Keeper:"
echo "  cd keeper && npm install && npm run keeper:once"
