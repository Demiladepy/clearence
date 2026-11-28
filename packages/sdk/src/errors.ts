export type ClearanceErrorCode =
  | "OVER_PER_PAYMENT_LIMIT"
  | "OVER_DAILY_BUDGET"
  | "NOT_IN_ALLOW_LIST"
  | "TIER_REVOKED"
  | "PROOF_TIMEOUT"
  | "WALLET_REJECTED"
  | "INSUFFICIENT_BALANCE"
  | "RECORD_KEY_INVALID"
  /** Events needed to rebuild state are older than the RPC keeps and no archive covers them. */
  | "HISTORY_UNAVAILABLE"
  /** A tree rebuilt from events does not match any recent on-chain root (archive or RPC data is wrong). */
  | "STATE_MISMATCH";

export interface ErrorContext {
  /** Formatted local-currency figure, e.g. "₦50,000". */
  limitLocal?: string;
  limitUsd?: number;
  remainingUsd?: number;
  /** Proof step that failed, so the proof panel can stop on it. */
  step?: "identity" | "perPayment" | "dailyBudget" | "sealed";
}

export class ClearanceError extends Error {
  readonly code: ClearanceErrorCode;
  readonly context: ErrorContext;
  /** Human message for the UI. Michael may override wording per code. */
  readonly userMessage: string;

  constructor(code: ClearanceErrorCode, context: ErrorContext = {}) {
    const userMessage = humanMessage(code, context);
    super(`${code}: ${userMessage}`);
    this.name = "ClearanceError";
    this.code = code;
    this.context = context;
    this.userMessage = userMessage;
  }
}

export function humanMessage(code: ClearanceErrorCode, c: ErrorContext = {}): string {
  switch (code) {
    case "OVER_PER_PAYMENT_LIMIT":
      return `This is above your ${c.limitLocal ?? "per-payment"} limit for a single payment. Send a smaller amount or upgrade your tier.`;
    case "OVER_DAILY_BUDGET":
      return `This would take you past today's ${c.limitLocal ?? "daily"} limit. Upgrade your tier or try tomorrow.`;
    case "NOT_IN_ALLOW_LIST":
      return "Your identity hasn't been verified for private payments yet. Complete KYC to get started.";
    case "TIER_REVOKED":
      return "This credential was replaced when your tier changed. Refresh to use your new tier.";
    case "PROOF_TIMEOUT":
      return "Building the proof took too long. Nothing was sent. Please try again.";
    case "WALLET_REJECTED":
      return "You cancelled the request in your wallet. Nothing was sent.";
    case "INSUFFICIENT_BALANCE":
      return "Your private balance is too low for this payment. Deposit first.";
    case "RECORD_KEY_INVALID":
      return "This key cannot open the record. Only the operator key for this pool can.";
    case "HISTORY_UNAVAILABLE":
      return "We can't load the pool's full history right now. Nothing was sent. Please try again shortly.";
    case "STATE_MISMATCH":
      return "The pool history we loaded doesn't match the chain. Nothing was sent. Please refresh and try again.";
  }
}
