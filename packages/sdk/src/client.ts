/**
 * The Clearance payer client: what the wallet UI calls.
 *
 * Everything is real: state is rebuilt from contract events, proofs are made
 * locally (browser or Node) with the deployed circuit's proving key, and
 * payments are Soroban transactions signed by the user's wallet.
 */
import { Buffer } from "buffer";
import nacl from "tweetnacl";
import { Networks } from "@stellar/stellar-sdk";
import { Chain } from "./chain.js";
import { LEVELS, TESTNET, type Deployment, stroopsToUsd, usdToStroops } from "./config.js";
import * as c from "./crypto.js";
import { ClearanceError } from "./errors.js";
import { ProofEngine, type CircuitArtifacts } from "./prover.js";
import { activePack, extDataHash, poolState, treeLeaves, type ActivePack, type PoolState } from "./state.js";
import {
  JURISDICTIONS,
  type Balance,
  type Budget,
  type JurisdictionCode,
  type PackId,
  type ProofStep,
  type Receipt,
  type SendParams,
  type Tier,
  type WalletLike,
} from "./types.js";

export interface ClientOptions {
  wallet: WalletLike;
  /** The user's identity secret. Keep it in the wallet; every device of one person uses the same one. */
  identitySecret: string;
  /** Jurisdiction the user is KYC'd in. */
  jurisdiction: JurisdictionCode;
  artifacts: CircuitArtifacts;
  deployment?: Deployment;
}

/** A note the user owns and has not spent. */
export interface OwnedNote {
  index: number;
  amount: bigint;
  blinding: c.F;
  commitment: c.F;
}

const codeOf = (j: number): JurisdictionCode =>
  (Object.entries(JURISDICTIONS).find(([, v]) => v === j)?.[0] ?? "NG") as JurisdictionCode;

/** Create a new identity secret (store it; it is the user's identity). */
export const newIdentitySecret = (): string => c.randomField();

/** A Clearance address: where others send private payments to this user. */
export function clearanceAddress(identitySecret: string): string {
  const pk = c.notePublicKey(c.noteKey(identitySecret));
  const enc = encryptionKeys(identitySecret).publicKey;
  return `clr:${pk}:${Buffer.from(enc).toString("hex")}`;
}

function parseClearanceAddress(a: string): { pubKey: c.F; enc: Uint8Array } | null {
  const m = /^clr:(\d+):([0-9a-f]{64})$/.exec(a);
  return m ? { pubKey: m[1]!, enc: Uint8Array.from(Buffer.from(m[2]!, "hex")) } : null;
}

function encryptionKeys(identitySecret: string): nacl.BoxKeyPair {
  const seed = nacl.hash(new TextEncoder().encode(`clearance-note-encryption:${identitySecret}`)).slice(0, 32);
  return nacl.box.keyPair.fromSecretKey(seed);
}

/** Encrypt (amount, blinding) for the note's owner: ephemeralPub(32) || nonce(24) || box. */
function sealNote(to: Uint8Array, amount: bigint, blinding: c.F): Uint8Array {
  const eph = nacl.box.keyPair();
  const nonce = nacl.randomBytes(24);
  const msg = new TextEncoder().encode(JSON.stringify({ a: amount.toString(), b: blinding }));
  const box = nacl.box(msg, nonce, to, eph.secretKey);
  const out = new Uint8Array(32 + 24 + box.length);
  out.set(eph.publicKey, 0);
  out.set(nonce, 32);
  out.set(box, 56);
  return out;
}

function openNote(sk: Uint8Array, data: Uint8Array): { amount: bigint; blinding: c.F } | null {
  if (data.length < 57) return null;
  const msg = nacl.box.open(data.slice(56), data.slice(32, 56), data.slice(0, 32), sk);
  if (!msg) return null;
  try {
    const { a, b } = JSON.parse(new TextDecoder().decode(msg)) as { a: string; b: string };
    return { amount: BigInt(a), blinding: c.f(b) };
  } catch {
    return null;
  }
}

export interface OnboardResult {
  jurisdiction: string;
  tier: 1;
  /** On-chain KYC (allow-list insert); absent if the identity was already listed. */
  kycTx?: string;
  /** Test CLRUSD granted to the public balance. */
  mintTx?: string;
  grantUsd: number;
  trustlineTx?: string;
}

