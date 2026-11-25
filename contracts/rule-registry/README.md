# rule-registry (Soroban)

Per-country rule packs for Clearance. Live on testnet at
`CDEXDT6BPD5XM7ASG2DQNVEJK37MX75TNSF4F27RD7LU5N7EPKVLOWCB`.

- `register_jurisdiction(j, admin)`: registry admin onboards a country and names its operator.
- `set_pack(j, rules) -> hash`: only that country's admin; new version, hash computed on-chain (Poseidon2, domain 0x14).
- `activate_version`, `active_pack`, `pack`, `is_active(j, hash)`: what the pool checks per proof.
- `epoch(j)`: local day, `floor((ledger_time + utc_offset) / 86400)`.
- `open_corridor` / `accept_corridor` / `close_corridor` / `corridor_open`: cross-border needs both operators.

Build and test from the repo root: `make test-contracts`. Built inside the upstream workspace via
`scripts/sync-upstream.sh`; deploy with `stellar contract build --package rule-registry`.
