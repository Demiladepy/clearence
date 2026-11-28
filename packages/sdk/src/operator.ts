/**
 * The operator console API: one licensed operator per jurisdiction.
 *
 * - publishes its country's rule pack (registry.set_pack, signed by its wallet)
 * - issues KYC tiers (inserts the tier leaf into its own allow-list)
 * - lists and opens its copies of sealed records from the pool's events
 *
 * The operator's record key (Baby JubJub scalar) never leaves the operator's
 * machine; records are opened locally.
 */
import { Chain } from "./chain.js";
import { TESTNET, type Deployment, stroopsToUsd, usdToStroops } from "./config.js";
import * as c from "./crypto.js";
import { ClearanceError } from "./errors.js";
import { activePack, poolState, type ActivePack, type SealedRecordEvent } from "./state.js";
import {
  JURISDICTIONS,
  type JurisdictionCode,
  type ListRecordsParams,
  type OpenedRecord,
  type PackId,
  type SealedRecordSummary,
  type Tier,
  type WalletLike,
} from "./types.js";

export interface OperatorOptions {
  wallet: WalletLike;
  jurisdiction: JurisdictionCode;
  /** Operator record key (Baby JubJub private scalar, decimal or 0x hex). */
  recordKey: string;
  deployment?: Deployment;
}

export interface PackRules {
  utcOffsetSecs: number;
  travelRuleThresholdUsd: number;
  tiers: { perPaymentUsd: number; dailyUsd: number }[];
}

const codeOf = (j: number): JurisdictionCode =>
  (Object.entries(JURISDICTIONS).find(([, v]) => v === j)?.[0] ?? "NG") as JurisdictionCode;

export class ClearanceOperator {
  private constructor(
    readonly chain: Chain,
    readonly d: Deployment,
    readonly jurisdiction: JurisdictionCode,
    private readonly key: c.F,
  ) {}

  static async connect(o: OperatorOptions): Promise<ClearanceOperator> {
    await c.initCrypto();
    const d = o.deployment ?? TESTNET;
    const { address } = await o.wallet.getAddress();
    return new ClearanceOperator(new Chain(d, o.wallet, address), d, o.jurisdiction, c.f(o.recordKey));
  }

  private get j(): number {
    return JURISDICTIONS[this.jurisdiction];
  }

  /** Operator record public key, as published in the pack. */
  get recordPublicKey(): { x: c.F; y: c.F } {
    return c.operatorPublicKey(this.key);
  }

  async getActivePack(): Promise<ActivePack & { id: PackId }> {
    const p = await activePack(this.chain, this.d, this.j);
    return { ...p, id: `${this.jurisdiction}-v${p.version}` as PackId };
  }

  /** Publish a new pack version; it becomes active immediately. */
  async publishPack(rules: PackRules): Promise<{ packId: PackId; packHash: c.F; txHash: string }> {
    const res = await this.chain.write(this.d.registry, "set_pack", {
      jurisdiction: this.j,
      rules: {
        utc_offset_secs: rules.utcOffsetSecs,
        travel_rule_threshold: usdToStroops(rules.travelRuleThresholdUsd),
        tiers: rules.tiers.map((t) => ({ per_payment: usdToStroops(t.perPaymentUsd), daily: usdToStroops(t.dailyUsd) })),
        operator_key: { x: BigInt(this.recordPublicKey.x), y: BigInt(this.recordPublicKey.y) },
      },
    });
    const p = await this.getActivePack();
    return { packId: p.id, packHash: p.hash, txHash: res.hash };
  }

  /** Issue a KYC tier: insert the tier leaf into this jurisdiction's allow-list. */
  async issueTier(params: { idCommitment: string; tier: Tier }): Promise<{ txHash: string }> {
    const leaf = c.tierLeaf(c.f(params.idCommitment), this.j, params.tier);
    const list = this.d.allowLists[this.j];
    if (!list) throw new Error(`no allow-list for ${this.jurisdiction}`);
    const res = await this.chain.write(list, "insert_leaf", { leaf: BigInt(leaf) });
    return { txHash: res.hash };
  }

