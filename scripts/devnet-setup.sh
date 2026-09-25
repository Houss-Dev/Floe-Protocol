#!/usr/bin/env bash
# Devnet setup — generates a local keypair, funds it, and prints next steps.
# NEVER paste a private key into chat or commit it. This script keeps the keypair
# on disk (gitignored) and only prints the public key.
set -euo pipefail
cd "$(dirname "$0")/.."

WALLET="dev-wallet.json"
if [ -f "$WALLET" ]; then
  echo "Found existing $WALLET"
else
  if ! command -v solana-keygen >/dev/null 2>&1; then
    echo "solana-keygen not found — installing via Agave 2.1.21 is required."
    echo "Run: bash scripts/bootstrap.sh"
    exit 1
  fi
  solana-keygen new --no-outfile --silent --no-bip39-passphrase -o "$WALLET"
  echo "Generated $WALLET (gitignored)"
fi

PUBKEY=$(solana-keygen pubkey "$WALLET" 2>/dev/null || solana address -k "$WALLET" 2>/dev/null || echo "unknown")
echo "Public key: $PUBKEY"
echo
echo "Funding via devnet faucet (2 SOL)..."
solana config set --url https://api.devnet.solana.com >/dev/null 2>&1 || true
solana airdrop 2 "$PUBKEY" --url https://api.devnet.solana.com || echo "Airdrop failed — try: solana airdrop 2 $PUBKEY --url https://api.devnet.solana.com"
echo
echo "Next:"
echo "  export ANCHOR_WALLET=$PWD/$WALLET"
echo "  export ANCHOR_PROVIDER_URL=https://api.devnet.solana.com"
echo "  anchor keys sync   # ensure declare_id! matches your keypair if you generated a new program key"
echo "  bash scripts/deploy.sh"
echo
echo "To set keeper on devnet:"
echo "  anchor run -- set-pyth-receiver rec5EKMGg6MxZYaQw7izjX77suqyJpgyythF94b37Fz  # real receiver"
echo "  # or leave as default (permissive) for mock PriceUpdates on devnet"
echo
echo "Security: $WALLET is gitignored. Do NOT commit it, do NOT paste its contents in chat."
echo "For GitHub Actions, add the JSON as a secret: KEEPER_KEYPAIR_JSON"
echo "  cat $WALLET | gh secret set KEEPER_KEYPAIR_JSON --repo yourname/Ledgerline"
