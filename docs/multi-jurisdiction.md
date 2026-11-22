# Clearance across jurisdictions: Lagos, Accra, then Nairobi, Johannesburg and cross-border

## Principle

**Countries are data, not code.** One circuit, one pool, one registry. A jurisdiction is a row in
the rule registry, published by that country's own licensed operator. Adding Kenya or South Africa
takes two contract calls (`register_jurisdiction`, then `set_pack`), not a new circuit or a redeploy.

## What a rule pack holds (on-chain, `contracts/rule-registry`)

| Field | Why it differs by country |
|---|---|
| `jurisdiction` | ISO 3166-1 numeric: NG 566, GH 288, KE 404, ZA 710 |
| `version` | Every change is a new version; old ones are kept for audit |
| `utc_offset_secs` | "Daily" means the local day: Lagos +1h, Accra 0, Nairobi +3h, Johannesburg +2h |
| `travel_rule_threshold` | FATF default is USD/EUR 1,000; some countries set lower |
| `tiers[3]` | per-payment and daily limits per KYC tier |
| `operator_key` | Each country's operator holds its own decryption key |
| `hash` | Poseidon2 over all of the above, **computed on-chain**; the circuit recomputes it |

All amounts are USDC stroops. Local currency is display-only with a labelled fixed rate (PRD non-goal: no FX feed).

## Who controls what

- **Registry admin (us):** onboards a jurisdiction and names its operator. Cannot touch its rules.
- **Jurisdiction admin (the licensed operator there):** the only party that can publish or roll back
  that country's pack, and open or accept corridors for it. Covered by test
  `only_the_jurisdictions_own_admin_can_set_its_pack`.

## Cross-border

A payment from A to B:

1. **Sending limits come from A.** The sender's tier, per-payment and daily limits are A's rules,
   because A's regulator licensed the sender's KYC.
2. **Travel Rule flag uses the stricter threshold:** `flag = newSpent >= min(threshold_A, threshold_B)`.
3. **Both operators get the record.** The circuit seals the same record twice, once to A's operator
   key and once to B's. A domestic payment also produces two records, both sealed to A, so a
   cross-border payment looks the same size on-chain as a domestic one.
4. **The corridor must be open on both sides:** A's operator opens it, B's accepts it, and either can
   close it immediately. Domestic is always open.
5. **The pool checks** `is_active(A, packHashA)`, `is_active(B, packHashB)`, `corridor_open(A, B)`,
   and passes `epoch(A)` as the public epoch.

This is the on-chain half of the Travel Rule: both operators can independently open their own copy
of who paid whom. Operator-to-operator messaging stays off-chain (PRD non-goal).

### Circuit changes this implies (on top of the PRD's 5 constraint groups)

- Public inputs: `senderPackHash`, `receiverPackHash` (replacing the single `packHash`).
- Private inputs: both packs' values. Recompute both hashes, using A's tiers and `min` of the thresholds.
- Sealed record runs twice (about 4.7k constraints each, measured from `policy_tx_2_2_A_gvk_V`).
- Estimated total: about 45k constraints, versus 26,040 for the base allow-list plus view-key
  circuit, which proves and verifies natively in under 1.9 s.

### Privacy trade-off to decide

With public pack hashes, an observer can tell which jurisdiction pair a payment used (e.g. NG to GH),
though not who paid or how much. The PRD accepts this ("pack hash in each proof: public, yes").

A stronger v2 hides the corridor too: the registry publishes one Merkle root over all open
`(packA, packB)` pairs, the proof shows membership, and the contract passes the ledger timestamp
instead of an epoch, so the circuit derives the local day privately. **Recommendation: v1 for
1 December, and v2 as the "next" slide.**

## Rollout

| Phase | Scope | Proof point |
|---|---|---|
| 1 Dec demo | NG and GH packs, NG to GH corridor | Same payment passes in NG and fails in GH; cross-border record opened by both operators |
| Next | KE, ZA | Registry calls only; `onboards_kenya_and_south_africa_without_code_changes` test |
| Later | Corridor hiding (v2), key rotation, threshold decryption | |

## Regulatory numbers to verify (you)

I have **not** put real limits on-chain. Each pack needs figures from the regulator's own text.
Check these sources and fill in the table:

| Country | Regulator(s) | Where to look | What we need |
|---|---|---|---|
| Nigeria | CBN; SEC Nigeria | https://www.cbn.gov.ng and https://sec.gov.ng | Travel Rule threshold (PRD: 26.14.3, USD/EUR 1,000), KYC tier limits, whether the 2026 VA regulations are in force |
| Ghana | Bank of Ghana; SEC Ghana | https://www.bog.gov.gh and https://sec.gov.gh | VASP regime status, Travel Rule threshold, tiered KYC limits |
| Kenya | CBK; CMA (VASP Act 2025) | https://www.centralbank.go.ke, https://www.cma.or.ke and https://new.kenyalaw.org | VASP Act commencement, Travel Rule threshold |
| South Africa | FIC (Directive 9); FSCA | https://www.fic.gov.za and https://www.fsca.co.za | Directive 9 threshold. I recall R5,000, but confirm it from the directive |
| Baseline | FATF Recommendation 16 | https://www.fatf-gafi.org | USD/EUR 1,000 de minimis |

Until those are confirmed, demo packs are labelled **illustrative** in the UI and pitch.
