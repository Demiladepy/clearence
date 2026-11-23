# Day 1 findings: Nethermind's Stellar Private Payments (SPP)

Upstream: `NethermindEth/stellar-private-payments` @ `cd6c8fc` (2026-11-20), cloned to `vendor/nethermind-spp`.

## What already exists upstream (less to build)

| PRD item | Upstream piece | Our change |
|---|---|---|
| FR-1, FR-6 allow-list | `aspMembership.circom` + `contracts/asp-membership` (leaf = Poseidon2(pubKey, blinding), dom 0x01) | Leaf = Poseidon2(idCommitment, tier); add `revoke(leaf)` (an append-only tree needs a revocation approach, see below) |
| FR-4 sealed record | `globalViewKey.circom` + `contracts/pool-gvk`: in-circuit ECDH on Baby JubJub against admin key `D`, Poseidon2 keystream, fixed shape | Reuse GVK, but encrypt `[idCommitment, receiverPubKey, sent, epoch, travelRuleFlag]` instead of note secrets |
| FR-2 per-payment | `policyTransaction.circom` (2-in / 2-out, 248-bit amount checks) | Add `sent = inputs - change`, change must go to the sender's own key, `sent <= perPaymentLimit` |
| On-chain verify | `contracts/circom-groth16-verifier` (BN254 host fns) | New VK for the extended circuit |
| Wallet / SEP-43 | `app/`, `sdk/web` (npm `stellar-private-payments`) | Our SDK wraps theirs |

## PRD corrections to agree with Michael

1. **Hash is Poseidon2, not Poseidon.** Every SPP hash is Poseidon2 with a domain-separation tag
   (0x01 leaf/commitment, 0x02 nullifier, 0x03 keypair, 0x04 signature, 0x05/0x06 GVK).
   circom-rln and ZK-Kit `poseidon-cipher` use classic Poseidon (circomlib), so the PRD's "use
   Nethermind's Poseidon parameters everywhere" means **port RLN's budget logic to Poseidon2, and use
   GVK's encryption instead of ZK-Kit**. That drops the ZK-Kit dependency and the unaudited ZK-Kit
   ECDH circuit. GVK is still unaudited, but it is in the same codebase as the pool.
2. The **parity test** is then Poseidon2 in Rust (`circuits/src/core`, contract `soroban-utils`) vs
   circuit vs browser WASM. Upstream likely has this already. Check the `circuits` crate tests first.
3. **Keys:** upstream `publicKey = Poseidon2(privateKey, 0; dom 0x03)`. For "one person, many wallets"
   we set `privateKey` = a derivation of `idSecret`, so every wallet shares one spending identity and
   one budget (FR-3, AT-3).

## Proposed new domain tags (free in upstream)

| Tag | Use |
|---|---|
| 0x10 | `idCommitment = H(idSecret, 0)`, `noteKey = H(idSecret, 1)` (implemented) |
| 0x11 | allow-list leaf `H(H(idCommitment, jurisdiction, tier), issuance)` (implemented) |
| 0x12 | `budgetNullifier = H(idSecret, epoch, seq)` |
| 0x13 | `budgetCommitment = H(idCommitment, epoch, seq+1, newSpent, salt)` (chained, since Poseidon2 here takes ≤3 inputs) |
| 0x14 | `packHash` (implemented) |

Checked: upstream uses only 0x01-0x06.

## Open design points (decide in Monday's spike)

- **Budget notes:** a second tree vs domain-separated leaves in the note tree. Upstream `pool-core`
  has `merkle_with_history.rs`, and a second instance is a small contract change. Leaning toward a
  **second tree** because the note tree's circuit and leaf format stay untouched.
- **Revocation (FR-6):** the ASP membership tree is append-only. Options: (a) leaf includes a
  `leafVersion` and the contract keeps a revoked set checked via a non-membership proof (upstream
  already has `asp-non-membership`, a sparse Merkle tree); (b) rebuild the root without the leaf.
  (a) reuses upstream code. Lean (a).
- **epoch:** the contract computes it from `env.ledger().timestamp() / 86400` and passes it as a public input.

## Measured (this container: 4 vCPU, native Rust prover, release build)

| Circuit | Constraints | Public inputs | Notes |
|---|---|---|---|
| `policy_tx_2_2` (base transfer) | 11,816 | 7 | |
| `policy_tx_2_2_A` (+ allow-list) | 16,656 | 9 | |
| `policy_tx_2_2_A_gvk_V` (+ operator view key) | **26,040** | 12 | **our base**; prove and verify < 1.9 s |
| One GVK sealed record | about 4,700 | | (26,040 - 16,656) / 2 outputs |
| `PackHash` (Clearance) | 2,640 | 1 output | x2 for sender + receiver packs |
| `ClearanceIdentity(10)` | 3,173 | 2 in, 4 out (test) | identity, tier leaf, depth-10 membership, tier limit select |

- Poseidon2 parity: circuit vs Rust reference passes (`prove_poseidon2` tests). The contract vs
  Rust reference check is upstream's `asp-membership` tests.
- Pack-hash parity: contract (`pack_hash_matches_testnet_and_circuit_golden_values`), Rust reference and
  circuit (`prove_pack_hash`) all reproduce the NG and GH v1 hashes live on the testnet registry.
- Still to measure: proving time in Chrome (WASM) and on-chain verification cost on testnet.

## Identity and tier (implemented)

`circuits/src/clearance/identity.circom`, tests in `circuits/src/test/prove_identity.rs`.

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
