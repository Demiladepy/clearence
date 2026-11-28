#!/usr/bin/env bash
# Mint CLRUSD (the testnet TEST token) to a demo account. The account must
# already trust CLRUSD (client.addTokenTrustline() in the SDK does that).
#   scripts/fund-demo-account.sh G... 100 [network]
set -euo pipefail
TO=$1; USD=$2; NET=${3:-clr-testnet}
TOKEN=$(python3 -c "import json;print(json.load(open('$(dirname "$0")/../deployments/testnet.json'))['token']['contract'])")
STROOPS=$(python3 -c "print(round($USD * 10**7))")
stellar contract invoke --id "$TOKEN" --source clr-admin --network "$NET" -- mint --to "$TO" --amount "$STROOPS"
