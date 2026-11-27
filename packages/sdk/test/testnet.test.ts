/**
 * The SDK against Stellar testnet, from Node. Real transactions, real proofs
 * (WASM prover, deployed proving key), state from contract events.
 *
 *   CLEARANCE_RPC=http://127.0.0.1:8000 NODE_USE_ENV_PROXY=1 pnpm test:testnet
 *
 * Uses the CLI identities clr-ada, clr-kofi (funded, CLRUSD trustline, minted)
 * and clr-ng / clr-gh (operators) with record keys from .secrets/.
 * Writes deployments/sdk-node-run.json.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  ClearanceClient, ClearanceError, ClearanceOperator, TESTNET, initCrypto, keypairWallet, newIdentitySecret,
} from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../..");
const d = { ...TESTNET, rpcUrl: process.env.CLEARANCE_RPC ?? TESTNET.rpcUrl };
const secret = (alias: string) => execFileSync("stellar", ["keys", "show", alias]).toString().trim();
const address = (alias: string) => execFileSync("stellar", ["keys", "address", alias]).toString().trim();
const recordKey = (k: string) => BigInt(JSON.parse(readFileSync(join(root, `.secrets/operator-${k}.json`), "utf8")).privateKey).toString();
const art = (n: string) => new Uint8Array(readFileSync(join(here, "../artifacts", n)));
const artifacts = { circuitWasm: art("clearance_tx_2_2.wasm"), r1cs: art("clearance_tx_2_2.r1cs"), provingKey: art("clearance_tx_2_2_proving_key.bin") };

test("payer and operator SDK on testnet", { timeout: 30 * 60_000 }, async () => {
  await initCrypto(readFileSync(join(here, "../src/wasm/clearance_wasm_bg.wasm")));
  const log: Record<string, unknown>[] = [];
  const t = () => performance.now();

  const ng = await ClearanceOperator.connect({ wallet: keypairWallet(secret("clr-ng")), jurisdiction: "NG", recordKey: recordKey("ng"), deployment: d });
  const gh = await ClearanceOperator.connect({ wallet: keypairWallet(secret("clr-gh")), jurisdiction: "GH", recordKey: recordKey("gh"), deployment: d });
  assert.equal((await ng.getActivePack()).hash, JSON.parse(readFileSync(join(root, "deployments/testnet.json"), "utf8")).jurisdictions["566"].packHash);

  const ada = await ClearanceClient.connect({ wallet: keypairWallet(secret("clr-ada")), identitySecret: newIdentitySecret(), jurisdiction: "NG", artifacts, deployment: d });
  const kofi = await ClearanceClient.connect({ wallet: keypairWallet(secret("clr-kofi")), identitySecret: newIdentitySecret(), jurisdiction: "GH", artifacts, deployment: d });
  const bob = await ClearanceClient.connect({ wallet: keypairWallet(secret("clr-bob")), identitySecret: newIdentitySecret(), jurisdiction: "NG", artifacts, deployment: d });

  // Not KYC'd yet: refused before any transaction.
  assert.equal(await ada.getTier(), null);
  await assert.rejects(ada.deposit(1), (e) => e instanceof ClearanceError && e.code === "NOT_IN_ALLOW_LIST");

  // Operators issue tier 1.
  log.push({ step: "NG operator issues Ada tier 1", tx: (await ng.issueTier({ idCommitment: ada.idCommitment, tier: 1 })).txHash });
  log.push({ step: "GH operator issues Kofi tier 1", tx: (await gh.issueTier({ idCommitment: kofi.idCommitment, tier: 1 })).txHash });
  assert.deepEqual(await ada.getTier(), { tier: 1, revoked: false });

  const run = async (step: string, f: () => Promise<{ txHash: string; provingMs: number; explorerUrl: string }>) => {
    const t0 = t();
    const r = await f();
    log.push({ step, tx: r.txHash, explorer: r.explorerUrl, provingMs: r.provingMs, totalMs: Math.round(t() - t0) });
    console.log(step, r.txHash, `proving ${r.provingMs} ms`);
    return r;
  };

  await run("Ada deposits 25", () => ada.deposit(25));
  assert.equal((await ada.getBalance()).shieldedUsd, 25);
  assert.equal((await ada.getBudget()).spentTodayUsd, 0);

  await run("Ada pays Bob 15 (NG -> NG)", () => ada.send({ to: bob.clearanceAddress, amountUsd: 15 }));
  await run("Ada pays Kofi 3 (NG -> GH)", () => ada.send({ to: kofi.clearanceAddress, toJurisdiction: "GH", amountUsd: 3 }));
  assert.equal((await ada.getBalance()).shieldedUsd, 7);
  assert.equal((await bob.getBalance()).shieldedUsd, 15, "Bob found his note from the chain");
  assert.equal((await kofi.getBalance()).shieldedUsd, 3, "Kofi found his note from the chain");
  const budget = await ada.getBudget();
  assert.equal(budget.spentTodayUsd, 18);
  assert.equal(budget.dailyLimitUsd, 31.25);

  // Over the daily budget: refused, nothing sent.
  await assert.rejects(ada.send({ to: bob.clearanceAddress, amountUsd: 14 }), (e) => e instanceof ClearanceError && e.code === "OVER_DAILY_BUDGET");
  // Over GH's per-payment limit (15) for Kofi's tier 1.
  await assert.rejects(kofi.send({ to: ada.clearanceAddress, toJurisdiction: "NG", amountUsd: 16 }), (e) => e instanceof ClearanceError && e.code === "OVER_PER_PAYMENT_LIMIT");

  // Kofi withdraws his 3 to his Stellar account.
  await run("Kofi withdraws 3 (GH)", () => kofi.send({ to: address("clr-kofi"), amountUsd: 3 }));
  assert.equal((await kofi.getBalance()).shieldedUsd, 0);

  // Operators: each opens its own copies, and only those.
  const ngRecords = await ng.listRecords();
  const ghRecords = await gh.listRecords();
  const opened: Record<string, unknown>[] = [];
  for (const step of log.filter((l) => String(l.step).startsWith("Ada pays") || String(l.step).startsWith("Kofi withdraws"))) {
    const tx = String(step.tx);
    const forNg = ngRecords.find((r) => r.txHash === tx);
    const forGh = ghRecords.find((r) => r.txHash === tx);
    if (forNg) opened.push({ tx, by: "NG", ...(await ng.openRecord(forNg.recordId)) });
    if (forGh) opened.push({ tx, by: "GH", ...(await gh.openRecord(forGh.recordId)) });
  }
  const amounts = opened.map((o) => `${o.by}:${o.amountUsd}`).sort();
  assert.deepEqual(amounts, ["GH:3", "GH:3", "NG:15", "NG:3"].sort());
  for (const o of opened) {
    if (o.by === "NG") assert.equal(o.sender, ada.idCommitment);
  }
  const domestic = ngRecords.find((r) => r.txHash === log.find((l) => l.step === "Ada pays Bob 15 (NG -> NG)")!.tx);
  assert.ok(domestic && !ghRecords.some((r) => r.recordId === domestic.recordId), "GH holds no copy of a Nigerian domestic payment");

  writeFileSync(join(root, "deployments/sdk-node-run.json"), JSON.stringify({ ranAt: new Date().toISOString(), pool: d.pool, steps: log, openedByOperators: opened }, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");
});

test("a brand-new user: trustline, funding, KYC, first deposit", { timeout: 15 * 60_000 }, async () => {
  await initCrypto(readFileSync(join(here, "../src/wasm/clearance_wasm_bg.wasm")));
  const { Keypair } = await import("@stellar/stellar-sdk");
  const kp = Keypair.random();
  const fb = await fetch(`https://friendbot.stellar.org/?addr=${kp.publicKey()}`);
  assert.ok(fb.ok, `friendbot ${fb.status}`);
  const user = await ClearanceClient.connect({ wallet: keypairWallet(kp.secret()), identitySecret: newIdentitySecret(), jurisdiction: "NG", artifacts, deployment: d });
  const trust = await user.addTokenTrustline();
  execFileSync(join(root, "scripts/fund-demo-account.sh"), [kp.publicKey(), "20"]);
  assert.equal(await user.getPublicBalance(), 200_000_000n);
  const ng = await ClearanceOperator.connect({ wallet: keypairWallet(secret("clr-ng")), jurisdiction: "NG", recordKey: recordKey("ng"), deployment: d });
  const kyc = await ng.issueTier({ idCommitment: user.idCommitment, tier: 1 });
  const dep = await user.deposit(5);
  assert.equal(await user.getPublicBalance(), 150_000_000n, "5 left the public balance");
  assert.equal((await user.getBalance()).shieldedUsd, 5, "and arrived in the private balance");
  writeFileSync(join(root, "deployments/sdk-new-user-run.json"), JSON.stringify({ ranAt: new Date().toISOString(), account: kp.publicKey(), trustlineTx: trust.txHash, kycTx: kyc.txHash, depositTx: dep.txHash, provingMs: dep.provingMs }, null, 2) + "\n");
});
