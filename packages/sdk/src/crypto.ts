/**
 * Clearance hashes and field helpers.
 *
 * Every function mirrors a circuit template in circuits/src and the Rust
 * reference used by the end-to-end and testnet runs (e2e/src/tests/world.rs).
 * Field elements are decimal strings, as the WASM module takes them.
 */
import initWasm, * as wasm from "./wasm/clearance_wasm.js";

/** BN254 scalar field modulus. */
export const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

let ready: Promise<void> | null = null;

/** Load the WASM module once. In Node pass the bytes; in the browser the URL is resolved by the bundler. */
export function initCrypto(source?: BufferSource | URL | string): Promise<void> {
  if (!ready) {
    ready = initWasm(source === undefined ? undefined : { module_or_path: source }).then(() => undefined);
  }
  return ready;
}

export const DOM = {
  commitment: 0x01,
  nullifier: 0x02,
  keypair: 0x03,
  signature: 0x04,
  identity: 0x10,
  leaf: 0x11,
  budgetNullifier: 0x12,
  budgetCommitment: 0x13,
  pack: 0x14,
  budgetKey: 0x15,
} as const;

export type F = string;

export const f = (x: bigint | number | string): F => (((BigInt(x) % P) + P) % P).toString();
export const sub = (a: F, b: F): F => f(BigInt(a) - BigInt(b));
export const add = (a: F, b: F): F => f(BigInt(a) + BigInt(b));

export const hash2 = (a: F, b: F, dom: number): F => wasm.hash2(a, b, dom);
export const hash3 = (a: F, b: F, c: F, dom: number): F => wasm.hash3(a, b, c, dom);

/** A uniformly random field element (31 random bytes). */
export function randomField(): F {
  const b = new Uint8Array(31);
  globalThis.crypto.getRandomValues(b);
  return BigInt("0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")).toString();
}

// ---------- identity (circuits/src/identity.circom) ----------

export const idCommitment = (idSecret: F): F => hash2(idSecret, "0", DOM.identity);
export const noteKey = (idSecret: F): F => hash2(idSecret, "1", DOM.identity);
/** Upstream Keypair: publicKey = Poseidon2(privateKey, 0; 0x03). */
export const notePublicKey = (privateKey: F): F => hash2(privateKey, "0", DOM.keypair);
export const tierLeaf = (idc: F, jurisdiction: number, tier: number, issuance = 0): F =>
  hash2(hash3(idc, String(jurisdiction), String(tier), DOM.leaf), String(issuance), DOM.leaf);

// ---------- budget (circuits/src/dailyBudget.circom) ----------

export const budgetKey = (idSecret: F, epoch: number | bigint, k: number): F =>
  hash3(idSecret, String(epoch), String(k), DOM.budgetKey);
export const budgetNullifier = (idSecret: F, epoch: number | bigint, k: number): F =>
  hash3(idSecret, String(epoch), String(k), DOM.budgetNullifier);
export const budgetCommitment = (idSecret: F, epoch: number | bigint, k: number, spent: bigint): F =>
  hash3(
    hash3(idCommitment(idSecret), String(epoch), String(k), DOM.budgetCommitment),
    spent.toString(),
    budgetKey(idSecret, epoch, k),
    DOM.budgetCommitment,
  );

// ---------- notes (upstream policyTransaction.circom) ----------

export const noteCommitment = (amount: bigint, pubKey: F, blinding: F): F =>
  hash3(amount.toString(), pubKey, blinding, DOM.commitment);
export const noteSignature = (privateKey: F, commitment: F, pathIndex: F): F =>
  hash3(privateKey, commitment, pathIndex, DOM.signature);
export const noteNullifier = (commitment: F, pathIndex: F, signature: F): F =>
  hash3(commitment, pathIndex, signature, DOM.nullifier);

// ---------- packs (circuits/src/packHash.circom, contracts/rule-registry) ----------

export interface PackValues {
  jurisdiction: number;
  version: number;
  utcOffsetSecs: number;
  travelRuleThreshold: bigint; // stroops
  tiers: [bigint, bigint][]; // (perPayment, daily) stroops, 3 tiers
  operatorKey: { x: F; y: F };
}

export const offsetShifted = (offset: number): F => (BigInt(offset) + 2n ** 31n).toString();

export function packHash(p: PackValues): F {
  let h = hash2(String(p.jurisdiction), String(p.version), DOM.pack);
  const vals: F[] = [offsetShifted(p.utcOffsetSecs), p.travelRuleThreshold.toString()];
  for (const [pp, d] of p.tiers) vals.push(pp.toString(), d.toString());
  vals.push(p.operatorKey.x, p.operatorKey.y);
  for (const v of vals) h = hash2(h, v, DOM.pack);
  return h;
}

// ---------- trees (as the contracts build them) ----------

export const noteTreeRoot = (leaves: F[], depth: number): F => wasm.noteTreeRoot(leaves, depth);
export function noteTreeProof(leaves: F[], index: number, depth: number): { bits: F; path: F[] } {
  const [bits, ...path] = wasm.noteTreeProof(leaves, index, depth);
  return { bits: bits!, path };
}
export const listTreeRoot = (leaves: F[], depth: number): F => wasm.listTreeRoot(leaves, depth);
export function listTreeProof(leaves: F[], index: number, depth: number): { bits: F; path: F[] } {
  const [bits, ...path] = wasm.listTreeProof(leaves, index, depth);
  return { bits: bits!, path };
}

// ---------- operator records ----------

export const operatorPublicKey = (d: F): { x: F; y: F } => {
  const [x, y] = wasm.operatorPublicKey(d);
  return { x: x!, y: y! };
};

/** Open a sealed record: returns (idCommitment, receiverPubKey, sent, travelRuleFlag). */
export function openSealedRecord(
  r: [F, F],
  c: [F, F, F],
  d: F,
): { idCommitment: F; receiver: F; sent: bigint; travelRuleFlag: boolean } {
  const [idc, rcv, v] = wasm.openRecord(r[0], r[1], c[0], c[1], c[2], d);
  const value = BigInt(v!);
  return { idCommitment: idc!, receiver: rcv!, sent: value / 2n, travelRuleFlag: value % 2n === 1n };
}

export { wasm };
