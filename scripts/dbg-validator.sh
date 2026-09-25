#!/usr/bin/env bash
# Debug helper: start a throwaway local validator with the current build.
# Prints the validator PID. Kill it when done.
set -uo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
PROGRAM_ID="$(sed -n 's/.*declare_id!("\([^"]*\)").*/\1/p' programs/ledgerline/src/lib.rs | head -n1)"
LEDGER="$PWD/.anchor/test-ledger-dbg"
rm -rf "$LEDGER"
EXTRA_ARGS=()
if [ -f "target/deploy/spl_token_2022.so" ]; then
  EXTRA_ARGS+=(--bpf-program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb "target/deploy/spl_token_2022.so")
fi
solana-test-validator \
  --reset \
  --ledger "$LEDGER" \
  --bpf-program "$PROGRAM_ID" "target/deploy/ledgerline.so" \
  "${EXTRA_ARGS[@]}" \
  --rpc-port 8899 \
  --quiet > logs/validator-dbg.log 2>&1 &
echo $!
