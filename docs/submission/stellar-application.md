# Stellar application: answers

Facts checked against the repo and testnet on 28 Nov 2026. Each claim has evidence in
[docs/evidence](../evidence/README.md).

## Which Stellar features do you plan to integrate?

- [x] Soroban Smart Contracts
- [x] Payments and Stablecoins
- [x] Zero-knowledge and Confidential tokens
- [ ] Passkeys or smart wallets (not built; we use Freighter and Albedo through Stellar Wallets Kit)
- [ ] Agentic Payments
- Other: `Groth16 proof verification on Soroban (BN254, Poseidon2); per-country compliance rule packs on-chain`

## Link to the Project Repository

https://github.com/Demiladepy/clearence

## Describe your project in one sentence

Clearance lets licensed payment apps in Nigeria and Ghana send private payments on Stellar. Every
payment carries a zero-knowledge proof that it followed the sender's KYC tier limits, and a sealed
record that only the regulated operator can open.

## What problem are you solving?

Licensed payment apps in Nigeria and Ghana can't use a public blockchain for everyday payments: every
transfer shows who paid whom and how much, so competitors can read a business's suppliers, payroll
and cash flow. Privacy tools fix that but remove what the law requires. CBN tier limits (for example
₦50,000 a day for a tier-1 account), the Travel Rule, and the operator's duty to produce records on
request. Today an app has to choose between being private and being compliant. Clearance removes
that choice. The rules are checked by a proof inside each payment, not by revealing the payment.
Across borders, each country's rules apply at the same time: a Lagos to Accra payment must pass
Nigeria's limits, Ghana's limits and an open corridor between the two.

## How will your project use Stellar?

Clearance runs entirely on Stellar. Three Soroban contracts are live on testnet:
1. **Rule registry:** one rule pack per country (tier limits, local day, Travel Rule threshold), the
   corridors between countries, and each country's KYC allow-list, run by that country's operator.
2. **Clearance pool:** holds the token and verifies a Groth16 proof (BN254, Poseidon2) on every
   payment. The proof shows the payer is KYC'd for their tier and stays under the active pack's
   per-payment and daily limits. It also shows the payment carries an encrypted record for each
   operator.
3. **Daily-budget tree:** tracks each person's spend for the day without revealing it.

Payments settle in a Stellar asset through its Stellar Asset Contract (CLRUSD on testnet, built so
USDC can replace it), and deposits and withdrawals are ordinary token transfers. Proofs are made in
the user's browser in about 6 seconds, and a payment is verified on-chain in about 9 seconds at
roughly 1.2 XLM in fees.

Already on testnet:
- Nigerian and Nigeria-to-Ghana payments;
- over-limit payments refused;
- each operator opening only its own records;
- a TypeScript SDK that any Stellar wallet can use.

Next: replace the test token with USDC, KYC through anchors (SEP-12/24), more countries (Kenya,
South Africa), and an audited trusted setup before mainnet.
