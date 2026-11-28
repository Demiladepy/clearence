# Onboarding service (testnet)

Stands in for a licensed app's sign-up and KYC backend, so anyone visiting the demo gets their **own**
real account instead of sharing one set of keys:

1. The visitor's browser creates a Stellar account (friendbot) and a CLRUSD trustline, signed in
   their own wallet.
2. It posts `{ address, idCommitment, jurisdiction }` here.
3. The service has that jurisdiction's operator issue **tier 1 on-chain** (allow-list insert), then
   grants test CLRUSD (admin mint).

The keys live only in this service's environment, never in the browser bundle.

In the frontend, all of that is one call:

```ts
const result = await client.onboard("https://<onboarding-host>/api/onboard");
// { tier: 1, kycTx, mintTx, grantUsd, trustlineTx }, and client.getTier() now returns tier 1
```

## Rules

| Case | Response |
|---|---|
| New account, trustline in place | `200 { tier, kycTx, mintTx, grantUsd }` |
| Account already holds CLRUSD | `409 ALREADY_FUNDED` / `ALREADY_ONBOARDED`: once per Stellar account |
| Account missing or no trustline | `400 NO_TRUSTLINE` |
| Bad address, id commitment or jurisdiction | `400 BAD_ADDRESS` / `BAD_ID_COMMITMENT` / `BAD_JURISDICTION` |
| No operator key for that country | `400 JURISDICTION_NOT_SERVED` |
| More than `CLR_RATE_PER_HOUR` (5) from one IP | `429 RATE_LIMITED` |
| Allow-list within `CLR_ALLOW_LIST_RESERVE` (64) of its 1,024 capacity | `503 ALLOW_LIST_FULL` |

Retries are safe: if the KYC went through but the grant failed, a retry only sends the grant.

## Run

```bash
make onboarding-server      # local, keys from the stellar CLI keystore, http://127.0.0.1:8787
make test-onboarding        # real testnet: new visitor to funded, KYC'd, private deposit; every refusal
```

Environment: `CLR_ADMIN_SECRET`, `CLR_NG_OPERATOR_SECRET`, `CLR_GH_OPERATOR_SECRET` (server-only),
plus optional `CLR_GRANT_USD` (100), `CLR_ALLOWED_ORIGINS` (`*`), `CLR_RATE_PER_HOUR`, `CLEARANCE_RPC`.

## Deploy (Vercel)

Make a new Vercel project from this repo with root directory `packages/onboarding`, and set the three
secrets as environment variables (never `VITE_*`). `vercel.json` installs the workspace, builds the
SDK and ships its WASM with the function. The endpoint is `/api/onboard`.

Not yet verified: the Vercel deploy itself (the local server and the testnet test are).
