/**
 * Payments keep working after the RPC has dropped the pool's early events
 * (~7 days on testnet), using the event archive, and a wrong archive is
 * caught by the on-chain root check.
 *
 * Today the public RPC still holds every event since the deployment, so this
 * test puts a relay in front of it that behaves like the RPC after 4 Dec: it
 * refuses getEvents before a cutoff ledger (with the RPC's own error) and
 * reports that cutoff as oldestLedger. Everything else is forwarded to the
 * real testnet RPC; the contracts, proofs and transactions are real.
 *
 *   CLEARANCE_RPC=http://127.0.0.1:8000 NODE_USE_ENV_PROXY=1 npx tsx --test test/history.test.ts
 *
 * Writes deployments/history-run.json.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Keypair, xdr, nativeToScVal, scValToNative } from "@stellar/stellar-sdk";
import {
  Chain, ClearanceClient, ClearanceError, ClearanceOperator, TESTNET, initCrypto, keypairWallet, newIdentitySecret, poolState, treeLeaves,
  type EventArchive,
} from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../..");
const UPSTREAM = process.env.CLEARANCE_RPC ?? TESTNET.rpcUrl;
const d = { ...TESTNET, rpcUrl: UPSTREAM, archiveUrl: undefined };
const secret = (alias: string) => execFileSync("stellar", ["keys", "show", alias]).toString().trim();
const art = (n: string) => new Uint8Array(readFileSync(join(here, "../artifacts", n)));
const artifacts = { circuitWasm: art("clearance_tx_2_2.wasm"), r1cs: art("clearance_tx_2_2.r1cs"), provingKey: art("clearance_tx_2_2_proving_key.bin") };
const servers: Server[] = [];
const listen = async (s: Server) => {
  servers.push(s);
  s.keepAliveTimeout = 65_000; // outlive clients' idle sockets (proving takes a while)
  s.listen(0, "127.0.0.1");
  await new Promise((r) => s.once("listening", r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
};
const isCode = (code: string) => (e: unknown) => e instanceof ClearanceError && e.code === code;

/** The RPC as it will be once the deployment's first ledgers are past retention. */
function retentionRelay(cutoff: number): Server {
  return createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    const reply = (o: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(o));
    };
    const fwd = async () =>
      (await fetch(UPSTREAM, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json() as Promise<{ result?: Record<string, unknown> }>;
    if (body.method === "getEvents" && body.params?.startLedger !== undefined && body.params.startLedger < cutoff) {
      const latest = (await (await fetch(UPSTREAM, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getLatestLedger" }) })).json()).result.sequence;
      return reply({ jsonrpc: "2.0", id: body.id, error: { code: -32600, message: `startLedger must be between the oldest ledger: ${cutoff} and the latest ledger: ${latest}` } });
    }
    const out = await fwd();
    if (body.method === "getHealth" && out.result) out.result.oldestLedger = cutoff;
    reply(out);
  });
}

function fileServer(files: Record<string, string>): Server {
  return createServer((req, res) => {
    const f = files[req.url ?? ""];
    res.writeHead(f ? 200 : 404, { "content-type": "application/json" });
    res.end(f ?? "{}");
  });
}

/** Rewrite one field of an event's data map (keeps the XDR types of everything else). */
function setField(valueB64: string, key: string, v: xdr.ScVal): string {
  // stellar-sdk 17's XDR values expose union arms as properties.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const entries = (xdr.ScVal.fromXDR(valueB64, "base64") as any).map as { key: xdr.ScVal; val: xdr.ScVal }[];
  const out = entries.map((e) => new xdr.ScMapEntry({ key: e.key, val: scValToNative(e.key) === key ? v : e.val }));
  return xdr.ScVal.scvMap(out).toXDR("base64");
}

test("history: archive + RPC tail rebuilds state past retention; payments work; a wrong archive is refused", { timeout: 30 * 60_000 }, async () => {
  await initCrypto(readFileSync(join(here, "../src/wasm/clearance_wasm_bg.wasm")));
  try {
    // 1. The archive as the scheduled job writes it, from the real RPC.
    const dir = mkdtempSync(join(tmpdir(), "clr-archive-"));
    const archivePath = join(dir, "events.json");
    execFileSync("node", [join(root, "scripts/archive-events.mjs"), archivePath], { stdio: "inherit", env: { ...process.env, CLEARANCE_RPC: UPSTREAM } });
    const archive = JSON.parse(readFileSync(archivePath, "utf8")) as EventArchive;
    assert.ok(archive.events.length > 0);

    // 2. A new user, KYC'd and funded after the archive was taken (so their
    //    events exist only in the RPC's tail, and everyone else's only in the archive).
    const recordKey = BigInt(JSON.parse(readFileSync(join(root, ".secrets/operator-ng.json"), "utf8")).privateKey).toString();
    const ng = await ClearanceOperator.connect({ wallet: keypairWallet(secret("clr-ng")), jurisdiction: "NG", recordKey, deployment: d });
    const kp = Keypair.random();
    assert.ok((await fetch(`https://friendbot.stellar.org/?addr=${kp.publicKey()}`)).ok, "friendbot");
    const idSecret = newIdentitySecret();
    const setup = await ClearanceClient.connect({ wallet: keypairWallet(kp.secret()), identitySecret: idSecret, jurisdiction: "NG", artifacts, deployment: d });
    await setup.addTokenTrustline();
    execFileSync(join(root, "scripts/fund-demo-account.sh"), [kp.publicKey(), "20"], { stdio: "ignore" });
    await ng.issueTier({ idCommitment: setup.idCommitment, tier: 1 });

    // 3. The RPC from now on forgets everything before the archive's last ledgers.
    const cutoff = archive.toLedger - 20;
    assert.ok(cutoff > archive.startLedger + 1000, "the cutoff hides real history");
    const rpcUrl = await listen(retentionRelay(cutoff));
    const tampered = structuredClone(archive);
    const ngList = d.allowLists[566]!;
    const leafEv = tampered.events.find((e) => e.contractId === ngList)!;
    leafEv.value = setField(leafEv.value, "leaf", nativeToScVal(12345n, { type: "u256" }));
    const swapped = structuredClone(archive);
    const commits = swapped.events.filter((e) => e.contractId === d.pool && scValToNative(xdr.ScVal.fromXDR(e.topic[0]!, "base64")) === "new_commitment_event");
    assert.ok(commits.length >= 2);
    [commits[0]!.topic[1], commits[1]!.topic[1]] = [commits[1]!.topic[1]!, commits[0]!.topic[1]!];
    const files = await listen(fileServer({
      "/events.json": readFileSync(archivePath, "utf8"),
      "/tampered.json": JSON.stringify(tampered),
      "/swapped.json": JSON.stringify(swapped),
    }));

    const late = { ...d, rpcUrl };
    const withArchive = { ...late, archiveUrl: `${files}/events.json` };

    // Without the archive the history really is gone.
    await assert.rejects(new Chain(late).events([d.pool]), isCode("HISTORY_UNAVAILABLE"));
    const noArchive = await ClearanceClient.connect({ wallet: keypairWallet(kp.secret()), identitySecret: idSecret, jurisdiction: "NG", artifacts, deployment: late });
    await assert.rejects(noArchive.getBalance(), isCode("HISTORY_UNAVAILABLE"));

    // With it: the same state the full RPC gives, every tree checked against its root.
    const full = await poolState(new Chain(d), d);
    const rebuilt = await poolState(new Chain(withArchive), withArchive);
    assert.deepEqual(rebuilt.notes.map((n) => n.commitment), full.notes.map((n) => n.commitment));
    assert.deepEqual([...rebuilt.nullifiers].sort(), [...full.nullifiers].sort());
    assert.deepEqual(rebuilt.budgetLeaves, full.budgetLeaves);
    assert.deepEqual(await treeLeaves(new Chain(withArchive), ngList), await treeLeaves(new Chain(d), ngList));

    // Payments work: a deposit and a private payment, proved against roots
    // that include leaves only the archive still has.
    const user = await ClearanceClient.connect({ wallet: keypairWallet(kp.secret()), identitySecret: idSecret, jurisdiction: "NG", artifacts, deployment: withArchive });
    assert.deepEqual(await user.getTier(), { tier: 1, revoked: false });
    const dep = await user.deposit(10);
    const bob = JSON.parse(readFileSync(join(root, "deployments/demo-accounts.json"), "utf8")).accounts.find((a: { name: string }) => a.name.startsWith("Bob")).clearanceAddress;
    const pay = await user.send({ to: bob, amountUsd: 3 });
    assert.equal((await user.getBalance()).shieldedUsd, 7);
    console.log("deposit", dep.txHash, "payment", pay.txHash);

    // A wrong archive is refused, not trusted.
    const t1 = await ClearanceClient.connect({ wallet: keypairWallet(kp.secret()), identitySecret: idSecret, jurisdiction: "NG", artifacts, deployment: { ...late, archiveUrl: `${files}/tampered.json` } });
    await assert.rejects(t1.getTier(), isCode("STATE_MISMATCH"));
    await assert.rejects(poolState(new Chain({ ...late, archiveUrl: `${files}/swapped.json` }), late), isCode("STATE_MISMATCH"));

    writeFileSync(join(root, "deployments/history-run.json"), JSON.stringify({
      ranAt: new Date().toISOString(),
      archive: { startLedger: archive.startLedger, toLedger: archive.toLedger, events: archive.events.length },
      rpcCutoffLedger: cutoff,
      notes: full.notes.length,
      depositTx: dep.txHash,
      paymentTx: pay.txHash,
      refused: ["HISTORY_UNAVAILABLE (no archive)", "STATE_MISMATCH (altered allow-list leaf)", "STATE_MISMATCH (swapped note commitments)"],
    }, null, 2) + "\n");
  } finally {
    for (const s of servers) s.close();
  }
});
