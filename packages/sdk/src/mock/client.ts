import { ClearanceError } from "../errors.js";
import { epochOf, epochResetsAt, formatNgn, stroopsToUsd, usdToStroops } from "../rulePacks.js";
import type {
  Balance,
  Budget,
  ConnectOptions,
  IssueTierParams,
  ListRecordsParams,
  OpenedRecord,
  PackChangedEvent,
  PackId,
  ProofProgress,
  ProofStep,
  PublicTransferView,
  Receipt,
  RulePack,
  SealedRecordSummary,
  SendParams,
  Tier,
  TierUpgradeRequest,
} from "../types.js";
import { chain, randomHex, SEALED_RECORD_BYTES, sleep, type IdentityState } from "./store.js";

const EXPLORER = "https://stellar.expert/explorer/testnet/tx/";
/** Money math matches the circuit: USDC stroops (7 decimals). */
const toStroopPrecision = (n: number) => stroopsToUsd(usdToStroops(n));

export interface IdentityInfo {
  idCommitment: string | null;
  tier: Tier | null;
  status: "unverified" | "active" | "revoked";
}

export class Clearance {
  private constructor(
    private readonly opts: ConnectOptions,
    private readonly address: string,
    /** Leaf version this client last fetched; stale after an upgrade elsewhere. */
    private leafVersion: number,
  ) {}

  static async connect(opts: ConnectOptions): Promise<Clearance> {
    const { address } = await opts.wallet.getAddress();
    const id = chain.identityForWallet(address);
    return new Clearance(opts, address, id?.leafVersion ?? 0);
  }

  get walletAddress(): string {
    return this.address;
  }

  /** Re-fetch this wallet's credential (after a tier change on another device). */
  async refresh(): Promise<void> {
    this.leafVersion = chain.identityForWallet(this.address)?.leafVersion ?? 0;
  }

  async getIdentity(): Promise<IdentityInfo> {
    const id = chain.identityForWallet(this.address);
    if (!id || id.tier === 0) return { idCommitment: id?.idCommitment ?? null, tier: null, status: "unverified" };
    return {
      idCommitment: id.idCommitment,
      tier: id.tier,
      status: id.leafVersion === this.leafVersion ? "active" : "revoked",
    };
  }

  async getActivePack(): Promise<RulePack> {
    return { ...chain.activePack };
  }

  onPackChanged(cb: (e: PackChangedEvent) => void): () => void {
    return chain.onPackChanged(cb);
  }

  async getBalance(): Promise<Balance> {
    const id = this.requireIdentity(false);
    return { shieldedUsd: toStroopPrecision(id.shieldedUsd) };
  }

  async deposit(amountUsd: number): Promise<{ txHash: string; explorerUrl: string }> {
    const id = this.requireIdentity(false);
    await this.sign();
    id.shieldedUsd += amountUsd;
    chain.ledger += 1;
    const txHash = randomHex(32).slice(2);
    return { txHash, explorerUrl: EXPLORER + txHash };
  }

  async getBudget(): Promise<Budget> {
    const id = this.requireIdentity(true);
    return this.budgetFor(id);
  }

