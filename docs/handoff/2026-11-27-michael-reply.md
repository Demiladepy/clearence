Michael,

Answers to your five points.

**1. Pool contract and network settings**

| | |
|---|---|
| Network | Stellar testnet |
| RPC | `https://soroban-testnet.stellar.org` |
| Passphrase | `Test SDF Network ; September 2015` |
| Pool | `CA2DGBLA6H2Q6W4JOHOT2UGXEWIJVQSNFDB2GN3PQSZRUNEBDNJOTIQE` |
| Rule registry | `CAA62XQJRNFBMAATZX7KQX7K66BJZCPUJXMPSCE4ZRXELFC3KCAPFEQV` |
| Token (CLRUSD, test token, not USDC) | `CCXZ5OWSDPXDGL7CAN7CDYVATYPSHXDTRZAWQLWGT3I4QZ62F3MRIRZ3` |

You don't need to type any of these: the SDK exports them as `TESTNET` and uses them by default.
The full list (verifier, budget tree, allow-lists, operators) is in `deployments/testnet.json`.

**2. Installing the SDK**

Package name `@clearance/sdk`, at `packages/sdk` on `main` of github.com/Demiladepy/clearence.
It is not on npm. From the repo root:

```bash
cd packages/sdk && pnpm install && pnpm build
```

Then in `frontend/package.json`: `"@clearance/sdk": "file:../packages/sdk"` and `pnpm install`.
Copy `packages/sdk/artifacts/*` and `packages/sdk/dist/wasm/clearance_wasm_bg.wasm` into
`frontend/public/clearance/`. The connect code and the mock-to-real table are in `docs/sdk.md`.

**3. What's live right now**

- `getBudget()`: live. It reads the tier's limits from the active pack and today's spend from the chain.
- `getBalance()`: live. It finds your notes by decrypting the pool's events.
- `deposit()`: live. It needs a CLRUSD trustline (`addTokenTrustline()`) and tokens.
- `send()`: live, for NG to NG, NG to GH (`toJurisdiction: "GH"`) and withdrawal to a `G...` address. GH to NG is not open yet: only the NG to GH corridor is.
- `requestTierUpgrade()`: **removed**, not live. A tier is the operator calling `operator.issueTier(...)` on-chain from the console; the user then sees it through `getTier()`. Please wire the console's approve button to `issueTier`.
- Also live: `getTier()`, `addTokenTrustline()`, and the operator's `getActivePack()`, `publishPack()`, `listRecords()` and `openRecord()`.

**4. Funded demo accounts** (set up today, everything on-chain)

| | Ada (demo), NG payer | Kofi (demo), GH receiver |
|---|---|---|
| Stellar address | `GAW66MEJJNB5NTAGMJG6X4AXZYL6H2CUAYLFHIRKTT7FIZM4DPXXU6XH` | `GAMZFEK5HRKJMAMJO244ROOE3MFNLYR5GS357E4ZVPBXYUFK2NL37GLC` |
| KYC | NG tier 1, issued on-chain | GH tier 1, issued on-chain |
| Public CLRUSD | 180 | 20 |
| Private balance (in the pool) | 20 | 0 |
| Limits | $18.75 per payment, $31.25 per day | $15 per payment, $25 per day |

Each account has two secrets, which I'm sending separately:
- **Stellar secret key:** import it into Freighter, switched to testnet.
- **Clearance identity secret:** put it in `localStorage["clr-id"]` before connecting. It is what makes the 20 already in the pool show up as Ada's balance.

The transaction links for the set-up are in `docs/evidence/README.md` under "Frontend demo accounts". Ada can pay Kofi up to $18.75 a payment and $31.25 a day. To get a fresh pair, I run `make demo-accounts`.

**5. NG-v2 and the tier 2/3 limits**

NG-v2 publish: **[DATE AND TIME]**. Your console's publish button does it (`operator.publishPack`), and the pack is active from that transaction.

Tier 2/3 per-payment limits, live on-chain now. Read them from `getBudget()` rather than hardcoding:

| | Per payment | Per day |
|---|---|---|
| NG tier 2 | $625 (₦1,000,000) | $1,250 (₦2,000,000) |
| NG tier 3 | $3,125 (₦5,000,000) | $6,250 (₦10,000,000) |
| GH tier 2 | $500 | $1,000 |
| GH tier 3 | $2,500 | $5,000 |

These are the NG-v1 and GH-v1 figures, which are illustrative. If NG-v2 changes them, `getBudget()` picks the new ones up with no code change.

Demilade
