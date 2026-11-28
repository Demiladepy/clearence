# NG-v2 rule pack: proposal (not published)

Status: **draft for Demilade's decision.** Nothing here is on-chain. NG-v1 (live, marked
`illustrative` in `deployments/testnet.json`) stays active until a v2 is published.

## What CBN says

The primary text found is CBN circular **BPS/DIR/GEN/CIR/04/007** (11 Sep 2017), which revised the
limits on mobile money wallets ([text](https://regalert.today/document/a0f477ca-2958-429b-8148-dba213131d86/text)):

| KYC level | Daily transaction limit | Maximum balance | ID |
|---|---:|---:|---|
| 1 | ₦50,000 | ₦300,000 | no BVN required |
| 2 | ₦200,000 | ₦500,000 | BVN |
| 3 | ₦5,000,000 | unlimited | BVN |

Secondary sources ([BusinessPost](https://businesspost.ng/economy/cbn-reviews-limits-mobile-money-wallets),
[Youverify, 3-tier KYC](https://youverify.co/blog/3-tiered-know-your-client-kyc-requirements)) agree,
and add that BVN and NIN are required above tier 1 from December 2023. A 2026 commentary
([Youverify](https://youverify.co/blog/cbn-kyc-aml-requirements-2026)) quotes different figures
(₦30,000 tier-1 daily) without citing a circular, so it is not used here. The
[CBN Customer Due Diligence Regulations 2023](https://www.CBN.gov.ng/Out/2023/CCD/CBN%20Customer%20Due%20diligence%20Reg.%202023-combined.pdf)
should be checked for anything newer before publishing. **Not verified:** that the 2017 figures are
still the ones in force today, and that they apply to a pool like ours (they are written for mobile
money wallets; banks apply their own tiered-account limits).

## What NG-v1 has, and the gap

At the display rate of ₦1,600 per USD:

| Tier | NG-v1 per payment | NG-v1 daily | CBN daily |
|---|---:|---:|---:|
| 1 | ₦30,000 (18.75 USD) | ₦50,000 (31.25) | ₦50,000 |
| 2 | ₦1,000,000 (625) | ₦2,000,000 (1,250) | ₦200,000 |
| 3 | ₦5,000,000 (3,125) | ₦10,000,000 (6,250) | ₦5,000,000 |

Tier 1 matches CBN. Tiers 2 and 3 allow ten times and twice the CBN daily figure.

## Proposal

| Tier | Per payment | Daily | USD (per / daily) |
|---|---:|---:|---:|
| 1 | ₦30,000 | ₦50,000 | 18.75 / 31.25 (unchanged) |
| 2 | ₦100,000 | ₦200,000 | 62.5 / 125 |
| 3 | ₦2,500,000 | ₦5,000,000 | 1,562.5 / 3,125 |

- The daily figures equal CBN's. The per-payment figures are our own choice (half the daily
  figure), since CBN sets no per-payment cap for wallets.
- Travel-rule threshold and UTC offset unchanged.
- **The demo story still works:** at tier 2, ₦28,000 is under ₦100,000, and ₦25,000 + ₦28,000 =
  ₦53,000 is under ₦200,000. `packages/sdk/test/demo-story.test.ts` asserts the v1 tier-2 limits
  (625 / 1,250) and would need updating at the same time.
- **Not covered by any pack:** CBN's maximum-balance caps (₦300,000 and ₦500,000). The circuit
  limits what you send, not what you hold. Enforcing them needs a balance proof in the circuit; that
  is future work, and the UI should not claim it.
- Peg: the pack is in USD stroops and the naira figure is display-only. If the rate moves, the naira
  limits drift and a new pack is needed. That is a reason to publish NGN-denominated packs once a
  naira stablecoin is the pool asset.

## Publishing (after sign-off)

Coordinate with Michael first: the active pack changes the limits the UI reads (`client.getBudget()`).
Publish from the NG operator account with the SDK:

```ts
await ngOperator.publishPack({
  utcOffsetSecs: 3600,
  travelRuleThresholdUsd: /* unchanged from v1 */,
  tiers: [
    { perPaymentUsd: 18.75, dailyUsd: 31.25 },
    { perPaymentUsd: 62.5, dailyUsd: 125 },
    { perPaymentUsd: 1562.5, dailyUsd: 3125 },
  ],
});
```

Then run `make test-demo-story` with the updated assertions, and regenerate the evidence.
