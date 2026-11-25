# The payment circuit

Status: implemented and tested end to end (25 Nov). Pool contract integration is next.

Circuit: [`circuits/src/clearanceTransaction.circom`](../../circuits/src/clearanceTransaction.circom),
entry point [`clearance_tx_2_2.circom`](../../circuits/src/clearance_tx_2_2.circom).
Tests: [`circuits/test/rust/clearance_tx.rs`](../../circuits/test/rust/clearance_tx.rs).
Mutation results: [`docs/evidence/mutation-tx.md`](../evidence/mutation-tx.md).

## One proof per payment

Built on upstream's `PolicyTransaction` (2 input notes, 2 output notes, 20-level pool tree). The
upstream allow-list check (one leaf per note key) and note encryption to a pool admin are replaced
by the pieces below.

| # | Check | Template |
|---|---|---|
| 1 | Every input note is spent with the sender's `noteKey` | `IdentityKeys` |
| 2 | Sender is on their country's allow-list at `tier` | `ClearanceIdentity` |
| 3 | Pack values hash to `senderPackHash` and `receiverPackHash` | `PackHash` x2 |
| 4 | `sent = inputs - change`; change to the sender's own key; public amount only as withdrawal | |
| 5 | `sent <= perPayment`, `todaysTotal <= daily`, sender's tier and pack | `DailyBudget` |
| 6 | Travel Rule flag `todaysTotal >= min(senderThreshold, receiverThreshold)` | |
| 7 | Record `(idCommitment, receiverPubKey, 2*sent + flag)` sealed to each operator key from the packs | upstream `GlobalViewKeyEncryption` x2 |

## Public signals

| Signal | Checked by the pool against |
|---|---|
| `root`, `inputNullifier`, `outputCommitment`, `publicAmount`, `extDataHash` | pool, as upstream |
| `nonce` | must equal `extDataHash` |
| `identityRoot` | sender country's allow-list contract |
| `budgetRoot`, `budgetNullifier`, `newBudgetCommitment` | pool's budget tree and nullifier set |
| `epoch` | `registry.epoch(senderJurisdiction)` |
| `senderJurisdiction`, `receiverJurisdiction` | `registry.corridor_open(s, r)` unless equal |
| `senderPackHash`, `receiverPackHash` | `registry.is_active(s, hash)`, `registry.is_active(r, hash)` |
| `encNewSpent`, `recordR`, `recordC` | stored/emitted for the wallet and the operators |

No amount, sender identity or receiver appears in the public signals (asserted in
`domestic_nigeria_payment_and_operator_opens_the_record`).

## Decisions

- **Record fits upstream's encryption.** The record is three field elements, which is exactly what
  `GlobalViewKeyEncryption` encrypts. The epoch is public anyway, and `sent` and the flag share one
  field (`2*sent + flag`), so upstream's encryption is reused unchanged.
- **Operator keys come from the packs.** The key each record is sealed to is part of the hashed pack,
  so it is the key the operator published in the registry. No separate key input to trust.
- **Domestic payments also produce two records.** Both go to the same operator, so a cross-border
  payment looks the same size on-chain as a domestic one.
- **Deposits are out of scope for this circuit.** A deposit moves public funds into the sender's own
  note and is visible on-chain. Withdrawals are allowed and count towards `sent`.
- **Travel Rule flag is cumulative per day,** so splitting a payment does not avoid the flag.

## Cost

37,087 constraints (upstream allow-list + view-key circuit: 26,040). See [evidence](../evidence/README.md).
