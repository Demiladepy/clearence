# The Clearance pool

Status: contract implemented; end-to-end tests with real proofs in `e2e/` (27 Nov).

Contract: [`contracts/clearance-pool`](../../contracts/clearance-pool/src/lib.rs).
Tests: [`e2e/src/tests/pool.rs`](../../e2e/src/tests/pool.rs), harness [`world.rs`](../../e2e/src/tests/world.rs).

## Contracts and who controls them

| Contract | Code | Admin |
|---|---|---|
| Rule registry | ours (`contracts/rule-registry`) | us; each country's packs, corridors and allow-list pointer belong to that country's operator |
| Allow-list, one per country | upstream `asp-membership` | that country's operator (inserts KYC tier leaves) |
| Budget tree | upstream `asp-membership` | the pool (only it appends budget states) |
| Verifier | upstream `circom-groth16-verifier`, built with `clearance_tx_2_2_vk.json` | none (key embedded at build) |
| Clearance pool | ours (`contracts/clearance-pool`) | us (sets the budget tree once) |
| Token | Stellar asset contract (USDC on testnet) | issuer |

## What `transact` checks, in order

All before any state change. Token transfers and events come last, as upstream.

1. Proof shape (2 nullifiers, 4 + 6 record values); deposit cap and minimum.
2. Note root known; note nullifiers unspent (upstream).
3. `ext_data_hash` = hash of the call's external data, bound to this pool and token (upstream).
4. Public amount = `ext_amount - fee`; withdrawal payee not the pool or token (upstream).
5. Registry: both pack hashes active; corridor open if cross-border; epoch = `epoch(sender)`.
6. Identity root known to the sender country's allow-list (`registry.allow_list(sender)`).
7. Budget root known to the budget tree; budget nullifier unused.
8. Groth16 proof over all 28 public signals, `nonce` = `ext_data_hash`.

Then: mark note and budget nullifiers, insert both notes, append the new budget commitment, move
tokens, emit `new_commitment_event` x2, `new_nullifier_event` x2, `budget_step`, `sealed_record`.

## Events the apps read

| Event | Topics | Data | Read by |
|---|---|---|---|
| `budget_step` | nullifier | commitment, enc_new_spent, epoch | wallet: recovers today's total (`getBudget`) |
| `sealed_record` | sender jurisdiction, receiver jurisdiction | epoch, both pack hashes, record_r[4], record_c[6] | operator console: opens its copy |
| `new_commitment_event` | commitment | index, encrypted_output | wallet: finds its notes (as upstream) |

## Decisions

- **Fee 0.** The circuit counts any public outflow towards the sender's limits, so the pool is
  deployed with fee 0.
- **Budget tree is upstream's allow-list contract** with the pool as admin: no new tree code, and
  the root history (90 roots) lets a proof made against a slightly old root still land.
- **Allow-lists are per country** and found through the registry, so onboarding Kenya is a
  registry call plus a tree deployment, not a pool change.
