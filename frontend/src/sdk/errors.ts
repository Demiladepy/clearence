export type ClearanceErrorCode =
  | "OVER_PER_PAYMENT_LIMIT"
  | "OVER_DAILY_BUDGET"
  | "NOT_IN_ALLOW_LIST"
  | "TIER_REVOKED"
  | "PROOF_TIMEOUT"
  | "WALLET_REJECTED"
  | "INSUFFICIENT_BALANCE"
  | "RECORD_KEY_INVALID";

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
  /** Human message for the UI. */
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

// Wording is ours (the SDK lets the UI override it per code).
// No ramp language: never "deposit", "upgrade", "on-ramp" or "cross-border".
export function humanMessage(code: ClearanceErrorCode, c: ErrorContext = {}): string {
  switch (code) {
    case "OVER_PER_PAYMENT_LIMIT":
      return `Nothing left your wallet. This is above your ${c.limitLocal ?? "per-payment"} limit for a single payment. Send a smaller amount, or verify your identity for a higher tier.`;
    case "OVER_DAILY_BUDGET":
      return `Nothing left your wallet. This would take you past today's ${c.limitLocal ?? "daily"} limit. Send a smaller amount, verify your identity for a higher tier, or try tomorrow.`;
    case "NOT_IN_ALLOW_LIST":
      return "Your identity hasn't been verified for private payments yet. Verify your identity to get started.";
    case "TIER_REVOKED":
      return "This credential was replaced when your tier changed. Refresh to use your new tier.";
    case "PROOF_TIMEOUT":
      return "Building the proof took too long. Nothing was sent. Please try again.";
    case "WALLET_REJECTED":
      return "You cancelled the request in your wallet. Nothing was sent.";
    case "INSUFFICIENT_BALANCE":
      return "Your private balance is too low for this payment. Fund your private balance first.";
    case "RECORD_KEY_INVALID":
      return "This key cannot open the record. Only the operator key for this pool can.";
  }
}