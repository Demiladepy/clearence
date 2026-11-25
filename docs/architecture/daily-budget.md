# Per-payment limit and daily budget

Status: circuit implemented and tested (25 Nov). Pool-side enforcement (budget tree + nullifier
set on-chain) comes with the pool integration.

Circuit: [`circuits/src/dailyBudget.circom`](../../circuits/src/dailyBudget.circom).
Tests: [`circuits/test/rust/clearance_budget.rs`](../../circuits/test/rust/clearance_budget.rs).
Mutation results: [`docs/evidence/mutation-budget.md`](../evidence/mutation-budget.md).

## What it guarantees

- `sent <= perPaymentLimit` and `spentToday + sent <= dailyLimit`, with the sender's tier limits
  from the sender's country pack.
- One budget **per person per local day**, however many wallets they use.
- The budget resets at local midnight of the sender's country (epoch from the rule registry).

## How

Each person has one chain of budget states per day: state `k` holds `spent_k`, with `spent_0 = 0`.

| Value | Formula | Visibility |
|---|---|---|
| state key | `key_k = H(idSecret, epoch, k; 0x15)` | private |
| commitment | `C_k = H(H(idCommitment, epoch, k; 0x13), spent_k, key_k; 0x13)` | budget tree leaf |
| nullifier | `N_k = H(idSecret, epoch, k; 0x12)` | public, spent once |
| encrypted total | `encSpent = spent_{k+1} + key_{k+1}` | public |

A payment at state `k` proves `C_k` is in the budget tree (or `k = 0` and `spent = 0`), checks both
limits, and publishes `N_k`, `C_{k+1}` and `encSpent`. The pool rejects a reused `N_k` and appends
`C_{k+1}`.

## Why a second wallet can't double the budget

- `N_0` depends only on `idSecret` and the day, so every wallet of a person produces the same `N_0`.
  A second "fresh start" is rejected by the pool (tested: `second_wallet_shares_the_budget`).
- Continuing the chain needs `C_k`, which commits to the real `spent_k`. Claiming a lower total
  fails the proof (same test).

## Why wallets don't need to sync

Every value above is derivable from `idSecret`. A wallet recomputes `N_0, N_1, ...`, finds which are
on-chain, and decrypts the latest `encSpent` with `key_k`. No server and no device-to-device sync.
`Wallet::recover` in the tests is that algorithm, and the SDK will port it.

## Cost

See [evidence](../evidence/README.md) (`clearance_budget_test`, includes the identity keys).
