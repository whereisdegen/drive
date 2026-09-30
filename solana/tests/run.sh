#!/usr/bin/env bash
# Fresh validator, fresh deploy, then the tests.
#
# The config PDA is seeded ["config"] - one per program, for the life of the chain - so a second
# run against the same validator would hit "already in use" on initialize. Resetting is simpler
# and faster than making every test tolerate leftover state from the last one.
set -euo pipefail
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LEDGER="${TMPDIR:-/tmp}/tensorace-ledger"

# NB: an EXIT trap's own last command becomes the script's exit status, so a cleanup that ends in
# a successful `kill` reports success no matter how the tests went. This script did exactly that,
# and reported 0 with five failing tests - which is worse than having no test script at all. The
# status is therefore captured explicitly and re-raised at the end.
cleanup() { [[ -n "${VPID:-}" ]] && kill "$VPID" 2>/dev/null; return 0; }
trap cleanup EXIT

pkill -f solana-test-validator 2>/dev/null || true
sleep 1
rm -rf "$LEDGER"
solana-test-validator --ledger "$LEDGER" --reset --quiet &
VPID=$!

echo "waiting for the validator..."
for _ in $(seq 1 40); do
  solana cluster-version --url http://127.0.0.1:8899 >/dev/null 2>&1 && break
  sleep 1
done

solana config set --url http://127.0.0.1:8899 >/dev/null
solana airdrop 100 >/dev/null 2>&1 || true

echo "deploying..."
( cd "$HERE" && anchor deploy --provider.cluster localnet 2>&1 | grep -E "Program Id|Deploy success" )

echo "testing..."
STATUS=0
( cd "$HERE" && node --test --test-concurrency=1 tests/*.test.mjs ) || STATUS=$?
exit "$STATUS"
