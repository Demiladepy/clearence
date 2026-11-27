/**
 * Chain state a wallet or operator needs, rebuilt from contract events only.
 * The same reconstruction the testnet driver checks root-for-root against the
 * contracts (e2e/src/tests/testnet.rs).
 */
import { Buffer } from "buffer";
import { Address, xdr, nativeToScVal } from "@stellar/stellar-sdk";
import { keccak_256 } from "@noble/hashes/sha3";
import type { Chain, ChainEvent } from "./chain.js";
import { P, type F, type PackValues, packHash } from "./crypto.js";
import type { Deployment } from "./config.js";

export interface BudgetStep {
  nullifier: F;
  commitment: F;
  encNewSpent: F;
  epoch: number;
}

export interface NoteEvent {
  index: number;
  commitment: F;
  encryptedOutput: Uint8Array;
  ledger: number;
  txHash: string;
}

export interface SealedRecordEvent {
  id: string;
  txHash: string;
  ledger: number;
  senderJurisdiction: number;
  receiverJurisdiction: number;
  epoch: number;
  senderPackHash: F;
  receiverPackHash: F;
  r: F[]; // [R0.x, R0.y, R1.x, R1.y]
  c: F[]; // [c0.1, c0.2, c0.3, c1.1, c1.2, c1.3]
}

export interface PoolState {
  notes: NoteEvent[]; // by index
  nullifiers: Set<F>;
  budgetSteps: BudgetStep[];
  budgetLeaves: F[];
  records: SealedRecordEvent[];
}

const s = (v: unknown): F => BigInt(v as bigint | number | string).toString();
const name = (e: ChainEvent): string => String(e.topics[0]);

/** Leaves of an asp-membership tree, in index order, from LeafAdded events. */
export async function treeLeaves(chain: Chain, id: string): Promise<F[]> {
  const evs = (await chain.events([id])).filter((e) => name(e) === "LeafAdded");
  const leaves: F[] = [];
  for (const e of evs) leaves[Number(e.data.index)] = s(e.data.leaf);
  if (leaves.some((l) => l === undefined) || leaves.length !== evs.length) throw new Error(`gap in tree ${id}`);
  return leaves;
}

export async function poolState(chain: Chain, d: Deployment): Promise<PoolState> {
  const [evs, budgetLeaves] = await Promise.all([chain.events([d.pool]), treeLeaves(chain, d.budgetTree)]);
  const notes: NoteEvent[] = [];
  const nullifiers = new Set<F>();
  const budgetSteps: BudgetStep[] = [];
  const records: SealedRecordEvent[] = [];
  for (const e of evs) {
    switch (name(e)) {
      case "new_commitment_event":
        notes[Number(e.data.index)] = {
          index: Number(e.data.index),
          commitment: s(e.topics[1]),
          encryptedOutput: new Uint8Array((e.data.encrypted_output as Uint8Array) ?? []),
          ledger: e.ledger,
          txHash: e.txHash,
        };
        break;
      case "new_nullifier_event":
        nullifiers.add(s(e.topics[1]));
        break;
      case "budget_step":
        budgetSteps.push({
          nullifier: s(e.topics[1]),
          commitment: s(e.data.commitment),
          encNewSpent: s(e.data.enc_new_spent),
          epoch: Number(e.data.epoch),
        });
        break;
      case "sealed_record":
        records.push({
          id: e.id,
          txHash: e.txHash,
          ledger: e.ledger,
          senderJurisdiction: Number(e.topics[1]),
          receiverJurisdiction: Number(e.topics[2]),
          epoch: Number(e.data.epoch),
          senderPackHash: s(e.data.sender_pack_hash),
          receiverPackHash: s(e.data.receiver_pack_hash),
          r: (e.data.record_r as unknown[]).map(s),
          c: (e.data.record_c as unknown[]).map(s),
        });
        break;
    }
  }
  if (notes.some((n) => n === undefined)) throw new Error("gap in note tree events");
  return { notes, nullifiers, budgetSteps, budgetLeaves, records };
}

// ---------- packs ----------

export interface ActivePack extends PackValues {
  hash: F;
  publishedAt: number;
}

interface RawPack {
  jurisdiction: number;
  version: number;
  hash: bigint;
  published_at: bigint;
  rules: {
    utc_offset_secs: number;
    travel_rule_threshold: bigint;
    tiers: { per_payment: bigint; daily: bigint }[];
    operator_key: { x: bigint; y: bigint };
  };
}

/** The active pack of a jurisdiction, with its hash recomputed and checked. */
export async function activePack(chain: Chain, d: Deployment, jurisdiction: number): Promise<ActivePack> {
  const raw = await chain.read<RawPack>(d.registry, "active_pack", { jurisdiction });
  const values: PackValues = {
    jurisdiction: raw.jurisdiction,
    version: raw.version,
    utcOffsetSecs: raw.rules.utc_offset_secs,
    travelRuleThreshold: BigInt(raw.rules.travel_rule_threshold),
    tiers: raw.rules.tiers.map((t) => [BigInt(t.per_payment), BigInt(t.daily)] as [bigint, bigint]),
    operatorKey: { x: s(raw.rules.operator_key.x), y: s(raw.rules.operator_key.y) },
  };
  const hash = packHash(values);
  if (hash !== s(raw.hash)) throw new Error(`pack hash mismatch for ${jurisdiction}: registry ${raw.hash}, local ${hash}`);
  return { ...values, hash, publishedAt: Number(raw.published_at) };
}

// ---------- external data hash (contracts/pool-core/src/ext_data.rs) ----------

export interface ExtData {
  recipient: string;
  extAmount: bigint;
  encryptedOutput0: Uint8Array;
  encryptedOutput1: Uint8Array;
}

/** keccak256(XDR(ExtDataDomain)) mod p, as the pool computes it. */
export function extDataHash(d: Deployment, e: ExtData): Uint8Array {
  const entries: [string, xdr.ScVal][] = [
    ["encrypted_output0", xdr.ScVal.scvBytes(Buffer.from(e.encryptedOutput0))],
    ["encrypted_output1", xdr.ScVal.scvBytes(Buffer.from(e.encryptedOutput1))],
    ["ext_amount", nativeToScVal(e.extAmount, { type: "i256" })],
    ["pool", new Address(d.pool).toScVal()],
    ["recipient", new Address(e.recipient).toScVal()],
    ["token", new Address(d.token).toScVal()],
  ];
  const map = xdr.ScVal.scvMap(entries.map(([k, v]) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(k), val: v })));
  const digest = keccak_256(map.toXDR());
  const reduced = BigInt("0x" + Buffer.from(digest).toString("hex")) % P;
  return Uint8Array.from(Buffer.from(reduced.toString(16).padStart(64, "0"), "hex"));
}
