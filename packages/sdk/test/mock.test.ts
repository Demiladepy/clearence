import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Clearance, ClearanceError, Operator, PublicView, ngnToUsd, type ProofStep } from "../src/index.js";
import * as dev from "../src/mock/devtools.js";

const base = { network: "testnet" as const, pool: "CPOOLMOCK" };
let seed: ReturnType<typeof dev.seedDemo>;

beforeEach(() => {
  seed = dev.seedDemo({ crowd: 20 });
  dev.configure({ provingMs: 0, kycAutoApproveMs: 0 });
});

const connect = (addr: string, wallet = dev.mockWallet(addr)) => Clearance.connect({ ...base, wallet });

async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => e instanceof ClearanceError && e.code === code);
}

test("AT-1 shape: Tier 1 send under both limits succeeds, steps tick in order", async () => {
  const ada = await connect(dev.DEMO_ADDRESSES.adaMain);
  const steps: ProofStep[] = [];
  const r = await ada.send({ to: dev.DEMO_ADDRESSES.bola, amountUsd: ngnToUsd(20_000), onProgress: (p) => steps.push(p.step) });
  assert.deepEqual(r.proved, { tier: true, perPayment: true, dailyBudget: true, sealed: true });
  assert.deepEqual(steps, ["identity", "perPayment", "dailyBudget", "sealed", "submitting", "verified"]);
  assert.equal(r.budget.spentTodayUsd, 12.5);
  assert.match(r.explorerUrl, /stellar\.expert/);
});

test("AT-2: over per-payment limit fails at the perPayment step", async () => {
  const ada = await connect(dev.DEMO_ADDRESSES.adaMain);
  const steps: ProofStep[] = [];
  await assert.rejects(
    ada.send({ to: dev.DEMO_ADDRESSES.bola, amountUsd: ngnToUsd(35_000), onProgress: (p) => steps.push(p.step) }),
    (e: unknown) => e instanceof ClearanceError && e.code === "OVER_PER_PAYMENT_LIMIT" && e.context.step === "perPayment",
  );
  assert.deepEqual(steps, ["identity"]);
});

test("AT-3: two wallets, one identity, one budget: the second send fails", async () => {
  const a1 = await connect(dev.DEMO_ADDRESSES.adaMain);
  const a2 = await connect(dev.DEMO_ADDRESSES.adaSecond);
  await a1.send({ to: dev.DEMO_ADDRESSES.bola, amountUsd: ngnToUsd(25_000) });
  await rejects(a2.send({ to: dev.DEMO_ADDRESSES.bola, amountUsd: ngnToUsd(30_000) }), "OVER_DAILY_BUDGET");
  assert.equal((await a2.getBudget()).spentTodayUsd, ngnToUsd(25_000));
});

test("budget resets at the next epoch (UTC day)", async () => {
  const ada = await connect(dev.DEMO_ADDRESSES.adaMain);
  await ada.send({ to: dev.DEMO_ADDRESSES.bola, amountUsd: 18 });
  dev.advanceDays(1);
  assert.equal((await ada.getBudget()).spentTodayUsd, 0);
});

test("AT-4: after upgrade, a wallet holding the old leaf gets TIER_REVOKED until refresh", async () => {
  const a1 = await connect(dev.DEMO_ADDRESSES.adaMain);
  const a2 = await connect(dev.DEMO_ADDRESSES.adaSecond);
  const up = await a1.requestTierUpgrade();
  assert.deepEqual(await up.done, { tier: 2 });
  assert.equal((await a1.getBudget()).tier, 2);
  await rejects(a2.send({ to: dev.DEMO_ADDRESSES.bola, amountUsd: 1 }), "TIER_REVOKED");
  await a2.refresh();
  await a2.send({ to: dev.DEMO_ADDRESSES.bola, amountUsd: 100 }); // now allowed under Tier 2
});

test("unverified wallet: NOT_IN_ALLOW_LIST, then KYC issues Tier 1", async () => {
  const w = await connect(dev.DEMO_ADDRESSES.newUser);
  assert.equal((await w.getIdentity()).status, "unverified");
  await rejects(w.getBudget(), "NOT_IN_ALLOW_LIST");
  const up = await w.requestTierUpgrade();
  assert.match(up.interactiveUrl, /sep24/);
  assert.deepEqual(await up.done, { tier: 1 });
  assert.equal((await w.getIdentity()).status, "active");
});