  async send({ to, amountUsd, onProgress }: SendParams): Promise<Receipt> {
    const start = Date.now();
    const emit = (step: ProofStep) => onProgress?.({ step, elapsedMs: Date.now() - start } satisfies ProofProgress);
    const { provingMs, proofTimeoutMs } = chain.config;
    const stepDelay = provingMs / 4;
    if (provingMs > proofTimeoutMs) throw new ClearanceError("PROOF_TIMEOUT");

    if (!(amountUsd > 0)) throw new RangeError("amountUsd must be > 0");
    const id = this.requireIdentity(true);
    if (id.shieldedUsd < amountUsd) throw new ClearanceError("INSUFFICIENT_BALANCE");

    const pack = chain.activePack;
    const limits = pack.tiers[id.tier as Tier];
    const epoch = epochOf(chain.nowSec());
    const spent = chain.budgets.get(`${id.idCommitment}:${epoch}`) ?? 0;
    const newSpent = toStroopPrecision(spent + amountUsd);

    // The real circuit fails witness generation at the first broken
    // constraint; the mock mirrors that so the proof panel can stop there.
    await sleep(stepDelay);
    emit("identity");

    await sleep(stepDelay);
    if (amountUsd > limits.perPaymentLimitUsd) {
      throw new ClearanceError("OVER_PER_PAYMENT_LIMIT", {
        step: "perPayment",
        limitUsd: limits.perPaymentLimitUsd,
        limitLocal: formatNgn(limits.perPaymentLimitUsd),
      });
    }
    emit("perPayment");

    await sleep(stepDelay);
    if (newSpent > limits.dailyLimitUsd) {
      throw new ClearanceError("OVER_DAILY_BUDGET", {
        step: "dailyBudget",
        limitUsd: limits.dailyLimitUsd,
        limitLocal: formatNgn(limits.dailyLimitUsd),
        remainingUsd: toStroopPrecision(limits.dailyLimitUsd - spent),
      });
    }
    emit("dailyBudget");

    await sleep(stepDelay);
    emit("sealed");
    const provedAt = Date.now();

    emit("submitting");
    await this.sign();

    // --- "on-chain" effects ---
    chain.budgets.set(`${id.idCommitment}:${epoch}`, newSpent);
    id.shieldedUsd = toStroopPrecision(id.shieldedUsd - amountUsd);
    const receiverId = chain.identityForWallet(to);
    if (receiverId) receiverId.shieldedUsd = toStroopPrecision(receiverId.shieldedUsd + amountUsd);
    chain.ledger += 1;
    const txHash = randomHex(32).slice(2);
    chain.records.unshift({
      recordId: `rec_${chain.records.length + 1}`.padEnd(8, "0"),
      txHash,
      ledger: chain.ledger,
      timestamp: new Date(chain.nowSec() * 1000).toISOString(),
      epoch,
      packId: pack.id,
      packHash: pack.packHash,
      nullifiers: [randomHex(32), randomHex(32)],
      outputCommitments: [randomHex(32), randomHex(32)],
      sealedRecordHex: randomHex(SEALED_RECORD_BYTES),
      plaintext: {
        sender: id.idCommitment,
        receiver: receiverId?.idCommitment ?? to,
        amountUsd,
        travelRuleFlag: newSpent >= pack.travelRuleThresholdUsd,
      },
    });
    emit("verified");

    return {
      proved: { tier: true, perPayment: true, dailyBudget: true, sealed: true },
      txHash,
      provingMs: provedAt - start,
      explorerUrl: EXPLORER + txHash,
      packId: pack.id,
      budget: this.budgetFor(id),
    };
  }

  /**
   * Starts test-anchor KYC (SEP-24 interactive). From unverified this issues
   * Tier 1; otherwise it moves up one tier and revokes the old leaf (FR-6).
   */
  async requestTierUpgrade(): Promise<TierUpgradeRequest> {
    let id = chain.identityForWallet(this.address);
    if (!id) {
      // First contact: wallet derives idSecret locally; operator sees only the commitment.
      id = { idCommitment: randomHex(32), tier: 0, leafVersion: 0, shieldedUsd: 0 };
      chain.identities.set(id.idCommitment, id);
      chain.walletIdentity.set(this.address, id.idCommitment);
    }
    const ident = id;
    const target = Math.min(3, ident.tier + 1) as Tier;
    const interactiveUrl = `https://testanchor.stellar.org/sep24/interactive?mock=1&tier=${target}`;
    const done = new Promise<{ tier: Tier }>((resolve) => {
      const approve = (tier: Tier) => {
        issueTier(ident, tier);
        this.leafVersion = ident.leafVersion;
        resolve({ tier });
      };
      chain.pendingKyc.set(ident.idCommitment, approve);
      if (chain.config.kycAutoApproveMs !== null) {
        setTimeout(() => {
          if (chain.pendingKyc.get(ident.idCommitment) === approve) {
            chain.pendingKyc.delete(ident.idCommitment);
            approve(target);
          }
        }, chain.config.kycAutoApproveMs);
      }
    });
    return { interactiveUrl, done };
  }

  // ---------- internals ----------

  private requireIdentity(needTier: boolean): IdentityState {
    const id = chain.identityForWallet(this.address);
    if (!id || (needTier && id.tier === 0)) throw new ClearanceError("NOT_IN_ALLOW_LIST");
    if (needTier && id.leafVersion !== this.leafVersion) throw new ClearanceError("TIER_REVOKED");
    return id;
  }

  private budgetFor(id: IdentityState): Budget {
    const epoch = epochOf(chain.nowSec());
    const limits = chain.activePack.tiers[id.tier as Tier];
    return {
      tier: id.tier as Tier,
      spentTodayUsd: chain.budgets.get(`${id.idCommitment}:${epoch}`) ?? 0,
      dailyLimitUsd: limits.dailyLimitUsd,
      perPaymentLimitUsd: limits.perPaymentLimitUsd,
      resetsAt: epochResetsAt(epoch),
    };
  }

