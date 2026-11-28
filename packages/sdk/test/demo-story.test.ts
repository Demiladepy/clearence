/**
 * The exact demo story the frontend presents, run on Stellar testnet with
 * fresh accounts, so the demo is known to work before anyone records it:
 *
 *   fund -> send NGN 25,000 (cleared) -> NGN 28,000 refused by the daily budget
 *   -> operator issues tier 2 -> NGN 28,000 again (cleared) -> the NG operator
 *   opens the sealed record of that payment.
 *
 *   CLEARANCE_RPC=http://127.0.0.1:8000 NODE_USE_ENV_PROXY=1 npx tsx --test test/demo-story.test.ts
 *
 * Writes deployments/demo-story-run.json.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Keypair } from "@stellar/stellar-sdk";
import {
  ClearanceClient, ClearanceError, ClearanceOperator, TESTNET, initCrypto, keypairWallet, newIdentitySecret,
} from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../..");
const d = { ...TESTNET, rpcUrl: process.env.CLEARANCE_RPC ?? TESTNET.rpcUrl };
const secret = (alias: string) => execFileSync("stellar", ["keys", "show", alias]).toString().trim();
const recordKey = (k: string) => BigInt(JSON.parse(readFileSync(join(root, `.secrets/operator-${k}.json`), "utf8")).privateKey).toString();
const art = (n: string) => new Uint8Array(readFileSync(join(here, "../artifacts", n)));
const artifacts = { circuitWasm: art("clearance_tx_2_2.wasm"), r1cs: art("clearance_tx_2_2.r1cs"), provingKey: art("clearance_tx_2_2_proving_key.bin") };
const RATE = 1600; // display rate, NGN per USD (labelled in the UI, never on-chain)
const ngn = (n: number) => n / RATE;

async function freshUser(op: ClearanceOperator, mintUsd: number) {
  const kp = Keypair.random();
  assert.ok((await fetch(`https://friendbot.stellar.org/?addr=${kp.publicKey()}`)).ok, "friendbot");
  const user = await ClearanceClient.connect({ wallet: keypairWallet(kp.secret()), identitySecret: newIdentitySecret(), jurisdiction: "NG", artifacts, deployment: d });
  await user.addTokenTrustline();
  if (mintUsd > 0) execFileSync(join(root, "scripts/fund-demo-account.sh"), [kp.publicKey(), String(mintUsd)], { stdio: "ignore" });
  await op.issueTier({ idCommitment: user.idCommitment, tier: 1 });
  return { kp, user };
}

test("demo story: fund, 25k cleared, 28k refused, tier 2, 28k cleared, record opened", { timeout: 30 * 60_000 }, async () => {
  await initCrypto(readFileSync(join(here, "../src/wasm/clearance_wasm_bg.wasm")));
  const ng = await ClearanceOperator.connect({ wallet: keypairWallet(secret("clr-ng")), jurisdiction: "NG", recordKey: recordKey("ng"), deployment: d });
  const log: Record<string, unknown>[] = [];
  const step = (s: string, r: { txHash?: string; provingMs?: number } = {}) => {
    log.push({ step: s, ...(r.txHash ? { tx: r.txHash } : {}), ...(r.provingMs ? { provingMs: r.provingMs } : {}) });
    console.log(s, r.txHash ?? "", r.provingMs ? `${r.provingMs} ms` : "");
  };

  const { kp: adaKp, user: ada } = await freshUser(ng, 100);
  const { user: bob } = await freshUser(ng, 0);
  step(`Ada ${adaKp.publicKey()} and Bob created, NG tier 1`);

  // 1. Fund: NGN 60,000 into the pool (a deposit is not a payment, so tier 1 allows it).
  step("Ada funds NGN 60,000", await ada.deposit(ngn(60_000)));
  assert.equal((await ada.getBalance()).shieldedUsd, ngn(60_000));

  // 2. NGN 25,000 to Bob: within NGN 30,000 per payment and NGN 50,000 a day.
  step("Ada sends NGN 25,000 to Bob", await ada.send({ to: bob.clearanceAddress, amountUsd: ngn(25_000) }));
  const b1 = await ada.getBudget();
  assert.equal(b1.spentTodayUsd, ngn(25_000));
  assert.equal(b1.dailyLimitUsd, ngn(50_000));

  // 3. NGN 28,000: under the per-payment limit, over what is left today (25k + 28k > 50k).
  await assert.rejects(ada.send({ to: bob.clearanceAddress, amountUsd: ngn(28_000) }),
    (e) => e instanceof ClearanceError && e.code === "OVER_DAILY_BUDGET");
  step("NGN 28,000 refused: OVER_DAILY_BUDGET (no transaction)");

  // 4. The operator issues tier 2 on-chain.
  step("NG operator issues Ada tier 2", await ng.issueTier({ idCommitment: ada.idCommitment, tier: 2 }));
  assert.deepEqual(await ada.getTier(), { tier: 2, revoked: false });
  const b2 = await ada.getBudget();
  assert.equal(b2.tier, 2);
  assert.equal(b2.perPaymentLimitUsd, 625);
  assert.equal(b2.dailyLimitUsd, 1250);
  assert.equal(b2.spentTodayUsd, ngn(25_000), "today's spend carries over the upgrade");

  // 5. NGN 28,000 again: cleared.
  const last = await ada.send({ to: bob.clearanceAddress, amountUsd: ngn(28_000) });
  step("Ada sends NGN 28,000 again (tier 2)", last);
  assert.equal((await ada.getBudget()).spentTodayUsd, ngn(53_000));
  assert.equal((await bob.getBalance()).shieldedUsd, ngn(53_000), "Bob found both payments on-chain");

  // 6. The NG operator opens that payment's sealed record.
  const rec = (await ng.listRecords()).find((r) => r.txHash === last.txHash);
  assert.ok(rec, "record of the last payment listed");
  const opened = await ng.openRecord(rec.recordId);
  assert.equal(opened.sender, ada.idCommitment);
  assert.equal(opened.amountUsd, ngn(28_000));
  assert.equal(opened.senderJurisdiction, "NG");
  step(`NG operator opens record ${rec.recordId}: sender = Ada, NGN 28,000`);

  writeFileSync(join(root, "deployments/demo-story-run.json"), JSON.stringify({ ranAt: new Date().toISOString(), ada: adaKp.publicKey(), steps: log }, null, 2) + "\n");
});