test("operator can issue a tier manually for a pending KYC", async () => {
  dev.configure({ kycAutoApproveMs: null });
  const w = await connect(dev.DEMO_ADDRESSES.newUser);
  const up = await w.requestTierUpgrade();
  const op = await Operator.connect({ ...base, wallet: dev.mockWallet() });
  const pending = (await op.listIdentities()).find((i) => i.pendingKyc)!;
  await op.issueTier({ idCommitment: pending.idCommitment, tier: 1, displayName: "New User" });
  assert.deepEqual(await up.done, { tier: 1 });
});

test("AT-5: sealed records are same length; only the operator key opens them", async () => {
  const ada = await connect(dev.DEMO_ADDRESSES.adaMain);
  const r = await ada.send({ to: dev.DEMO_ADDRESSES.bola, amountUsd: 10 });
  const op = await Operator.connect({ ...base, wallet: dev.mockWallet() });
  const list = await op.listRecords();
  assert.ok(list.length >= 21);
  assert.equal(new Set(list.map((x) => x.sealedRecordHex.length)).size, 1);
  const mine = list.find((x) => x.txHash === r.txHash)!;
  const opened = await op.openRecord(mine.recordId, seed.operatorKey);
  assert.equal(opened.senderName, "Ada Okafor");
  assert.equal(opened.receiver, "Bola Mensah");
  assert.equal(opened.amountUsd, 10);
  assert.equal(opened.travelRuleFlag, false);
  await rejects(op.openRecord(mine.recordId, "wrong-key"), "RECORD_KEY_INVALID");
});

test("AT-6: switching NG -> GH changes the outcome of the same payment and emits an event", async () => {
  const op = await Operator.connect({ ...base, wallet: dev.mockWallet() });
  const events: string[] = [];
  op.onPackChanged((e) => events.push(e.packId));
  const ada = await connect(dev.DEMO_ADDRESSES.adaMain);
  const amountUsd = ngnToUsd(30_000);
  await ada.send({ to: dev.DEMO_ADDRESSES.bola, amountUsd }); // passes under NG
  dev.advanceDays(1);
  await op.setPack("GH-2026-v1");
  await rejects(ada.send({ to: dev.DEMO_ADDRESSES.bola, amountUsd }), "OVER_PER_PAYMENT_LIMIT");
  assert.deepEqual(events, ["GH-2026-v1"]);
});

test("AT-7: the public view has no amount or counterparty", async () => {
  const ada = await connect(dev.DEMO_ADDRESSES.adaMain);
  const r = await ada.send({ to: dev.DEMO_ADDRESSES.bola, amountUsd: 10 });
  const view = await (await PublicView.connect(base)).getTransfer(r.txHash);
  const json = JSON.stringify(view);
  assert.ok(!("amountUsd" in view) && !("sender" in view) && !("receiver" in view));
  assert.ok(!json.includes(dev.DEMO_ADDRESSES.bola) && !json.includes(seed.ada));
});

test("travel rule flag trips when daily total reaches the threshold", async () => {
  const bola = await connect(dev.DEMO_ADDRESSES.bola);
  await bola.send({ to: dev.DEMO_ADDRESSES.adaMain, amountUsd: 600 });
  await bola.send({ to: dev.DEMO_ADDRESSES.adaMain, amountUsd: 450 });
  const op = await Operator.connect({ ...base, wallet: dev.mockWallet() });
  const [latest, prev] = await op.listRecords();
  assert.equal((await op.openRecord(latest!.recordId, seed.operatorKey)).travelRuleFlag, true);
  assert.equal((await op.openRecord(prev!.recordId, seed.operatorKey)).travelRuleFlag, false);
});

test("WALLET_REJECTED leaves budget and balance untouched", async () => {
  const w = dev.mockWallet(dev.DEMO_ADDRESSES.adaMain);
  const ada = await connect(dev.DEMO_ADDRESSES.adaMain, w);
  w.rejectNext();
  await rejects(ada.send({ to: dev.DEMO_ADDRESSES.bola, amountUsd: 10 }), "WALLET_REJECTED");
  assert.equal((await ada.getBudget()).spentTodayUsd, 0);
  assert.equal((await ada.getBalance()).shieldedUsd, 100);
});

test("PROOF_TIMEOUT and INSUFFICIENT_BALANCE", async () => {
  const ada = await connect(dev.DEMO_ADDRESSES.adaMain);
  await rejects(ada.send({ to: dev.DEMO_ADDRESSES.bola, amountUsd: 101 }), "INSUFFICIENT_BALANCE");
  dev.configure({ provingMs: 20_000, proofTimeoutMs: 15_000 });
  await rejects(ada.send({ to: dev.DEMO_ADDRESSES.bola, amountUsd: 1 }), "PROOF_TIMEOUT");
});
