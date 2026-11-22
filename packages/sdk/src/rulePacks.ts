import type { PackId, RulePack } from "./types.js";

/**
 * Demo rule packs. Limits are USD on-chain.
 *
 * NG: Tier 1 daily limit is set so it shows as ₦50,000 at the labelled fixed
 * rate (₦1,600 / USD). Ghana numbers are ILLUSTRATIVE (open question, default:
 * same structure as Nigeria) and are chosen so a ₦30,000 payment passes under
 * NG and fails under GH, which is the "rule switch" demo beat.
 *
 * packHash values are placeholders until the real Poseidon2 pack hash is
 * computed by the circuit tooling; the shape (0x + 64 hex) is final.
 */
export const RULE_PACKS: Record<PackId, Omit<RulePack, "activatedAt">> = {
  "NG-2026-v1": {
    id: "NG-2026-v1",
    version: 1,
    country: "NG",
    localCurrency: "NGN",
    localPerUsd: 1600,
    travelRuleThresholdUsd: 1000,
    tiers: {
      1: { perPaymentLimitUsd: 18.75, dailyLimitUsd: 31.25 }, // ₦30,000 / ₦50,000
      2: { perPaymentLimitUsd: 625, dailyLimitUsd: 1250 }, // ₦1m / ₦2m
      3: { perPaymentLimitUsd: 3125, dailyLimitUsd: 6250 }, // ₦5m / ₦10m
    },
    packHash: "0x" + "1a".repeat(32),
  },
  "GH-2026-v1": {
    id: "GH-2026-v1",
    version: 1,
    country: "GH",
    localCurrency: "GHS",
    localPerUsd: 15,
    travelRuleThresholdUsd: 1000,
    tiers: {
      1: { perPaymentLimitUsd: 15, dailyLimitUsd: 25 },
      2: { perPaymentLimitUsd: 500, dailyLimitUsd: 1000 },
      3: { perPaymentLimitUsd: 2500, dailyLimitUsd: 5000 },
    },
    packHash: "0x" + "2b".repeat(32),
  },
};

/** The demo always shows Naira first (UI is Nigerian), USD beneath. */
export const DISPLAY_NGN_PER_USD = 1600;

export function formatNgn(usd: number): string {
  return "₦" + Math.round(usd * DISPLAY_NGN_PER_USD).toLocaleString("en-NG");
}

export function ngnToUsd(ngn: number): number {
  return ngn / DISPLAY_NGN_PER_USD;
}

/** USDC has 7 decimals on Stellar; the circuit works in stroops. */
export const STROOPS_PER_USD = 10_000_000n;

export function usdToStroops(usd: number): bigint {
  return BigInt(Math.round(usd * 1e7));
}

export function stroopsToUsd(s: bigint): number {
  return Number(s) / 1e7;
}

/** Epoch = UTC day index from the ledger timestamp. Set by the contract. */
export function epochOf(unixSeconds: number): number {
  return Math.floor(unixSeconds / 86400);
}

export function epochResetsAt(epoch: number): string {
  return new Date((epoch + 1) * 86400 * 1000).toISOString();
}
