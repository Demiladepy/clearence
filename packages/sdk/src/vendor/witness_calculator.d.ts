export interface WitnessCalculator {
  calculateWitness(input: Record<string, unknown>, sanityCheck?: boolean): Promise<bigint[]>;
}
export default function builder(code: Uint8Array | ArrayBuffer, options?: Record<string, unknown>): Promise<WitnessCalculator>;
