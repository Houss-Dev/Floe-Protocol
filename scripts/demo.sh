#!/usr/bin/env bash
# End-to-end demo: throwaway validator -> scripted user journey -> keeper ticks
# -> demo/state.json for the page. Prints everything; exit code is the verdict.
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
export ANCHOR_PROVIDER_URL="http://127.0.0.1:8899"
export ANCHOR_WALLET="${ANCHOR_WALLET:-$HOME/.config/solana/id.json}"
export LL_RPC="http://127.0.0.1:8899"

PROGRAM_ID="CK5xutaXUwmdcLR8qh7cCZMXJ5fkqopk1P5NZEM3cLrN"
SO="target/deploy/ledgerline.so"
TOKEN_2022_SO="target/deploy/spl_token_2022.so"
[ -f "$SO" ] || { echo "run anchor build first"; exit 1; }
if [ ! -f "$TOKEN_2022_SO" ]; then
  echo "==> fetching the live Token-2022 (bundled one predates ScaledUiAmount)"
  python3 scripts/fetch-token-2022.py >/dev/null || { echo "fetch failed"; exit 1; }
fi

LEDGER="$ROOT/.anchor/demo-ledger"; mkdir -p logs
rm -rf "$LEDGER"
ARGS=(--reset --ledger "$LEDGER" --bpf-program "$PROGRAM_ID" "$SO" --rpc-port 8899 --quiet)
[ -f "$TOKEN_2022_SO" ] && ARGS+=(--bpf-program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb "$TOKEN_2022_SO")
echo "==> validator"
solana-test-validator "${ARGS[@]}" > logs/demo-validator.log 2>&1 &
VPID=$!
trap 'kill $VPID 2>/dev/null; wait $VPID 2>/dev/null' EXIT
for i in $(seq 1 90); do
  if curl -s -m 2 http://127.0.0.1:8899/health 2>/dev/null | grep -q ok; then echo "==> healthy after ${i}s"; break; fi
  sleep 1
done
curl -s -m 2 http://127.0.0.1:8899/health | grep -q ok || { echo "validator never came up"; tail -5 logs/demo-validator.log; exit 1; }
# fund the default keypair (the demo's admin/payer/keeper)
ADMIN=$(solana address 2>/dev/null)
for a in 1 2 3; do solana airdrop 10 "$ADMIN" -um >/dev/null 2>&1 && break; sleep 2; done
solana balance "$ADMIN" -um

echo "==> user journey (with real-time guard waits)"
./node_modules/.bin/ts-node --transpile-only scripts/demo-run.ts; RC=$?

echo "==> keeper tick (writes demo/state.json)"
./node_modules/.bin/ts-node --transpile-only keeper/index.ts --config keeper/config.demo.json --loop 2 30; RC2=$?

echo "==> demo page snapshot: demo/state.json"
head -c 400 demo/state.json 2>/dev/null; echo
[ $RC -eq 0 ] && [ $RC2 -eq 0 ] && echo "DEMO OK" || echo "DEMO FAILED (rc=$RC,$RC2)"
exit $((RC + RC2))
