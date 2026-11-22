/**
 * @clearance/sdk: public types and error codes.
 *
 * The implementation (proof generation via Nethermind's prover, Soroban calls
 * to the pool and rule registry) is being built against these types.
 */
export { ClearanceError, humanMessage, type ClearanceErrorCode, type ErrorContext } from "./errors.js";
export { JURISDICTIONS } from "./types.js";
export type * from "./types.js";
