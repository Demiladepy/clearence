/* tslint:disable */
/* eslint-disable */

/**
 * Groth16 prover for clearance_tx_2_2 (upstream's prover, arkworks).
 */
export class Prover {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * `pk`: compressed arkworks proving key (testdata/clearance_tx_2_2_proving_key.bin),
     * `r1cs`: circom R1CS of the circuit.
     */
    constructor(pk: Uint8Array, r1cs: Uint8Array);
    /**
     * `witness`: the full witness, 32-byte little-endian field elements.
     * Returns the proof in Soroban encoding (A 64 || B 128 || C 64 bytes).
     */
    prove(witness: Uint8Array): Uint8Array;
    /**
     * Public signals of the witness, as decimal strings, in circuit order.
     */
    publicSignals(witness: Uint8Array): string[];
}

/**
 * Merkle node: Poseidon2 compression (t=2 permutation + feed-forward, lane 0).
 */
export function compress(left: string, right: string): string;

/**
 * Poseidon2(a, b; dom): t=3 permutation over [a, b, dom], lane 0.
 */
export function hash2(a: string, b: string, dom: number): string;

/**
 * Poseidon2(a, b, c; dom): t=4 permutation over [a, b, c, dom], lane 0.
 */
export function hash3(a: string, b: string, c: string, dom: number): string;

/**
 * Path in an asp-membership tree: [bits, sibling_0, ..., sibling_{depth-1}].
 */
export function listTreeProof(leaves: string[], index: number, depth: number): string[];

/**
 * Root of an asp-membership tree (allow-lists, budget tree).
 */
export function listTreeRoot(leaves: string[], depth: number): string;

/**
 * Path of leaf `index` in the note tree: [bits, sibling_0, ..., sibling_{depth-1}].
 */
export function noteTreeProof(leaves: string[], index: number, depth: number): string[];

/**
 * Root of the pool's note tree (upstream MerkleTreeWithHistory).
 */
export function noteTreeRoot(leaves: string[], depth: number): string;

/**
 * Open a sealed record (R, c1..c3) with operator private key d.
 * Returns [idCommitment, receiverPubKey, 2*sent + travelRuleFlag].
 */
export function openRecord(rx: string, ry: string, c1: string, c2: string, c3: string, d: string): string[];

/**
 * Operator public key D = d * BASE8, as [x, y].
 */
export function operatorPublicKey(d: string): string[];

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_prover_free: (a: number, b: number) => void;
    readonly compress: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly hash2: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly hash3: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => void;
    readonly listTreeProof: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly listTreeRoot: (a: number, b: number, c: number, d: number) => void;
    readonly noteTreeProof: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly noteTreeRoot: (a: number, b: number, c: number, d: number) => void;
    readonly openRecord: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number) => void;
    readonly operatorPublicKey: (a: number, b: number, c: number) => void;
    readonly prover_new: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly prover_prove: (a: number, b: number, c: number, d: number) => void;
    readonly prover_publicSignals: (a: number, b: number, c: number, d: number) => void;
    readonly rust_sqlite_wasm_host_epoch_timestamp_in_ms: (a: number) => number;
    readonly rust_sqlite_wasm_host_sleep: (a: bigint, b: number) => void;
    readonly rust_sqlite_wasm_host_random: (a: number, b: number) => number;
    readonly rust_sqlite_wasm_abort: () => void;
    readonly rust_sqlite_wasm_assert_fail: (a: number, b: number, c: number, d: number) => void;
    readonly rust_sqlite_wasm_calloc: (a: number, b: number) => number;
    readonly rust_sqlite_wasm_malloc: (a: number) => number;
    readonly rust_sqlite_wasm_free: (a: number) => void;
    readonly rust_sqlite_wasm_getentropy: (a: number, b: number) => number;
    readonly rust_sqlite_wasm_host_fill_entropy: (a: number, b: number) => number;
    readonly rust_sqlite_wasm_host_localtime: (a: bigint, b: number) => number;
    readonly rust_sqlite_wasm_localtime: (a: number) => number;
    readonly rust_sqlite_wasm_realloc: (a: number, b: number) => number;
    readonly sqlite3_os_end: () => number;
    readonly sqlite3_os_init: () => number;
    readonly __wbindgen_export: (a: number, b: number) => number;
    readonly __wbindgen_export2: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_export3: (a: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_export4: (a: number, b: number, c: number) => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
