# Identity and KYC tier

Status: implemented and tested (23 Nov).

Circuit: [`circuits/src/identity.circom`](../../circuits/src/identity.circom). Tests: [`circuits/test/rust/clearance_identity.rs`](../../circuits/test/rust/clearance_identity.rs).

- The wallet holds one `idSecret` per person. It derives `idCommitment` (given to the operator at
  KYC) and `noteKey` (the pool spending key), so every wallet of that person shares one identity.
- The operator inserts `leaf = H(H(idCommitment, jurisdiction, tier), issuance)` into their own
  country's allow-list (one upstream `asp-membership` instance per country, admin = that operator).
- `jurisdiction` in the leaf: a Ghana KYC cannot prove under Nigeria's pack (tested).
- `issuance`: after a revocation or tier change the operator issues a fresh leaf that does not
  collide with the revoked one (tested). The revoked-set check itself comes with FR-6.
- `TierSelect` outputs that tier's per-payment and daily limits from the sender pack and rejects any
  tier outside 1-3, even if an operator issued one (tested).
- Wiring into the transfer circuit: every input note's private key must equal `noteKey`, so notes
  from a non-KYC'd key cannot be spent under someone else's identity. This is added with the budget step.