  private async sign(): Promise<void> {
    try {
      await this.opts.wallet.signTransaction("AAAA-mock-xdr", { networkPassphrase: "Test SDF Network ; September 2015" });
    } catch {
      throw new ClearanceError("WALLET_REJECTED");
    }
  }
}

function issueTier(id: IdentityState, tier: Tier): void {
  id.tier = tier;
  id.leafVersion += 1; // old leaf revoked in the allow-list
}

// ---------- operator ----------

export class Operator {
  private constructor(private readonly opts: ConnectOptions) {}

  static async connect(opts: ConnectOptions): Promise<Operator> {
    return new Operator(opts);
  }

  /** FR-1: add leaf H(idCommitment, tier) after KYC; revokes any older leaf. */
  async issueTier({ idCommitment, tier, displayName }: IssueTierParams): Promise<void> {
    let id = chain.identities.get(idCommitment);
    if (!id) {
      id = { idCommitment, tier: 0, leafVersion: 0, shieldedUsd: 0 };
      chain.identities.set(idCommitment, id);
    }
    if (displayName) id.displayName = displayName;
    chain.pendingKyc.get(idCommitment)?.(tier);
    chain.pendingKyc.delete(idCommitment);
    if (id.tier !== tier) issueTier(id, tier);
  }

  async listIdentities(): Promise<Array<{ idCommitment: string; displayName?: string; tier: Tier | null; pendingKyc: boolean }>> {
    return [...chain.identities.values()].map((i) => ({
      idCommitment: i.idCommitment,
      displayName: i.displayName,
      tier: i.tier === 0 ? null : i.tier,
      pendingKyc: chain.pendingKyc.has(i.idCommitment),
    }));
  }

  async getActivePack(): Promise<RulePack> {
    return { ...chain.activePack };
  }

  async setPack(packId: PackId): Promise<RulePack> {
    return { ...chain.setPack(packId) };
  }

  onPackChanged(cb: (e: PackChangedEvent) => void): () => void {
    return chain.onPackChanged(cb);
  }

  async listRecords({ from, to }: ListRecordsParams = {}): Promise<SealedRecordSummary[]> {
    const f = from ? new Date(from).getTime() : -Infinity;
    const t = to ? new Date(to).getTime() : Infinity;
    return chain.records
      .filter((r) => {
        const ts = new Date(r.timestamp).getTime();
        return ts >= f && ts <= t;
      })
      .map(({ recordId, txHash, timestamp, epoch, packId, sealedRecordHex }) => ({
        recordId,
        txHash,
        timestamp,
        epoch,
        packId,
        sealedRecordHex,
      }));
  }

  async openRecord(recordId: string, operatorKey: string): Promise<OpenedRecord> {
    const r = chain.records.find((x) => x.recordId === recordId);
    if (!r) throw new RangeError(`unknown record ${recordId}`);
    if (operatorKey !== chain.config.operatorKey) throw new ClearanceError("RECORD_KEY_INVALID");
    const sender = chain.identities.get(r.plaintext.sender);
    const receiver = chain.identities.get(r.plaintext.receiver);
    return {
      recordId,
      sender: r.plaintext.sender,
      senderName: sender?.displayName,
      receiver: receiver?.displayName ?? r.plaintext.receiver,
      amountUsd: r.plaintext.amountUsd,
      epoch: r.epoch,
      travelRuleFlag: r.plaintext.travelRuleFlag,
      packVersion: r.packId,
    };
  }
}

// ---------- public view ----------

export class PublicView {
  private constructor(private readonly opts: Omit<ConnectOptions, "wallet">) {}

  static async connect(opts: Omit<ConnectOptions, "wallet">): Promise<PublicView> {
    return new PublicView(opts);
  }

  /** FR-9: exactly what a block explorer can see for this transfer. */
  async getTransfer(txHash: string): Promise<PublicTransferView> {
    const r = chain.records.find((x) => x.txHash === txHash);
    if (!r) throw new RangeError(`unknown tx ${txHash}`);
    return {
      txHash: r.txHash,
      ledger: r.ledger,
      timestamp: r.timestamp,
      contractId: this.opts.pool,
      function: "transact",
      nullifiers: r.nullifiers,
      outputCommitments: r.outputCommitments,
      packHash: r.packHash,
      epoch: r.epoch,
      sealedRecordHex: r.sealedRecordHex,
      proofVerified: true,
    };
  }
}
