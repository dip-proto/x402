#!/usr/bin/env bash
#
# End-to-end x402 demo against the live BunnyCDN gateway.
# Override GATEWAY=... to point at your own deployment.
#
set -euo pipefail

GATEWAY=${GATEWAY:-https://x402-gateway-l130t.bunny.run}
KEY=${KEY:-payer}

cd "$(dirname "$0")/tools"

echo "== 1. free health endpoint =="
curl -s "$GATEWAY/health"
echo

echo "== 2. unpaid request gets a 402 with the PAYMENT-REQUIRED challenge =="
curl -s -D - -o /dev/null "$GATEWAY/" | grep -iE '^HTTP|^payment-required'
echo

echo "== 3. wallets =="
bun x402.ts wallet list
echo

echo "== 4. payer balance =="
bun x402.ts balance "$KEY"
echo

echo "== 5. verify the signature with the facilitator (no spend) =="
bun x402.ts verify "$GATEWAY/" --key "$KEY"
echo

echo "== 6. pay + settle on-chain, then read the paid content =="
bun x402.ts pay "$GATEWAY/" --key "$KEY"
