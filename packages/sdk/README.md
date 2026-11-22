# @clearance/sdk (mock)

The SDK the UI builds against. **This is the mock**: the signatures match the PRD, and the real SDK
replaces the implementation behind these exports later, so UI code does not change.

```ts
import { Clearance, Operator, PublicView, ClearanceError, formatNgn, ngnToUsd } from "@clearance/sdk";
import * as dev from "@clearance/sdk/devtools"; // mock-only: demo data, time travel

const { addresses, operatorKey } = dev.seedDemo();          // Ada, Bola, 24 crowd transfers
const wallet = dev.mockWallet(addresses.adaMain);           // or a Stellar Wallets Kit wallet

const clearance = await Clearance.connect({ network: "testnet", pool: "CPOOL...", wallet });
await clearance.deposit(50);
const receipt = await clearance.send({
  to: addresses.bola,
  amountUsd: ngnToUsd(20_000),
  onProgress: ({ step }) => panel.tick(step), // identity → perPayment → dailyBudget → sealed → submitting → verified
});
const budget = await clearance.getBudget(); // { tier, spentTodayUsd, dailyLimitUsd, perPaymentLimitUsd, resetsAt }
const { interactiveUrl, done } = await clearance.requestTierUpgrade(); // open URL, then await done

const operator = await Operator.connect({ network: "testnet", pool: "CPOOL...", wallet });
const records = await operator.listRecords();
const opened = await operator.openRecord(records[0].recordId, operatorKey);
await operator.setPack("GH-2026-v1");

const pub = await PublicView.connect({ network: "testnet", pool: "CPOOL..." });
const seen = await pub.getTransfer(receipt.txHash); // what stellar.expert shows: no amount, no parties
```

## Things the PRD sketch didn't spell out

These were added because the screens need them:

| Addition | Why |
|---|---|
| `send({ onProgress })` | Drives the proof-panel animation, one tick per check |
| `ClearanceError.context.step` | Which check failed, so the panel stops on that line |
| `getBalance()`, `getIdentity()`, `refresh()`, `getActivePack()`, `onPackChanged()` | Balance, tier badge, empty and revoked states, pack label |
| `Operator.issueTier()`, `listIdentities()` | Tier-issuance panel in the console |
| `PublicView.getTransfer()` | FR-9 public view |
| `requestTierUpgrade()` returns `{ interactiveUrl, done }` | The UI opens the SEP-24 popup itself |

## Errors

Every failure is a `ClearanceError` with `code`, `userMessage` (ready to show) and `context`
(`limitLocal`, e.g. "₦50,000", `remainingUsd`, `step`).

`OVER_PER_PAYMENT_LIMIT` · `OVER_DAILY_BUDGET` · `NOT_IN_ALLOW_LIST` · `TIER_REVOKED` ·
`PROOF_TIMEOUT` · `WALLET_REJECTED` · `INSUFFICIENT_BALANCE` · `RECORD_KEY_INVALID`

## Producing every screen state

| State | How |
|---|---|
| Empty / unverified | connect `addresses.newUser` |
| Proving (2–10 s) | `dev.configure({ provingMs: 6000 })` (default 3500) |
| Over per-payment | Ada sends more than ₦30,000 |
| Over daily budget | Ada sends ₦25,000 from `adaMain`, then ₦30,000 from `adaSecond` (same person, two wallets) |
| Tier revoked | upgrade from one of Ada's wallets, then send from the other without `refresh()` |
| Wallet rejected | `wallet.rejectNext()` |
| Proof timeout | `dev.configure({ provingMs: 20000 })` |
| Budget reset | `dev.advanceDays(1)` |
| NG → GH switch | `operator.setPack("GH-2026-v1")`: ₦30,000 passes in NG and fails in GH |
| Manual KYC approval | `dev.configure({ kycAutoApproveMs: null })`, then `operator.issueTier(...)` |

## Demo numbers (NG-2026-v1, display rate ₦1,600/USD, labelled fixed)

| Tier | Per payment | Daily |
|---|---|---|
| 1 | ₦30,000 ($18.75) | ₦50,000 ($31.25) |
| 2 | ₦1,000,000 ($625) | ₦2,000,000 ($1,250) |
| 3 | ₦5,000,000 ($3,125) | ₦10,000,000 ($6,250) |

Ghana (GH-2026-v1) numbers are **illustrative**. Travel Rule threshold: USD 1,000.

```bash
pnpm install && pnpm --filter @clearance/sdk test
```
