/**
 * Proving clearance_tx_2_2 in the browser or Node.
 *
 * Witness: circom's generated calculator over the circuit's WASM.
 * Proof: upstream's arkworks Groth16 prover compiled to WASM, with the proving
 * key whose verification key the deployed verifier contract embeds.
 */
import { initCrypto, wasm } from "./crypto.js";
import builder, { type WitnessCalculator } from "./vendor/witness_calculator.js";

export interface CircuitArtifacts {
  /** circom witness WASM (clearance_tx_2_2.wasm) */
  circuitWasm: Uint8Array;
  /** circom R1CS (clearance_tx_2_2.r1cs) */
  r1cs: Uint8Array;
  /** compressed arkworks proving key (clearance_tx_2_2_proving_key.bin) */
  provingKey: Uint8Array;
}

/** Fetch artifacts from a base URL (browser), e.g. "/clearance". */
export async function fetchArtifacts(baseUrl: string): Promise<CircuitArtifacts> {
  const get = async (name: string) => {
    const r = await fetch(`${baseUrl}/${name}`);
    if (!r.ok) throw new Error(`fetch ${baseUrl}/${name}: ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  };
  const [circuitWasm, r1cs, provingKey] = await Promise.all([
    get("clearance_tx_2_2.wasm"),
    get("clearance_tx_2_2.r1cs"),
    get("clearance_tx_2_2_proving_key.bin"),
  ]);
  return { circuitWasm, r1cs, provingKey };
}

export interface ProofResult {
  /** Soroban encoding: A (64) || B (128) || C (64) */
  proof: Uint8Array;
  /** Public signals in circuit order (outputs, then public inputs) */
  publicSignals: string[];
  witnessMs: number;
  provingMs: number;
}

export class ProofEngine {
  private constructor(
    private readonly wc: WitnessCalculator,
    private readonly prover: InstanceType<typeof wasm.Prover>,
  ) {}

  static async create(a: CircuitArtifacts): Promise<ProofEngine> {
    await initCrypto();
    const wc = await builder(a.circuitWasm);
    const prover = new wasm.Prover(a.provingKey, a.r1cs);
    return new ProofEngine(wc, prover);
  }

  async prove(inputs: Record<string, unknown>): Promise<ProofResult> {
    const t0 = performance.now();
    let witness: bigint[];
    try {
      witness = await this.wc.calculateWitness(inputs, true);
    } catch (e) {
      // A failed constraint means the payment breaks a rule (limit, tier, ...).
      throw new ConstraintError(String(e));
    }
    const t1 = performance.now();
    const bytes = new Uint8Array(witness.length * 32);
    witness.forEach((w, i) => {
      let x = w;
      for (let j = 0; j < 32; j++) {
        bytes[i * 32 + j] = Number(x & 0xffn);
        x >>= 8n;
      }
    });
    const proof = this.prover.prove(bytes);
    const publicSignals = this.prover.publicSignals(bytes);
    const t2 = performance.now();
    return { proof, publicSignals, witnessMs: t1 - t0, provingMs: t2 - t1 };
  }
}

/** The circuit rejected the inputs: some rule (limit, tier, pack, ...) is not met. */
export class ConstraintError extends Error {
  override name = "ConstraintError";
}
