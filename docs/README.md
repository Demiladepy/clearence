# Clearance docs

| Doc | What |
|---|---|
| [architecture/multi-jurisdiction.md](architecture/multi-jurisdiction.md) | Countries as data, cross-border rules, rollout, regulator sources to verify |
| [architecture/identity-and-tier.md](architecture/identity-and-tier.md) | Identity, KYC tier leaf, tier limit selection |
| [architecture/daily-budget.md](architecture/daily-budget.md) | Per-payment limit, daily budget per person, multi-wallet recovery |
| [architecture/payment-circuit.md](architecture/payment-circuit.md) | The full payment circuit: what one proof shows, public signals, decisions |
| [architecture/history.md](architecture/history.md) | Chain history past the RPC's 7-day retention: event archive, checked against on-chain roots |
| [architecture/pool.md](architecture/pool.md) | The Clearance pool: contracts, checks, events the apps read |
| [sdk.md](sdk.md) | The TypeScript SDK: using it in the frontend, mock to real mapping, running the proofs |
| [research/ng-v2-pack.md](research/ng-v2-pack.md) | NG-v2 rule pack: CBN tiered-KYC figures vs NG-v1, proposal (not published) |
| [research/upstream-spp-findings.md](research/upstream-spp-findings.md) | What we reuse from Nethermind SPP, domain tags, open design points |
| [evidence/README.md](evidence/README.md) | Generated: test results and circuit sizes at a given commit |
| [evidence/mutation-budget.md](evidence/mutation-budget.md), [evidence/mutation-tx.md](evidence/mutation-tx.md) | Generated: which test catches each removed constraint |
