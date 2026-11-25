# Clearance circuits

| Template | File | Proves |
|---|---|---|
| `PackHash` | [src/packHash.circom](src/packHash.circom) | Recomputes the registry's on-chain pack hash from private pack values |
| `ClearanceIdentity(levels)` | [src/identity.circom](src/identity.circom) | Sender's identity is on their country's allow-list at a tier; outputs that tier's limits |
| `DailyBudget(levels)` | [src/dailyBudget.circom](src/dailyBudget.circom) | Per-payment and daily limits per person per local day, one budget across all wallets |
| `ClearanceTransaction` | [src/clearanceTransaction.circom](src/clearanceTransaction.circom) | The payment: all of the above plus notes, change to self, Travel Rule flag, records sealed to both operators. Entry: [src/clearance_tx_2_2.circom](src/clearance_tx_2_2.circom) |

Tests: entry-point circuits in [test/circuits](test/circuits), proving tests in [test/rust](test/rust).

These files compile inside the upstream workspace: `scripts/sync-upstream.sh` copies `src/` to
`upstream/nethermind-spp/circuits/src/clearance/`, so `include` paths are relative to that location
(e.g. `../poseidon2/poseidon2_hash.circom`). Run `make circuits` then `make test-circuits`.