  /** Records this operator holds a copy of (sender or receiver side). */
  async listRecords(params: ListRecordsParams = {}): Promise<SealedRecordSummary[]> {
    const st = await poolState(this.chain, this.d);
    const from = params.from ? new Date(params.from).getTime() : -Infinity;
    const to = params.to ? new Date(params.to).getTime() : Infinity;
    const out: SealedRecordSummary[] = [];
    for (const r of st.records) {
      const k = this.copyIndex(r);
      if (k === null) continue;
      const ts = await this.ledgerTime(r.ledger);
      if (ts < from || ts > to) continue;
      out.push({
        recordId: r.id,
        txHash: r.txHash,
        timestamp: new Date(ts).toISOString(),
        epoch: r.epoch,
        packId: `${codeOf(k === 0 ? r.senderJurisdiction : r.receiverJurisdiction)}-v?` as PackId,
        sealedRecordHex: [r.r[2 * k], r.r[2 * k + 1], r.c[3 * k], r.c[3 * k + 1], r.c[3 * k + 2]]
          .map((x) => BigInt(x!).toString(16).padStart(64, "0"))
          .join(""),
      });
    }
    return out;
  }

  /** Open this operator's copy of a record with the record key. */
  async openRecord(recordId: string): Promise<OpenedRecord> {
    const st = await poolState(this.chain, this.d);
    const r = st.records.find((x) => x.id === recordId);
    if (!r) throw new Error(`record ${recordId} not found`);
    const k = this.copyIndex(r);
    if (k === null) throw new ClearanceError("RECORD_KEY_INVALID");
    const o = c.openSealedRecord([r.r[2 * k]!, r.r[2 * k + 1]!], [r.c[3 * k]!, r.c[3 * k + 1]!, r.c[3 * k + 2]!], this.key);
    // A wrong key yields field noise; a real record carries a sane amount.
    if (o.sent >= 2n ** 64n) throw new ClearanceError("RECORD_KEY_INVALID");
    const version = await this.packVersion(k === 0 ? r.senderJurisdiction : r.receiverJurisdiction, k === 0 ? r.senderPackHash : r.receiverPackHash);
    return {
      recordId,
      sender: o.idCommitment,
      receiver: o.receiver,
      amountUsd: stroopsToUsd(o.sent),
      epoch: r.epoch,
      travelRuleFlag: o.travelRuleFlag,
      senderJurisdiction: codeOf(r.senderJurisdiction),
      receiverJurisdiction: codeOf(r.receiverJurisdiction),
      packVersion: `${codeOf(k === 0 ? r.senderJurisdiction : r.receiverJurisdiction)}-v${version}` as PackId,
    };
  }

  /** Open the corridor from this jurisdiction to `to` (the receiver's operator must accept). */
  async openCorridor(to: JurisdictionCode): Promise<{ txHash: string }> {
    return { txHash: (await this.chain.write(this.d.registry, "open_corridor", { from: this.j, to: JURISDICTIONS[to] })).hash };
  }
  async acceptCorridor(from: JurisdictionCode): Promise<{ txHash: string }> {
    return { txHash: (await this.chain.write(this.d.registry, "accept_corridor", { from: JURISDICTIONS[from], to: this.j })).hash };
  }

  /** 0 if this operator is the sender's, 1 if the receiver's (domestic: 0). */
  private copyIndex(r: SealedRecordEvent): 0 | 1 | null {
    if (r.senderJurisdiction === this.j) return 0;
    if (r.receiverJurisdiction === this.j) return 1;
    return null;
  }

  private async packVersion(j: number, hash: c.F): Promise<number> {
    const active = await activePack(this.chain, this.d, j);
    for (let v = active.version; v >= 1; v--) {
      const p = await this.chain.read<{ hash: bigint }>(this.d.registry, "pack", { jurisdiction: j, version: v });
      if (BigInt(p.hash).toString() === hash) return v;
    }
    return 0;
  }

  private ledgerTimes = new Map<number, number>();
  private async ledgerTime(ledger: number): Promise<number> {
    const hit = this.ledgerTimes.get(ledger);
    if (hit !== undefined) return hit;
    const l = await this.chain.server.getLedgers({ startLedger: ledger, pagination: { limit: 1 } });
    const t = Number(l.ledgers[0]?.ledgerCloseTime ?? 0) * 1000;
    this.ledgerTimes.set(ledger, t);
    return t;
  }
}
