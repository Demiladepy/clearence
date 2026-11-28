/**
 * The onboarding service against Stellar testnet: a brand-new visitor goes
 * from nothing to a funded, KYC'd account that can make a private deposit,
 * and the abuse rules hold. Real transactions throughout.
 *
 *   CLEARANCE_RPC=http://127.0.0.1:8000 NODE_USE_ENV_PROXY=1 pnpm test:testnet
 *
 * Uses the CLI identities clr-admin and clr-ng as the service's keys.
 * Writes deployments/onboarding-run.json.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Keypair } from "@stellar/stellar-sdk";
import { ClearanceClient, TESTNET, initCrypto, keypairWallet, newIdentitySecret } from "@clearance/sdk";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../..");
const secret = (alias: string) => execFileSync("stellar", ["keys", "show", alias]).toString().trim();
process.env.CLR_ADMIN_SECRET = secret("clr-admin");
process.env.CLR_NG_OPERATOR_SECRET = secret("clr-ng");
process.env.CLR_GRANT_USD = "100";
process.env.CLR_RATE_PER_HOUR = "100";
const d = { ...TESTNET, rpcUrl: process.env.CLEARANCE_RPC ?? TESTNET.rpcUrl };
const sdkDir = dirname(createRequire(import.meta.url).resolve("@clearance/sdk/wasm"));
const art = (n: string) => new Uint8Array(readFileSync(join(root, "packages/sdk/artifacts", n)));
const artifacts = { circuitWasm: art("clearance_tx_2_2.wasm"), r1cs: art("clearance_tx_2_2.r1cs"), provingKey: art("clearance_tx_2_2_proving_key.bin") };

const post = async (url: string, body: unknown) => {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as Record<string, string> };
};

test("onboarding: new visitor to funded, KYC'd, private deposit; abuse rules hold", { timeout: 20 * 60_000 }, async () => {
  const { handle } = await import("../src/http.js");
  const server = createServer((req, res) => void handle(req, res)).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  try {
    await initCrypto(readFileSync(join(sdkDir, "clearance_wasm_bg.wasm")));

    // A brand-new visitor: a key pair the browser just made, nothing on-chain yet.
    const kp = Keypair.random();
    const visitor = await ClearanceClient.connect({ wallet: keypairWallet(kp.secret()), identitySecret: newIdentitySecret(), jurisdiction: "NG", artifacts, deployment: d });
    assert.equal(await visitor.getTier(), null);

    const t0 = performance.now();
    const out = await visitor.onboard(url);
    const onboardMs = Math.round(performance.now() - t0);
    console.log("onboarded", kp.publicKey(), out, `${onboardMs} ms`);
    assert.deepEqual(await visitor.getTier(), { tier: 1, revoked: false });
    assert.equal(await visitor.getPublicBalance(), 1_000_000_000n);
    assert.ok(out.kycTx && out.mintTx && out.trustlineTx);

    // The account is usable straight away: a real private deposit.
    const dep = await visitor.deposit(10);
    assert.equal((await visitor.getBalance()).shieldedUsd, 10);

    // Abuse rules, each against real chain state.
    const again = await post(url, { address: kp.publicKey(), idCommitment: visitor.idCommitment, jurisdiction: "NG" });
    assert.equal(again.status, 409);
    assert.equal(again.body.error, "ALREADY_ONBOARDED");

    const bare = Keypair.random(); // exists (friendbot) but no trustline
    assert.ok((await fetch(`https://friendbot.stellar.org/?addr=${bare.publicKey()}`)).ok);
    const noTrust = await post(url, { address: bare.publicKey(), idCommitment: "12345", jurisdiction: "NG" });
    assert.equal(noTrust.status, 400);
    assert.equal(noTrust.body.error, "NO_TRUSTLINE");

    assert.equal((await post(url, { address: "GNOTANADDRESS", idCommitment: "1", jurisdiction: "NG" })).body.error, "BAD_ADDRESS");
    assert.equal((await post(url, { address: bare.publicKey(), idCommitment: "0x12", jurisdiction: "NG" })).body.error, "BAD_ID_COMMITMENT");
    assert.equal((await post(url, { address: bare.publicKey(), idCommitment: "1", jurisdiction: "KE" })).body.error, "BAD_JURISDICTION");
    assert.equal((await post(url, { address: bare.publicKey(), idCommitment: "1", jurisdiction: "GH" })).body.error, "JURISDICTION_NOT_SERVED");

    writeFileSync(join(root, "deployments/onboarding-run.json"), JSON.stringify({
      ranAt: new Date().toISOString(), account: kp.publicKey(), onboardMs,
      trustlineTx: out.trustlineTx, kycTx: out.kycTx, mintTx: out.mintTx, depositTx: dep.txHash,
      refused: ["ALREADY_ONBOARDED", "NO_TRUSTLINE", "BAD_ADDRESS", "BAD_ID_COMMITMENT", "BAD_JURISDICTION", "JURISDICTION_NOT_SERVED"],
    }, null, 2) + "\n");
  } finally {
    server.close();
  }
});
