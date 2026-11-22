/**
 * Public types for @clearance/sdk.
 *
 * This file is the contract between the SDK (Demilade) and the UI (Michael).
 * The mock and the real SDK both implement exactly these types, so UI code
 * written against the mock does not change when the real SDK lands.
 */

export type Network = "testnet" | "local";

/** Rule pack identifiers. Rules are in USD on-chain; NGN is display-only. */
export type PackId = "NG-2026-v1" | "GH-2026-v1";

export type Tier = 1 | 2 | 3;

/** Stellar G... address or a Clearance shielded address. */
export type Address = string;

/** Minimal wallet surface the SDK needs (Stellar Wallets Kit fits this). */
export interface WalletLike {
  getAddress(): Promise<{ address: Address }>;
  signTransaction(xdr: string, opts?: { networkPassphrase?: string }): Promise<{ signedTxXdr: string }>;
}

export interface ConnectOptions {
  network: Network;
  /** Pool contract id (C...). */
  pool: string;
  wallet: WalletLike;
}

export interface TierLimits {
  perPaymentLimitUsd: number;
  dailyLimitUsd: number;
}

export interface RulePack {
  id: PackId;
  version: number;
  country: "NG" | "GH";
  /** Display currency shown first in the UI. */
  localCurrency: "NGN" | "GHS";
  /** Fixed, labelled display rate. Not a price feed. */
  localPerUsd: number;
  /** Travel Rule threshold in USD (CBN 26.14.3: USD/EUR 1,000). */
  travelRuleThresholdUsd: number;
  tiers: Record<Tier, TierLimits>;
  /** Poseidon2 hash of the pack values, hex. Public: appears in every proof. */
  packHash: string;
  activatedAt: string; // ISO
}

/** The checks a proof establishes. Drives the proof panel. */
export interface ProvedChecks {
  tier: boolean;
  perPayment: boolean;
  dailyBudget: boolean;
  sealed: boolean;
}

/** Steps emitted while proving, in this order. */
export type ProofStep =
  | "identity" // leaf is in the allow-list
  | "perPayment" // amount within tier's per-payment limit
  | "dailyBudget" // running daily total within tier's daily limit
  | "sealed" // compliance record encrypted to operator key
  | "submitting" // tx sent to Soroban
  | "verified"; // Soroban verified the proof

export interface ProofProgress {
  step: ProofStep;
  /** ms since proving started */
  elapsedMs: number;
}

export interface SendParams {
  /** Recipient: Stellar address or Clearance shielded address. */
  to: Address;
  amountUsd: number;
  /** Optional: drive the proof-panel animation. */
  onProgress?: (p: ProofProgress) => void;
}

export interface Receipt {
  proved: ProvedChecks;
  txHash: string;
  provingMs: number;
  /** stellar.expert link for the "Verified on Stellar" button. */
  explorerUrl: string;
  packId: PackId;
  /** Budget after this payment. */
  budget: Budget;
}

export interface Budget {
  tier: Tier;
  spentTodayUsd: number;
  dailyLimitUsd: number;
  perPaymentLimitUsd: number;
  /** ISO time of next UTC midnight (epoch rollover from ledger time). */
  resetsAt: string;
}

export interface Balance {
  /** Shielded (in-pool) balance. */
  shieldedUsd: number;
}

export interface TierUpgradeRequest {
  /** SEP-24 interactive URL to open in a popup/iframe. */
  interactiveUrl: string;
  /** Resolves when KYC completes and the new leaf is issued. */
  done: Promise<{ tier: Tier }>;
}

/** What the public chain shows for a transfer (FR-9 public view). */
export interface PublicTransferView {
  txHash: string;
  ledger: number;
  timestamp: string;
  contractId: string;
  function: "transact";
  /** What a block explorer shows. Note: no amount, no counterparty. */
  nullifiers: string[];
  outputCommitments: string[];
  packHash: string;
  epoch: number;
  /** Sealed record bytes, hex. Same length on every transfer. */
  sealedRecordHex: string;
  proofVerified: true;
}

// ---------- operator side ----------

export interface SealedRecordSummary {
  recordId: string;
  txHash: string;
  timestamp: string;
  epoch: number;
  packId: PackId;
  /** Ciphertext stays locked until openRecord. */
  sealedRecordHex: string;
}

export interface OpenedRecord {
  recordId: string;
  sender: string; // identity commitment, mapped to KYC name by the operator
  senderName?: string;
  receiver: string;
  amountUsd: number;
  epoch: number;
  travelRuleFlag: boolean;
  packVersion: PackId;
}

export interface IssueTierParams {
  /** Identity commitment = Poseidon2(idSecret), from the user's wallet. */
  idCommitment: string;
  tier: Tier;
  /** Operator's KYC label, kept off-chain. */
  displayName?: string;
}

export interface ListRecordsParams {
  from?: string | Date;
  to?: string | Date;
}

export type PackChangedEvent = { packId: PackId; packHash: string; at: string };
