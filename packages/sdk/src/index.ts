/**
 * @clearance/sdk
 *
 * Status: MOCK. Same signatures as the real SDK (PRD "Contract and SDK
 * interface"). The real implementation replaces ./mock/client.js behind these
 * exports, so UI code importing from "@clearance/sdk" does not change.
 */
export { Clearance, Operator, PublicView, type IdentityInfo } from "./mock/client.js";
export { ClearanceError, humanMessage, type ClearanceErrorCode, type ErrorContext } from "./errors.js";
export {
  RULE_PACKS,
  DISPLAY_NGN_PER_USD,
  formatNgn,
  ngnToUsd,
  usdToStroops,
  stroopsToUsd,
  epochOf,
  epochResetsAt,
} from "./rulePacks.js";
export type * from "./types.js";

export const SDK_MODE = "mock" as const;
