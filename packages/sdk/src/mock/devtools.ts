/**
 * Mock-only controls for building screens and running the demo offline.
 * Not part of the real SDK surface: import from "@clearance/sdk/devtools".
 */
import type { PackId, Tier, WalletLike } from "../types.js";
import { epochOf } from "../rulePacks.js";
import { chain, randomHex, SEALED_RECORD_BYTES, type MockConfig } from "./store.js";

export interface MockWallet extends WalletLike {
  address: string;
  /** Next signTransaction call rejects (WALLET_REJECTED state). */
  rejectNext(): void;
}

export function mockWallet(address: string = "G" + randomHex(28).slice(2).toUpperCase().slice(0, 55)): MockWallet {
  let reject = false;
  return {
    address,
    async getAddress() {
      return { address };
    },
    async signTransaction(xdr: string) {
      if (reject) {
        reject = false;
        throw new Error("User declined");
      }
      return { signedTxXdr: xdr };
    },
    rejectNext() {
      reject = true;
    },
  };
}

export const DEMO_ADDRESSES = {
  adaMain: "GADAMAINWALLETXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  adaSecond: "GADASECONDWALLETXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  bola: "GBOLAWALLETXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  newUser: "GNEWUSERWALLETXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
} as const;

/** Ada's two wallets share ONE identity, so they share one daily budget. */
export function bindWallet(address: string, idCommitment: string): void {
  chain.walletIdentity.set(address, idCommitment);
}

export function createIdentity(opts: { displayName: string; tier: Tier | 0; shieldedUsd?: number }): string {
  const idCommitment = randomHex(32);
  chain.identities.set(idCommitment, {
    idCommitment,
    displayName: opts.displayName,
    tier: opts.tier,
    leafVersion: opts.tier === 0 ? 0 : 1,
    shieldedUsd: opts.shieldedUsd ?? 0,
  });
  return idCommitment;
}

/**
 * Demo world: Ada (Tier 1, two wallets, $100 shielded), Bola (Tier 2),
 * a fresh unverified wallet, and `crowd` dummy past transfers (FR-12).
 */
export function seedDemo({ crowd = 24 }: { crowd?: number } = {}) {
  chain.reset();
  const ada = createIdentity({ displayName: "Ada Okafor", tier: 1, shieldedUsd: 100 });
  bindWallet(DEMO_ADDRESSES.adaMain, ada);
  bindWallet(DEMO_ADDRESSES.adaSecond, ada);
  const bola = createIdentity({ displayName: "Bola Mensah", tier: 2, shieldedUsd: 2000 });
  bindWallet(DEMO_ADDRESSES.bola, bola);

  const names = ["Chidi", "Ngozi", "Kwame", "Efua", "Tunde", "Zainab", "Kofi", "Amaka", "Yaw", "Halima"];
  const crowdIds = names.map((n, i) => createIdentity({ displayName: n, tier: ((i % 3) + 1) as Tier, shieldedUsd: 500 }));
  const now = chain.nowSec();
  for (let i = 0; i < crowd; i++) {
    const ts = now - (crowd - i) * 1800;
    const sender = crowdIds[i % crowdIds.length]!;
    const receiver = crowdIds[(i + 3) % crowdIds.length]!;
    const amountUsd = [5, 12.5, 18, 40, 150, 600, 1200][i % 7]!;
    chain.ledger += 7;
    chain.records.unshift({
      recordId: `rec_seed_${String(i).padStart(2, "0")}`,
      txHash: randomHex(32).slice(2),
      ledger: chain.ledger,
      timestamp: new Date(ts * 1000).toISOString(),
      epoch: epochOf(ts),
      packId: "NG-2026-v1",
      packHash: chain.activePack.packHash,
      nullifiers: [randomHex(32), randomHex(32)],
      outputCommitments: [randomHex(32), randomHex(32)],
      sealedRecordHex: randomHex(SEALED_RECORD_BYTES),
      plaintext: { sender, receiver, amountUsd, travelRuleFlag: amountUsd >= 1000 },
    });
  }
  return { ada, bola, operatorKey: chain.config.operatorKey, addresses: DEMO_ADDRESSES };
}

export function configure(c: Partial<MockConfig>): void {
  Object.assign(chain.config, c);
}

/** Jump the mock ledger clock, e.g. advanceDays(1) to show the budget reset. */
export function advanceDays(days: number): void {
  chain.clockOffsetSec += days * 86400;
}

/** Manually approve a pending SEP-24 upgrade (when kycAutoApproveMs is null). */
export function approveKyc(idCommitment: string, tier: Tier): boolean {
  const fn = chain.pendingKyc.get(idCommitment);
  if (!fn) return false;
  chain.pendingKyc.delete(idCommitment);
  fn(tier);
  return true;
}

export function setPack(packId: PackId): void {
  chain.setPack(packId);
}

export function reset(): void {
  chain.reset();
}
