/**
 * Public types for @clearance/sdk.
 *
 * This file is the contract between the SDK (Demilade) and the UI (Michael).
 * The mock and the real SDK both implement exactly these types, so UI code
 * written against the mock does not change when the real SDK lands.
 */

export type Network = "testnet" | "local";

/**
 * ISO 3166-1 numeric jurisdiction codes, as stored in the rule registry.
 * Adding a country is a registry call, not an SDK release.
 */
export const JURISDICTIONS = { NG: 566, GH: 288, KE: 404, ZA: 710 } as const;
export type JurisdictionCode = keyof typeof JURISDICTIONS;

/** A pack is identified by jurisdiction + version, e.g. "NG-v1". */
export type PackId = `${JurisdictionCode}-v${number}`;

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
  jurisdiction: JurisdictionCode;
  version: number;
  id: PackId;
  /** Budget day rolls over at local midnight. */
  utcOffsetSecs: number;
  /** Travel Rule threshold in USD (stored on-chain as USDC stroops). */
  travelRuleThresholdUsd: number;
  tiers: Record<Tier, TierLimits>;
  /** Operator's Baby JubJub public key, hex coordinates. */
  operatorKey: { x: string; y: string };
  /** Poseidon2 hash computed on-chain by the registry. Public in every proof. */
  packHash: string;
  publishedAt: string; // ISO
}

/** Display-only currency info. Never on-chain; always labelled as a fixed rate. */
export interface DisplayCurrency {
  code: "NGN" | "GHS" | "KES" | "ZAR" | "USD";
  perUsd: number;
  label: string;
}

/** Cross-border corridor state from the registry. */
export interface Corridor {
  from: JurisdictionCode;
  to: JurisdictionCode;
  /** Opened by the sender's operator. */
  opened: boolean;
  /** Accepted by the receiver's operator. */
  accepted: boolean;
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
  /** Recipient's jurisdiction. Omit for domestic. Cross-border needs an open corridor. */
  toJurisdiction?: JurisdictionCode;
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
  /** Receiver's pack for cross-border; same as packId when domestic. */
  receiverPackId: PackId;
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
  senderPackHash: string;
  receiverPackHash: string;
  epoch: number;
  /**
   * Two sealed records on every transfer: one to the sender's operator, one to
   * the receiver's. Domestic transfers seal both to the same operator, so a
   * cross-border payment looks identical on-chain.
   */
  sealedRecordsHex: [string, string];
  proofVerified: true;
}

// ---------- operator side ----------

export interface SealedRecordSummary {
  recordId: string;
  txHash: string;
  timestamp: string;
  epoch: number;
  packId: PackId;
  /** This operator's copy. Stays locked until openRecord. */
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
  senderJurisdiction: JurisdictionCode;
  receiverJurisdiction: JurisdictionCode;
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

export type PackChangedEvent = { jurisdiction: JurisdictionCode; version: number; packHash: string };
