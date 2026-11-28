#!/usr/bin/env node
/**
 * Event archive: keeps every event of the Clearance contracts beyond the
 * RPC's ~7-day retention, so wallets can still rebuild the trees.
 *
 *   node scripts/archive-events.mjs <archive.json> [deployments/testnet.json]
 *
 * Reads the archive (or starts one at the deployment's start ledger), fetches
 * every event after its `toLedger` from the RPC, appends them and writes it
 * back. Run it at least every few days (.github/workflows/events-archive.yml
 * runs it every 6 hours). If the archive has fallen out of the RPC's window it
 * stops with an error and writes nothing: a gap is never filled silently.
 *
 * Events are kept as the RPC serves them (topic and value XDR, base64), so the
 * SDK decodes them exactly as it decodes live ones. The archive is not
 * trusted: the SDK checks every tree it rebuilds against the contract's root.
 *
 * No dependencies: plain fetch to the JSON-RPC endpoint.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = process.argv[2];
if (!out) {
  console.error("usage: archive-events.mjs <archive.json> [deployment.json]");
  process.exit(2);
}
const dep = JSON.parse(readFileSync(process.argv[3] ?? resolve(here, "../deployments/testnet.json"), "utf8"));
const RPC = process.env.CLEARANCE_RPC ?? "https://soroban-testnet.stellar.org";

// The contracts whose events the SDK rebuilds state from (and the registry, for audit).
const contracts = [dep.pool, dep.budgetTree, ...Object.values(dep.jurisdictions).map((j) => j.allowList), dep.ruleRegistry];
const START = Number(process.env.CLR_START_LEDGER ?? dep.startLedger ?? 5951900);

async function call(method, params) {
  for (let i = 1; ; i++) {
    const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const j = await r.json().catch(() => ({ error: { message: `HTTP ${r.status}` } }));
    if (!j.error) return j.result;
    if (i >= 4) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
    await new Promise((res) => setTimeout(res, 2000 * i));
  }
}

const archive = existsSync(out)
  ? JSON.parse(readFileSync(out, "utf8"))
  : { network: dep.network, networkPassphrase: dep.networkPassphrase, startLedger: START, toLedger: START - 1, contracts, events: [] };
if (archive.networkPassphrase !== dep.networkPassphrase) throw new Error("archive is for another network");
const missing = contracts.filter((c) => !archive.contracts.includes(c));
if (missing.length) throw new Error(`archive does not cover ${missing.join(", ")}: start a new archive for a new deployment`);

const from = archive.toLedger + 1;
const { sequence: latest } = await call("getLatestLedger", {});
const health = await call("getHealth", {});
if (from < health.oldestLedger) {
  throw new Error(`gap: archive ends at ledger ${archive.toLedger} but the RPC only keeps events from ${health.oldestLedger}. ` +
    `Events in between are lost to this RPC; recover them from a full-history source before continuing.`);
}

const seen = new Set(archive.events.map((e) => e.id));
let cursor;
let scannedTo = archive.toLedger;
let added = 0;
for (;;) {
  const filters = [{ type: "contract", contractIds: contracts }];
  const page = await call("getEvents", cursor ? { filters, pagination: { cursor, limit: 1000 } } : { startLedger: from, filters, pagination: { limit: 1000 } });
  for (const e of page.events) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    archive.events.push({ id: e.id, ledger: e.ledger, txHash: e.txHash, contractId: e.contractId, topic: e.topic, value: e.value });
    added++;
  }
  if (!page.cursor) break;
  scannedTo = Number(BigInt(page.cursor.split("-")[0]) >> 32n);
  if (page.events.length < 1000 && scannedTo >= page.latestLedger) break;
  cursor = page.cursor;
}
// The final cursor marks where the scan stopped; to be safe, call the archive
// complete only up to the ledger before it (the next run re-reads that ledger,
// and ids dedupe the overlap).
archive.toLedger = Math.max(Math.min(scannedTo - 1, latest), archive.toLedger);
archive.updatedAt = new Date().toISOString();
archive.events.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
mkdirSync(dirname(resolve(out)), { recursive: true });
writeFileSync(out, JSON.stringify(archive) + "\n");
console.log(`archive ${out}: +${added} events, ${archive.events.length} total, complete to ledger ${archive.toLedger} (RPC keeps from ${health.oldestLedger})`);
