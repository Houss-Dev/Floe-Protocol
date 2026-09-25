#!/usr/bin/env bash
# Run the integration suite against a throwaway local validator.
#
# Everything happens inside one process because background jobs do not survive
# between invocations in this environment: the validator has to be started,
# used and killed by the same script.
set -uo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"

export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
export ANCHOR_PROVIDER_URL="http://127.0.0.1:8899"
export ANCHOR_WALLET="${ANCHOR_WALLET:-$HOME/.config/solana/id.json}"
export TS_NODE_TRANSPILE_ONLY=1

PROGRAM_ID="$(grep -oP '(?<=^declare_id!\(")[^"]+' programs/ledgerline/src/lib.rs)"
SO="target/deploy/ledgerline.so"

[ -f "$SO" ] || { echo "missing $SO - run anchor build first"; exit 1; }
[ -f "$ANCHOR_WALLET" ] || { echo "missing wallet $ANCHOR_WALLET"; exit 1; }

LEDGER="$ROOT/.anchor/test-ledger"
rm -rf "$LEDGER"
mkdir -p "$(dirname "$LEDGER")" logs

# The Token-2022 shipped with Agave 2.1.21 predates the ScaledUiAmount extension.
TOKEN_2022_SO="target/deploy/spl_token_2022.so"
EXTRA_ARGS=()
if [ -f "$TOKEN_2022_SO" ]; then
  echo "==> overriding Token-2022 with $TOKEN_2022_SO"
  EXTRA_ARGS+=(--bpf-program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb "$TOKEN_2022_SO")
fi

start_surfpool() {
  NO_DNA=1 surfpool start --ci --offline --legacy-anchor-compatibility \
    --reset \
    --ledger "$LEDGER" \
    --bpf-program "$PROGRAM_ID" "$SO" \
    "${EXTRA_ARGS[@]}" \
    --rpc-port 8899 \
    --quiet > logs/validator.log 2>&1 &
  VALIDATOR_PID=$!
}

start_classic_validator() {
  solana-test-validator \
    --reset \
    --ledger "$LEDGER" \
    --bpf-program "$PROGRAM_ID" "$SO" \
    "${EXTRA_ARGS[@]}" \
    --rpc-port 8899 \
    --quiet > logs/validator.log 2>&1 &
  VALIDATOR_PID=$!
}

echo "==> starting local network with $PROGRAM_ID"

if command -v surfpool >/dev/null 2>&1; then
  echo "==> using Surfpool (NO_DNA=1, legacy Anchor compat)"
  start_surfpool
else
  echo "==> surfpool not installed — falling back to solana-test-validator"
  echo "    install: curl -sL https://run.surfpool.run/ | bash"
  start_classic_validator
fi
trap 'kill "$VALIDATOR_PID" 2>/dev/null; wait "$VALIDATOR_PID" 2>/dev/null' EXIT

# Wait for the RPC to answer, not just for the process to exist.
for i in $(seq 1 60); do
  if [ "$(curl -s -m 3 http://127.0.0.1:8899/health 2>/dev/null)" = "ok" ]; then
    echo "==> validator healthy after ${i}s"
    break
  fi
  if ! kill -0 "$VALIDATOR_PID" 2>/dev/null; then
    echo "==> validator died during startup"; tail -20 logs/validator.log; exit 1
  fi
  sleep 1
done

if [ "$(curl -s -m 3 http://127.0.0.1:8899/health 2>/dev/null)" != "ok" ]; then
  echo "==> validator never became healthy"; tail -20 logs/validator.log; exit 1
fi

echo "==> program account"
solana --url http://127.0.0.1:8899 account "$PROGRAM_ID" 2>&1 | grep -E 'Executable|Owner' || true

WALLET_PUB="$(solana-keygen pubkey "$ANCHOR_WALLET")"
echo "==> test wallet $WALLET_PUB (funded in the mocha before-hook from faucet-keypair)"

echo "==> running tests"
SUITE="${1:-tests/ledgerline.ts}"
# Node 22.18+ type-strips .ts and Mocha then import()s it as ESM, which
# breaks CJS named exports from @coral-xyz/anchor. Force ts-node CJS.
NODE_TEST_FLAGS=()
if node --no-experimental-strip-types -e "process.exit(0)" >/dev/null 2>&1; then
  NODE_TEST_FLAGS+=(--no-experimental-strip-types)
fi
export TS_NODE_PROJECT="${TS_NODE_PROJECT:-./tsconfig.json}"
node "${NODE_TEST_FLAGS[@]}" ./node_modules/mocha/bin/mocha \
  --require ts-mocha \
  --timeout 300000 \
  "$SUITE"
STATUS=$?

echo "==> tests exited $STATUS"
exit $STATUS
