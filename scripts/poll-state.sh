#!/usr/bin/env bash
# Poll pool/position PDAs with timestamps while a suite runs against :8899.
# Usage: poll-state.sh <seconds>
set -uo pipefail
END=$((SECONDS + ${1:-300}))
while [ $SECONDS -lt $END ]; do
  TS=$(date -u +%H:%M:%S)
  POOL=$(solana --url http://127.0.0.1:8899 account BErzq6g7GPShYzitATEnUDtJuRwKTTsyHEsTpqdKPxMp 2>/dev/null | grep -cE '^Length:' || true)
  POS=$(solana --url http://127.0.0.1:8899 account EHosfw3bHEUM7u1ScdTX899S6PysqKRUEFVzLFMNbEw9 2>/dev/null | grep -cE '^Length:' || true)
  echo "$TS pool_lines=$POOL pos_lines=$POS"
  sleep 5
done