export class ClearanceClient {
  private constructor(
    readonly chain: Chain,
    readonly d: Deployment,
    readonly address: string,
    private readonly id: c.F,
    readonly jurisdiction: JurisdictionCode,
    private readonly engine: ProofEngine,
  ) {}

  static async connect(o: ClientOptions): Promise<ClearanceClient> {
    await c.initCrypto();
    const d = o.deployment ?? TESTNET;
    const { address } = await o.wallet.getAddress();
    const chain = new Chain(d, o.wallet, address);
    const engine = await ProofEngine.create(o.artifacts);
    return new ClearanceClient(chain, d, address, c.f(o.identitySecret), o.jurisdiction, engine);
  }

  private get j(): number {
    return JURISDICTIONS[this.jurisdiction];
  }
  /** Given to the operator at KYC. */
  get idCommitment(): c.F {
    return c.idCommitment(this.id);
  }
  /** Share this to receive private payments. */
  get clearanceAddress(): string {
    return clearanceAddress(this.id);
  }
  private get noteKey(): c.F {
    return c.noteKey(this.id);
  }
  private get notePub(): c.F {
    return c.notePublicKey(this.noteKey);
  }

  // ---------- reads ----------

  /** The tier the operator issued, from the allow-list on chain. */
  async getTier(): Promise<{ tier: Tier; revoked: boolean } | null> {
    const leaves = await treeLeaves(this.chain, this.allowList());
    for (const t of [3, 2, 1] as Tier[]) {
      if (leaves.includes(c.tierLeaf(this.idCommitment, this.j, t))) return { tier: t, revoked: false };
    }
    return null;
  }

  async getPack(jurisdiction: JurisdictionCode = this.jurisdiction): Promise<ActivePack> {
    return activePack(this.chain, this.d, JURISDICTIONS[jurisdiction]);
  }

  async getEpoch(jurisdiction: JurisdictionCode = this.jurisdiction): Promise<number> {
    return Number(await this.chain.read<bigint>(this.d.registry, "epoch", { jurisdiction: JURISDICTIONS[jurisdiction] }));
  }

  /** Today's budget, recovered from BudgetStep events with the identity secret. */
  async getBudget(state?: PoolState): Promise<Budget> {
    const [st, pack, epoch, tier] = await Promise.all([
      state ?? poolState(this.chain, this.d),
      this.getPack(),
      this.getEpoch(),
      this.getTier(),
    ]);
    const t = tier?.tier ?? 1;
    const [perPayment, daily] = pack.tiers[t - 1]!;
    const { spent } = this.budgetState(st, epoch);
    const nextMidnight = (epoch + 1) * 86400 - pack.utcOffsetSecs;
    return {
      tier: t,
      spentTodayUsd: stroopsToUsd(spent),
      dailyLimitUsd: stroopsToUsd(daily),
      perPaymentLimitUsd: stroopsToUsd(perPayment),
      resetsAt: new Date(nextMidnight * 1000).toISOString(),
    };
  }

  /** Private balance: the user's unspent notes, found by decrypting note outputs. */
  async getBalance(state?: PoolState): Promise<Balance & { notes: OwnedNote[] }> {
    const st = state ?? (await poolState(this.chain, this.d));
    const notes = this.ownedNotes(st);
    return { shieldedUsd: stroopsToUsd(notes.reduce((a, n) => a + n.amount, 0n)), notes };
  }

  private allowList(j = this.j): string {
    const a = this.d.allowLists[j];
    if (!a) throw new Error(`no allow-list for jurisdiction ${j}`);
    return a;
  }

  private budgetState(st: PoolState, epoch: number): { seq: number; spent: bigint; leafIndex: number | null } {
    let seq = 0;
    let spent = 0n;
    let leafIndex: number | null = null;
    for (;;) {
      const n = c.budgetNullifier(this.id, epoch, seq);
      if (!st.budgetSteps.some((b) => b.nullifier === n)) break;
      const k = c.budgetKey(this.id, epoch, seq + 1);
      const step = st.budgetSteps.find((b) => {
        const v = BigInt(c.sub(b.encNewSpent, k));
        return v < 2n ** 65n && b.commitment === c.budgetCommitment(this.id, epoch, seq + 1, v);
      });
      if (!step) throw new Error(`budget state ${seq + 1} not found on chain`);
      spent = BigInt(c.sub(step.encNewSpent, k));
      leafIndex = st.budgetLeaves.indexOf(step.commitment);
      seq += 1;
    }
    return { seq, spent, leafIndex };
  }

