/**
 * Provision the funded testnet demo accounts for the frontend: real accounts,
 * real KYC, real tokens. Nothing simulated.
 *
 *   CLEARANCE_RPC=http://127.0.0.1:8000 NODE_USE_ENV_PROXY=1 npx tsx test/provision-demo.ts
 *
 * Creates:
 *   - "Ada (demo)", NG payer: XLM from friendbot, CLRUSD trustline, 200 CLRUSD,
 *     NG tier 1 issued on-chain, 20 USD already deposited into the pool.
 *   - "Kofi (demo)", GH receiver: XLM, CLRUSD trustline, 20 CLRUSD, GH tier 1.
 * Secrets (Stellar secret key + Clearance identity secret) go to
 * .secrets/demo-accounts.json (gitignored). Public data and the transaction
 * hashes go to deployments/demo-accounts.json.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Keypair } from "@stellar/stellar-sdk";
import {
  ClearanceClient, ClearanceOperator, TESTNET, initCrypto, keypairWallet, newIdentitySecret,
} from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../..");
const d = { ...TESTNET, rpcUrl: process.env.CLEARANCE_RPC ?? TESTNET.rpcUrl };
const secret = (alias: string) => execFileSync("stellar", ["keys", "show", alias]).toString().trim();
const recordKey = (k: string) => BigInt(JSON.parse(readFileSync(join(root, `.secrets/operator-${k}.json`), "utf8")).privateKey).toString();
const art = (n: string) => new Uint8Array(readFileSync(join(here, "../artifacts", n)));
const artifacts = { circuitWasm: art("clearance_tx_2_2.wasm"), r1cs: art("clearance_tx_2_2.r1cs"), provingKey: art("clearance_tx_2_2_proving_key.bin") };
const tx = (h: string) => ({ tx: h, explorer: `https://stellar.expert/explorer/testnet/tx/${h}` });

async function account(name: string, jurisdiction: "NG" | "GH", mintUsd: number, op: ClearanceOperator) {
  const kp = Keypair.random();
  const fb = await fetch(`https://friendbot.stellar.org/?addr=${kp.publicKey()}`);
  assert.ok(fb.ok, `friendbot ${fb.status}`);
  const identitySecret = newIdentitySecret();
  saveSecret({ name, jurisdiction, stellarAddress: kp.publicKey(), stellarSecret: kp.secret(), identitySecret });
  const client = await ClearanceClient.connect({ wallet: keypairWallet(kp.secret()), identitySecret, jurisdiction, artifacts, deployment: d });
  const trust = await client.addTokenTrustline();
  execFileSync(join(root, "scripts/fund-demo-account.sh"), [kp.publicKey(), String(mintUsd)]);
  const kyc = await op.issueTier({ idCommitment: client.idCommitment, tier: 1 });
  assert.deepEqual(await client.getTier(), { tier: 1, revoked: false });
  console.log(name, kp.publicKey(), "trustline", trust.txHash, "kyc", kyc.txHash);
  return { name, jurisdiction, kp, identitySecret, client, steps: { trustline: tx(trust.txHash), kyc: tx(kyc.txHash) } as Record<string, unknown> };
}

const secrets: Record<string, string>[] = [];
function saveSecret(x: Record<string, string>) {
  secrets.push(x);
  mkdirSync(join(root, ".secrets"), { recursive: true });
  writeFileSync(join(root, ".secrets/demo-accounts.json"), JSON.stringify(secrets, null, 2) + "\n");
}

await initCrypto(readFileSync(join(here, "../src/wasm/clearance_wasm_bg.wasm")));
const ng = await ClearanceOperator.connect({ wallet: keypairWallet(secret("clr-ng")), jurisdiction: "NG", recordKey: recordKey("ng"), deployment: d });
const gh = await ClearanceOperator.connect({ wallet: keypairWallet(secret("clr-gh")), jurisdiction: "GH", recordKey: recordKey("gh"), deployment: d });

const ada = await account("Ada (demo)", "NG", 200, ng);
const kofi = await account("Kofi (demo)", "GH", 20, gh);

const dep = await ada.client.deposit(20);
ada.steps.deposit20 = { ...tx(dep.txHash), provingMs: dep.provingMs };
assert.equal((await ada.client.getBalance()).shieldedUsd, 20);

const out = [];
for (const a of [ada, kofi]) {
  const budget = await a.client.getBudget();
  const state = {
    name: a.name,
    jurisdiction: a.jurisdiction,
    stellarAddress: a.kp.publicKey(),
    clearanceAddress: a.client.clearanceAddress,
    tier: (await a.client.getTier())?.tier,
    publicClrusd: Number(await a.client.getPublicBalance()) / 1e7,
    privateBalanceUsd: (await a.client.getBalance()).shieldedUsd,
    budget,
    steps: a.steps,
  };
  console.log(JSON.stringify(state, null, 2));
  out.push(state);
}

writeFileSync(join(root, "deployments/demo-accounts.json"), JSON.stringify({ ranAt: new Date().toISOString(), accounts: out }, null, 2) + "\n");
