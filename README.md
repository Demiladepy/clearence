# Clearance event archive

Every event of the Clearance testnet contracts (pool, budget tree, allow-lists, rule registry) since
the deployment, kept beyond the RPC's ~7-day retention. Written by `scripts/archive-events.mjs` on
`main`, refreshed every 6 hours by `.github/workflows/events-archive.yml`.

The SDK reads `testnet/events.json` (its `TESTNET.archiveUrl`), then the RPC for the ledgers after
`toLedger`. Nothing here is trusted: every tree rebuilt from it must hash to a root the contract
knows, or the SDK refuses with `STATE_MISMATCH`.

Machine-written. Do not edit by hand.
