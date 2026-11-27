/**
 * Network configuration. Testnet ids come from deployments/testnet.json
 * (written by scripts/deploy-testnet.py).
 */
import { Networks } from "@stellar/stellar-sdk";

export interface Deployment {
  rpcUrl: string;
  networkPassphrase: string;
  /** First ledger to scan for events (the deployment's start ledger). */
  startLedger: number;
  pool: string;
  token: string;
  /** Classic asset behind the token contract (code:issuer), for trustlines. */
  asset: { code: string; issuer: string };
  registry: string;
  budgetTree: string;
  allowLists: Record<number, string>;
  explorerTx: (hash: string) => string;
}

export const TESTNET: Deployment = {
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: Networks.TESTNET,
  startLedger: 5951900,
  pool: "CA2DGBLA6H2Q6W4JOHOT2UGXEWIJVQSNFDB2GN3PQSZRUNEBDNJOTIQE",
  token: "CCXZ5OWSDPXDGL7CAN7CDYVATYPSHXDTRZAWQLWGT3I4QZ62F3MRIRZ3",
  asset: { code: "CLRUSD", issuer: "GB5HAJ2FBMUR6NMQG7EH2A4OFA5F7K4ZIIKW6OTMWZDIA66ROL4QIBZJ" },
  registry: "CAA62XQJRNFBMAATZX7KQX7K66BJZCPUJXMPSCE4ZRXELFC3KCAPFEQV",
  budgetTree: "CDRYYKQUNECSBG2SCBCJTILGLEKFO2UQF7EG7VDYYZ3SDCJ2MMIP5EVX",
  allowLists: { 566: "CBSHEYVFWZMKK5Z2CM6EW4I6J6V5QVRE6ZB2E5CJJFDSREN2WIAU5HJW", 288: "CBXRDXDHO3YG3FICOWQDMUOR3XJDS47KVJO7EONURBTS2AS7A3ZRP5QA" },
  explorerTx: (h) => `https://stellar.expert/explorer/testnet/tx/${h}`,
};

/** Tree depths, as deployed (pool 20, allow-lists 10, budget 20). */
export const LEVELS = { pool: 20, identity: 10, budget: 20 } as const;

/** USDC-style 7 decimals. */
export const STROOPS_PER_USD = 10_000_000n;
export const usdToStroops = (usd: number): bigint => BigInt(Math.round(usd * 1e7));
export const stroopsToUsd = (s: bigint): number => Number(s) / 1e7;