  private ownedNotes(st: PoolState): OwnedNote[] {
    const sk = encryptionKeys(this.id).secretKey;
    const out: OwnedNote[] = [];
    for (const n of st.notes) {
      const o = openNote(sk, n.encryptedOutput);
      if (!o || o.amount === 0n) continue;
      if (c.noteCommitment(o.amount, this.notePub, o.blinding) !== n.commitment) continue; // not really ours
      const idx = String(n.index);
      const nul = c.noteNullifier(n.commitment, idx, c.noteSignature(this.noteKey, n.commitment, idx));
      if (st.nullifiers.has(nul)) continue;
      out.push({ index: n.index, amount: o.amount, blinding: o.blinding, commitment: n.commitment });
    }
    return out;
  }

  // ---------- writes ----------

  /** One-time: let this Stellar account hold the pool's token (signed by the wallet). */
  async addTokenTrustline(): Promise<{ txHash: string }> {
    return { txHash: await this.chain.addTrustline(this.d.asset.code, this.d.asset.issuer) };
  }

  /**
   * Testnet onboarding through a Clearance onboarding service
   * (packages/onboarding): makes sure the Stellar account exists (friendbot)
   * and trusts CLRUSD (signed in the user's wallet), then asks the service to
   * grant test CLRUSD and have this jurisdiction's operator issue tier 1
   * on-chain. Resolves once the tier is visible on-chain.
   */
  async onboard(serviceUrl: string): Promise<OnboardResult> {
    if (this.d.networkPassphrase !== Networks.TESTNET) throw new Error("onboarding is a testnet service");
    try {
      await this.chain.server.getAccount(this.address);
    } catch {
      const fb = await fetch(`https://friendbot.stellar.org/?addr=${encodeURIComponent(this.address)}`);
      if (!fb.ok) throw new Error(`friendbot could not fund ${this.address} (${fb.status})`);
      // The RPC can be a ledger or two behind friendbot: wait until it sees the account.
      for (let i = 0; ; i++) {
        try {
          await this.chain.server.getAccount(this.address);
          break;
        } catch (e) {
          if (i >= 15) throw e;
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    }
    let trustlineTx: string | undefined;
    try {
      await this.getPublicBalance();
    } catch {
      trustlineTx = (await this.addTokenTrustline()).txHash;
    }
    const res = await fetch(serviceUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: this.address, idCommitment: this.idCommitment, jurisdiction: this.jurisdiction }),
    });
    const body = (await res.json().catch(() => ({}))) as Partial<OnboardResult> & { error?: string; message?: string };
    if (!res.ok) throw new Error(`onboarding refused: ${body.error ?? res.status}${body.message ? `: ${body.message}` : ""}`);
    for (let i = 0; i < 20 && !(await this.getTier()); i++) await new Promise((r) => setTimeout(r, 1500));
    return { ...(body as OnboardResult), ...(trustlineTx ? { trustlineTx } : {}) };
  }

  /** Public token balance of the connected Stellar account (stroops). */
  async getPublicBalance(): Promise<bigint> {
    return BigInt(await this.chain.read<bigint>(this.d.token, "balance", { id: this.address }));
  }

  /** Move public tokens into the private balance. Counts 0 towards limits. */
  async deposit(amountUsd: number, onProgress?: SendParams["onProgress"]): Promise<Receipt> {
    return this.transact({ deposit: usdToStroops(amountUsd), pay: 0n, to: null, withdrawTo: null, receiver: this.jurisdiction, onProgress });
  }

  /**
   * Pay privately (to a `clr:` address) or publicly out of the pool (to a
   * Stellar G... address, a withdrawal). Both count towards the limits.
   */
  async send(p: SendParams): Promise<Receipt> {
    const amount = usdToStroops(p.amountUsd);
    const receiver = p.toJurisdiction ?? this.jurisdiction;
    const shielded = parseClearanceAddress(p.to);
    if (shielded) return this.transact({ deposit: 0n, pay: amount, to: shielded, withdrawTo: null, receiver, onProgress: p.onProgress });
    return this.transact({ deposit: 0n, pay: 0n, to: null, withdrawTo: { address: p.to, amount }, receiver, onProgress: p.onProgress });
  }

  private async transact(t: {
    deposit: bigint;
    pay: bigint;
    to: { pubKey: c.F; enc: Uint8Array } | null;
    withdrawTo: { address: string; amount: bigint } | null;
    receiver: JurisdictionCode;
    onProgress?: SendParams["onProgress"];
  }): Promise<Receipt> {
    const t0 = performance.now();
    const step = (s: ProofStep) => t.onProgress?.({ step: s, elapsedMs: performance.now() - t0 });
    const withdrawal = t.withdrawTo?.amount ?? 0n;
    const sent = t.pay + withdrawal;

    const [st, sPack, rPack, epoch, tier, ids] = await Promise.all([
      poolState(this.chain, this.d),
      this.getPack(),
      this.getPack(t.receiver),
      this.getEpoch(),
      this.getTier(),
      treeLeaves(this.chain, this.allowList()),
    ]);

    // Friendly pre-checks; the circuit and the pool enforce the same rules.
    if (!tier) throw new ClearanceError("NOT_IN_ALLOW_LIST", { step: "identity" });
    const [perPayment, daily] = sPack.tiers[tier.tier - 1]!;
    if (sent > perPayment) throw new ClearanceError("OVER_PER_PAYMENT_LIMIT", { limitUsd: stroopsToUsd(perPayment), step: "perPayment" });
    const budget = this.budgetState(st, epoch);
    if (budget.spent + sent > daily) {
      throw new ClearanceError("OVER_DAILY_BUDGET", { limitUsd: stroopsToUsd(daily), remainingUsd: stroopsToUsd(daily - budget.spent), step: "dailyBudget" });
    }
    const owned = this.ownedNotes(st).sort((a, b) => (a.amount < b.amount ? 1 : -1));
    const spend: OwnedNote[] = [];
    let have = 0n;
    for (const n of owned) {
      if (have + t.deposit >= sent || spend.length === 2) break;
      spend.push(n);
      have += n.amount;
    }
    if (have + t.deposit < sent) throw new ClearanceError("INSUFFICIENT_BALANCE");
    step("identity");

    // ---- circuit inputs (as e2e/src/tests/world.rs Mirror::payment) ----
    const leaves = st.notes.map((n) => n.commitment);
    const nk = this.noteKey;
    const me = this.notePub;
    const ins = [0, 1].map((k) => {
      const n = spend[k];
      if (n) {
        const { bits, path } = c.noteTreeProof(leaves, n.index, LEVELS.pool);
        return { amount: n.amount, blinding: n.blinding, bits, path };
      }
      return { amount: 0n, blinding: c.randomField(), bits: "0", path: Array(LEVELS.pool).fill("0") as string[] };
    });
    const change = have + t.deposit - sent;
    const out0 = { pk: t.to?.pubKey ?? me, amount: t.pay, blinding: c.randomField() };
    const out1 = { pk: me, amount: change, blinding: c.randomField() };
    const myEnc = encryptionKeys(this.id).publicKey;
    const ext = {
      recipient: t.withdrawTo?.address ?? this.address,
      extAmount: t.deposit - withdrawal,
      encryptedOutput0: sealNote(t.to?.enc ?? myEnc, out0.amount, out0.blinding),
      encryptedOutput1: sealNote(myEnc, out1.amount, out1.blinding),
    };
    const extHash = extDataHash(this.d, ext);
    const extHashF = BigInt("0x" + Buffer.from(extHash).toString("hex")).toString();

    const idIndex = ids.indexOf(c.tierLeaf(this.idCommitment, this.j, tier.tier));
    const idProof = c.listTreeProof(ids, idIndex, LEVELS.identity);
    const bProof =
      budget.leafIndex === null
        ? { bits: "0", path: Array(LEVELS.budget).fill("0") as string[] }
        : c.listTreeProof(st.budgetLeaves, budget.leafIndex, LEVELS.budget);
    const packInputs = (p: ActivePack, pre: string) => ({
      [`${pre}Version`]: String(p.version),
      [`${pre}UtcOffsetShifted`]: c.offsetShifted(p.utcOffsetSecs),
      [`${pre}Threshold`]: p.travelRuleThreshold.toString(),
      [`${pre}PerPayment`]: p.tiers.map((x) => x[0].toString()),
      [`${pre}Daily`]: p.tiers.map((x) => x[1].toString()),
      [`${pre}OperatorKey`]: [p.operatorKey.x, p.operatorKey.y],
    });
    const inputs: Record<string, unknown> = {
      root: c.noteTreeRoot(leaves, LEVELS.pool),
      publicAmount: c.f(t.deposit - withdrawal),
      extDataHash: extHashF,
      nonce: extHashF,
      inputNullifier: ins.map((i) => {
        const cm = c.noteCommitment(i.amount, me, i.blinding);
        return c.noteNullifier(cm, i.bits, c.noteSignature(nk, cm, i.bits));
      }),
      inAmount: ins.map((i) => i.amount.toString()),
      inPrivateKey: [nk, nk],
      inBlinding: ins.map((i) => i.blinding),
      inPathIndices: ins.map((i) => i.bits),
      inPathElements: ins.map((i) => i.path),
      outputCommitment: [out0, out1].map((o) => c.noteCommitment(o.amount, o.pk, o.blinding)),
      outAmount: [out0.amount.toString(), out1.amount.toString()],
      outPubkey: [out0.pk, out1.pk],
      outBlinding: [out0.blinding, out1.blinding],
      deposit: t.deposit.toString(),
      withdrawal: withdrawal.toString(),
      identityRoot: c.listTreeRoot(ids, LEVELS.identity),
      idSecret: this.id,
      tier: String(tier.tier),
      issuance: "0",
      idPathElements: idProof.path,
      idPathIndices: idProof.bits,
      budgetRoot: c.listTreeRoot(st.budgetLeaves, LEVELS.budget),
      epoch: String(epoch),
      budgetSeq: String(budget.seq),
      budgetSpent: budget.spent.toString(),
      budgetPathElements: bProof.path,
      budgetPathIndices: bProof.bits,
      senderJurisdiction: String(this.j),
      receiverJurisdiction: String(JURISDICTIONS[t.receiver]),
      senderPackHash: sPack.hash,
      receiverPackHash: rPack.hash,
      ...packInputs(sPack, "s"),
      ...packInputs(rPack, "r"),
      recordSalt: [c.randomField(), c.randomField()],
    };

    step("perPayment");
    // The pre-checks above raise the specific codes; a ConstraintError here
    // means some other rule failed in the circuit, and is surfaced as is.
    const proved = await this.engine.prove(inputs);
    step("dailyBudget");
    step("sealed");
    const ps = proved.publicSignals.map((x) => BigInt(x));
    const b = (x: Uint8Array) => Buffer.from(x);
    const proof = {
      proof: { a: b(proved.proof.slice(0, 64)), b: b(proved.proof.slice(64, 192)), c: b(proved.proof.slice(192, 256)) },
      budget_nullifier: ps[0],
      new_budget_commitment: ps[1],
      enc_new_spent: ps[2],
      record_r: ps.slice(3, 7),
      record_c: ps.slice(7, 13),
      root: ps[13],
      public_amount: ps[14],
      ext_data_hash: b(extHash),
      input_nullifiers: ps.slice(16, 18),
      output_commitment0: ps[18],
      output_commitment1: ps[19],
      identity_root: ps[21],
      budget_root: ps[22],
      epoch: ps[23],
      sender_jurisdiction: Number(ps[24]),
      receiver_jurisdiction: Number(ps[25]),
      sender_pack_hash: ps[26],
      receiver_pack_hash: ps[27],
    };
    step("submitting");
    let res;
    try {
      res = await this.chain.write(this.d.pool, "transact", {
        proof,
        ext_data: {
          recipient: ext.recipient,
          ext_amount: ext.extAmount,
          encrypted_output0: b(ext.encryptedOutput0),
          encrypted_output1: b(ext.encryptedOutput1),
        },
        sender: this.address,
      });
    } catch (e) {
      if (/reject|denied|cancel/i.test(String(e))) throw new ClearanceError("WALLET_REJECTED");
      throw e;
    }
    step("verified");
    const packId = (p: ActivePack) => `${codeOf(p.jurisdiction)}-v${p.version}` as PackId;
    return {
      proved: { tier: true, perPayment: true, dailyBudget: true, sealed: true },
      txHash: res.hash,
      provingMs: Math.round(proved.witnessMs + proved.provingMs),
      explorerUrl: this.d.explorerTx(res.hash),
      packId: packId(sPack),
      receiverPackId: packId(rPack),
      budget: await this.getBudget(),
    };
  }
}
