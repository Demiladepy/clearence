# Clearance SDK (`packages/sdk`)

Status: **live on Stellar testnet** (27 Nov). No mocks: proofs are made in the browser (or Node)
with the deployed circuit's proving key, payments are Soroban transactions signed by the user's
wallet, and all state (balances, budget, records) is rebuilt from the contracts' events.

Evidence: [docs/evidence](evidence/README.md#sdk-on-stellar-testnet) (Node run, brand-new-user run,
headless Chromium run, each with testnet transaction links).

## What ships

| Path | What |
|---|---|
| `src/` | TypeScript SDK (`ClearanceClient` for payers, `ClearanceOperator` for operators) |
| `src/wasm/` | Clearance crypto + Groth16 prover (Rust `packages/sdk-wasm`, compiled to WASM) |
| `src/vendor/witness_calculator.js` | circom's witness calculator for the circuit |
| `artifacts/` | `clearance_tx_2_2.wasm`, `.r1cs`, `_proving_key.bin`, `_vk.json`, `SHA256SUMS` |

The proving key's verification key is the one embedded in the deployed verifier
(`deployments/testnet.json` → `verifier`). Rebuild everything with `make sdk-assets`.

## Using it in the frontend (replacing `sdk/mock.ts`)

1. Serve the assets: copy `packages/sdk/artifacts/*` and
   `packages/sdk/src/wasm/clearance_wasm_bg.wasm` into `frontend/public/clearance/`.
2. Add the dependency: `"@clearance/sdk": "workspace:*"` (or a file/tarball reference).
3. Connect once (e.g. in `AppContext`):

```ts
import { ClearanceClient, fetchArtifacts, initCrypto, newIdentitySecret } from "@clearance/sdk";

await initCrypto("/clearance/clearance_wasm_bg.wasm");
const artifacts = await fetchArtifacts("/clearance");      // ~24 MB, cache it
const identitySecret = localStorage.getItem("clr-id") ?? newIdentitySecret();
localStorage.setItem("clr-id", identitySecret);           // the person's identity: same on every device
const client = await ClearanceClient.connect({ wallet, identitySecret, jurisdiction: "NG", artifacts });
```

`wallet` is any `WalletLike` (`getAddress`, `signTransaction`): Freighter / Albedo through
Stellar Wallets Kit already fit.

### Mock → real

| Mock (`frontend/src/sdk/mock.ts`) | Real (`@clearance/sdk`) |
|---|---|
| `connectMock({ network, pool, wallet })` | `ClearanceClient.connect({ wallet, identitySecret, jurisdiction, artifacts })` |
| `client.getTier()` | `client.getTier()`: tier from the on-chain allow-list, or `null` if not KYC'd |
| `client.getBudget()` | `client.getBudget()`: recovered from `budget_step` events |
| `client.getBalance()` | `client.getBalance()`: notes found by decrypting chain events |
| `client.deposit(usd)` | `client.deposit(usd, onProgress?)`: needs a CLRUSD trustline and tokens (below) |
| `client.send({ to, amountUsd, onProgress })` | same. `to` is a `clr:` address (private) or a `G…` address (withdrawal); `toJurisdiction: "GH"` for cross-border |
| `client.requestTierUpgrade()` + `demoApproveUpgrade` | operator issues the tier on-chain: `operator.issueTier({ idCommitment: client.idCommitment, tier })` |
| `mockOperator.getActivePack()` | `operator.getActivePack()` (hash recomputed and checked against the registry) |
| `mockOperator.setPack("NG-v2")` | `operator.publishPack({ utcOffsetSecs, travelRuleThresholdUsd, tiers })`: a real `set_pack`, active immediately |
| `mockOperator.listRecords()` / `openRecord(id)` | `operator.listRecords()` / `operator.openRecord(id)`: from `sealed_record` events, opened with the record key |
| `DEMO_ADA`, `DEMO_CHIDI` | real accounts; receivers share `client.clearanceAddress` |
| `IS_MOCK` | remove |

`onProgress` emits the same steps (`identity`, `perPayment`, `dailyBudget`, `sealed`,
`submitting`, `verified`) with real timings: proving is about 6 s in Chrome; a payment is
about 9 s from click to verified on-chain.

Errors are the same `ClearanceError` codes (`OVER_PER_PAYMENT_LIMIT`, `OVER_DAILY_BUDGET`,
`NOT_IN_ALLOW_LIST`, `INSUFFICIENT_BALANCE`, `WALLET_REJECTED`, `RECORD_KEY_INVALID`), plus two
for chain history (0.1.2): `HISTORY_UNAVAILABLE` (the history needed is past the RPC's 7 days and
the archive could not be reached: show "try again shortly") and `STATE_MISMATCH` (the rebuilt
state did not match the chain: show "refresh"). Nothing is sent in either case.

The RPC keeps only about 7 days of events, so the SDK reads older ones from the event archive
(`TESTNET.archiveUrl`) and checks every tree against the on-chain root. Nothing to do in the UI;
see [architecture/history.md](architecture/history.md).

### Limits: read them, don't hardcode them

`client.getBudget()` returns the tier's `perPaymentLimitUsd` and `dailyLimitUsd` from the active
pack on chain. Display those (converted at the labelled fixed rate). Testnet values
(illustrative, NG-v1): tier 1 18.75 / 31.25 USD, tier 2 625 / 1,250, tier 3 3,125 / 6,250
(per payment / per day).

### Operator console

```ts
import { ClearanceOperator } from "@clearance/sdk";
const operator = await ClearanceOperator.connect({ wallet, jurisdiction: "NG", recordKey });
```

`recordKey` is the operator's Baby JubJub private key (from `gvkey-gen`); it never leaves the
operator's machine. `wallet` must be the jurisdiction admin's account (`clr-ng` on testnet).

### Onboarding a new visitor (public site)

Never ship demo keys in the bundle. Each visitor gets their own funded, KYC'd testnet account
from the onboarding service ([packages/onboarding](../packages/onboarding/README.md)):

```ts
const client = await ClearanceClient.connect({ wallet, identitySecret, jurisdiction: "NG", artifacts });
if (!(await client.getTier())) await client.onboard(ONBOARDING_URL);   // friendbot, trustline, tier 1, 100 CLRUSD
```

`onboard` asks the wallet to sign one trustline, then waits until tier 1 is visible on-chain.
Once per Stellar account.

### Getting test tokens

The pool's token is **CLRUSD**, a testnet test token (not USDC). A new account:
1. `client.addTokenTrustline()` (signed in the user's wallet), then
2. `scripts/fund-demo-account.sh G… 100` (admin mints), then `client.deposit(…)`.

## Running the proofs yourself

```bash
make test-sdk            # typecheck + build
make test-sdk-testnet    # Node: payer + operator flows and a brand-new user, on testnet
make test-sdk-browser    # headless Chromium, in-browser proving, on testnet
```
