/**
 * In-memory stand-in for on-chain + operator state. One store is shared by
 * every mock client in the page, so the wallet, operator console and public
 * view stay consistent with each other during a demo.
 */
import type { PackChangedEvent, PackId, RulePack, Tier } from "../types.js";
import { RULE_PACKS } from "../rulePacks.js";

export interface IdentityState {
  idCommitment: string;
  displayName?: string;
  tier: Tier | 0; // 0 = not yet KYC'd
  /** Increments on every tier issue; older leaves are revoked. */
  leafVersion: number;
  shieldedUsd: number;
}

export interface StoredRecord {
  recordId: string;
  txHash: string;
  ledger: number;
  timestamp: string;
  epoch: number;
  packId: PackId;
  packHash: string;
  nullifiers: string[];
  outputCommitments: string[];
  sealedRecordHex: string;
  plaintext: {
    sender: string;
    receiver: string;
    amountUsd: number;
    travelRuleFlag: boolean;
  };
}

export interface MockConfig {
  /** Total simulated proving time, spread over the proof steps. */
  provingMs: number;
  /** If proving exceeds this, PROOF_TIMEOUT. */
  proofTimeoutMs: number;
  /** Demo operator key. Real one is a Baby JubJub secret scalar. */
  operatorKey: string;
  /** Delay before a SEP-24 upgrade auto-approves. null = manual via devtools. */
  kycAutoApproveMs: number | null;
}

export class MockChain {
  identities = new Map<string, IdentityState>();
  /** wallet address -> idCommitment. Real SDK: idSecret held in the wallet. */
  walletIdentity = new Map<string, string>();
  /** `${idCommitment}:${epoch}` -> spent USD that day */
  budgets = new Map<string, number>();
  records: StoredRecord[] = [];
  activePack: RulePack = { ...RULE_PACKS["NG-2026-v1"], activatedAt: new Date(0).toISOString() };
  ledger = 1_200_000;
  /** Unix seconds. Overridable so demos/tests can cross midnight. */
  clockOffsetSec = 0;
  pendingKyc = new Map<string, (tier: Tier) => void>();
  config: MockConfig = {
    provingMs: 3500,
    proofTimeoutMs: 15_000,
    operatorKey: "demo-operator-key",
    kycAutoApproveMs: 2500,
  };
  private packListeners = new Set<(e: PackChangedEvent) => void>();

  nowSec(): number {
    return Math.floor(Date.now() / 1000) + this.clockOffsetSec;
  }

  identityForWallet(address: string): IdentityState | undefined {
    const id = this.walletIdentity.get(address);
    return id ? this.identities.get(id) : undefined;
  }

  setPack(packId: PackId): RulePack {
    this.activePack = { ...RULE_PACKS[packId], activatedAt: new Date(this.nowSec() * 1000).toISOString() };
    const ev: PackChangedEvent = { packId, packHash: this.activePack.packHash, at: this.activePack.activatedAt };
    for (const l of this.packListeners) l(ev);
    return this.activePack;
  }

  onPackChanged(cb: (e: PackChangedEvent) => void): () => void {
    this.packListeners.add(cb);
    return () => this.packListeners.delete(cb);
  }

  reset(): void {
    this.identities.clear();
    this.walletIdentity.clear();
    this.budgets.clear();
    this.records = [];
    this.pendingKyc.clear();
    this.clockOffsetSec = 0;
    this.ledger = 1_200_000;
    this.activePack = { ...RULE_PACKS["NG-2026-v1"], activatedAt: new Date(0).toISOString() };
  }
}

/** The single shared mock chain for this JS realm. */
export const chain = new MockChain();

// ---------- helpers ----------

export function randomHex(bytes: number): string {
  const b = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(b);
  return "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/**
 * Sealed record size: R (2 field elements) + 5 encrypted fields
 * [idCommitment, receiver, sent, epoch, travelRuleFlag] = 7 x 32 bytes.
 * Same length on every transfer (AT-5).
 */
export const SEALED_RECORD_BYTES = 7 * 32;

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
