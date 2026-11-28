/**
 * Soroban access: typed contract calls (spec read from chain), signing via the
 * user's wallet, and event reading. Nothing here is simulated locally: every
 * read is a call against the network's state, every write a real transaction.
 */
import { Asset, BASE_FEE, Operation, TransactionBuilder, contract, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import type { Deployment } from "./config.js";
import type { WalletLike } from "./types.js";
import { ClearanceError } from "./errors.js";

/** The file scripts/archive-events.mjs writes. */
export interface EventArchive {
  networkPassphrase: string;
  startLedger: number;
  /** Every event of `contracts` in [startLedger, toLedger] is included. */
  toLedger: number;
  contracts: string[];
  events: { id: string; ledger: number; txHash: string; contractId: string; topic: string[]; value: string }[];
}

export interface ChainEvent {
  id: string;
  ledger: number;
  txHash: string;
  contractId: string;
  /** Decoded topics: first is the event name. */
  topics: unknown[];
  /** Decoded data (a struct decodes to an object with snake_case keys). */
  data: Record<string, unknown>;
}

export interface Sent {
  hash: string;
  ledger: number;
  result: unknown;
}

export class Chain {
  readonly server: rpc.Server;
  private clients = new Map<string, Promise<contract.Client>>();

  constructor(
    readonly d: Deployment,
    private readonly wallet?: WalletLike,
    private readonly source?: string,
  ) {
    this.server = new rpc.Server(d.rpcUrl, { allowHttp: d.rpcUrl.startsWith("http://") });
  }

  /**
   * `signer` false: a client with no source account, for reads. Simulation
   * then needs no account on chain, so a visitor whose account does not exist
   * yet can still read (getTier before onboarding).
   */
  private client(id: string, signer = true): Promise<contract.Client> {
    const key = signer ? id : `read:${id}`;
    let c = this.clients.get(key);
    if (!c) {
      const wallet = signer ? this.wallet : undefined;
      c = contract.Client.from({
        contractId: id,
        rpcUrl: this.d.rpcUrl,
        networkPassphrase: this.d.networkPassphrase,
        allowHttp: this.d.rpcUrl.startsWith("http://"),
        ...(signer && this.source ? { publicKey: this.source } : {}),
        ...(wallet
          ? {
              signTransaction: async (txXdr: string, opts?: { networkPassphrase?: string }) =>
                wallet.signTransaction(txXdr, { networkPassphrase: opts?.networkPassphrase ?? this.d.networkPassphrase }),
            }
          : {}),
      });
      this.clients.set(key, c);
    }
    return c;
  }

  /** Read-only call (simulated against current ledger state). */
  async read<T>(id: string, fn: string, args: Record<string, unknown> = {}): Promise<T> {
    const c = (await this.client(id, false)) as unknown as Record<string, (a: unknown) => Promise<contract.AssembledTransaction<unknown>>>;
    const method = c[fn];
    if (!method) throw new Error(`${id} has no method ${fn}`);
    const tx = await method.call(c, args);
    return unwrap(tx.result) as T;
  }

  /** Signed, submitted transaction. Throws with the contract error if it fails. */
  async write(id: string, fn: string, args: Record<string, unknown>): Promise<Sent> {
    if (!this.wallet || !this.source) throw new Error("a wallet is needed to send transactions");
    const c = (await this.client(id)) as unknown as Record<string, (a: unknown) => Promise<contract.AssembledTransaction<unknown>>>;
    const method = c[fn];
    if (!method) throw new Error(`${id} has no method ${fn}`);
    const tx = await method.call(c, args);
    const sent = await tx.signAndSend();
    const res = sent.getTransactionResponse as rpc.Api.GetSuccessfulTransactionResponse | undefined;
    const hash = sent.sendTransactionResponse?.hash ?? "";
    if (!res || res.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
      throw new Error(`transaction ${hash} did not succeed: ${res?.status ?? "unknown"}`);
    }
    return { hash, ledger: res.ledger, result: unwrap(sent.result) };
  }

  /**
   * All events of `ids` from the deployment's start ledger, in order: from the
   * event archive for ledgers it covers, then from the RPC for the rest. The
   * RPC keeps only ~7 days of events, so without an archive older state is
   * gone (HISTORY_UNAVAILABLE).
   */
  async events(ids: string[], startLedger = this.d.startLedger): Promise<ChainEvent[]> {
    const out: ChainEvent[] = [];
    const seen = new Set<string>();
    const push = (e: ChainEvent) => {
      if (!seen.has(e.id)) {
        seen.add(e.id);
        out.push(e);
      }
    };
    let from = startLedger;
    const a = await this.archive();
    if (a && a.startLedger <= startLedger && ids.every((id) => a.contracts.includes(id))) {
      for (const e of a.events) {
        if (e.ledger < startLedger || !ids.includes(e.contractId)) continue;
        push(decodeEvent(e.id, e.ledger, e.txHash, e.contractId, e.topic.map((t) => xdr.ScVal.fromXDR(t, "base64")), xdr.ScVal.fromXDR(e.value, "base64")));
      }
      from = Math.max(from, a.toLedger + 1);
    }

    let cursor: string | undefined;
    for (;;) {
      const req: rpc.Server.GetEventsRequest = cursor
        ? { cursor, filters: [{ type: "contract", contractIds: ids }], limit: 1000 }
        : { startLedger: from, filters: [{ type: "contract", contractIds: ids }], limit: 1000 };
      let page: rpc.Api.GetEventsResponse;
      try {
        page = await this.server.getEvents(req);
      } catch (e) {
        if (cursor) throw e;
        // The start ledger is outside what the RPC holds: either the archive is
        // already ahead of its latest ledger (nothing newer to read), or the
        // range is older than its retention and no archive covers it.
        const { oldestLedger, latestLedger } = await this.server.getHealth();
        if (from > latestLedger) break;
        if (from < oldestLedger) throw new ClearanceError("HISTORY_UNAVAILABLE");
        throw e;
      }
      for (const e of page.events) push(decodeEvent(e.id, e.ledger, e.txHash, e.contractId?.toString() ?? "", e.topic, e.value));
      // The RPC scans a bounded ledger window per request, so a short page is
      // not the end: keep going until the cursor reaches the latest ledger.
      // (A cursor is a TOID: the ledger sequence is its top 32 bits.)
      if (!page.cursor) break;
      const scannedTo = Number(BigInt(page.cursor.split("-")[0]!) >> 32n);
      if (page.events.length < 1000 && scannedTo >= page.latestLedger) break;
      cursor = page.cursor;
    }
    return out.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  }

  private archiveCache?: { at: number; p: Promise<EventArchive | null> };
  /** The deployment's event archive, fetched at most once a minute; null if none or unreachable. */
  archive(): Promise<EventArchive | null> {
    const url = this.d.archiveUrl;
    if (!url) return Promise.resolve(null);
    if (this.archiveCache && Date.now() - this.archiveCache.at < 60_000) return this.archiveCache.p;
    const p = (async () => {
      for (let i = 1; i <= 3; i++) {
        try {
          const r = await fetch(url, { cache: "no-store" });
          if (r.status === 404) return null;
          if (!r.ok) throw new Error(`archive: HTTP ${r.status}`);
          const a = (await r.json()) as EventArchive;
          return a.networkPassphrase === this.d.networkPassphrase ? a : null;
        } catch {
          // A dropped connection or a server hiccup: try again before giving up.
          if (i < 3) await new Promise((res) => setTimeout(res, 500 * i));
        }
      }
      this.archiveCache = undefined; // do not remember a failure
      return null; // unreachable: fall back to the RPC alone
    })();
    this.archiveCache = { at: Date.now(), p };
    return p;
  }

  /** Classic changeTrust for `code:issuer`, signed by the wallet, sent via RPC. */
  async addTrustline(code: string, issuer: string): Promise<string> {
    if (!this.wallet || !this.source) throw new Error("a wallet is needed to send transactions");
    const account = await this.server.getAccount(this.source);
    const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: this.d.networkPassphrase })
      .addOperation(Operation.changeTrust({ asset: new Asset(code, issuer) }))
      .setTimeout(60)
      .build();
    const { signedTxXdr } = await this.wallet.signTransaction(tx.toXDR(), { networkPassphrase: this.d.networkPassphrase });
    const sent = await this.server.sendTransaction(TransactionBuilder.fromXDR(signedTxXdr, this.d.networkPassphrase));
    if (sent.status === "ERROR") throw new Error(`trustline rejected: ${JSON.stringify(sent.errorResult)}`);
    const res = await this.server.pollTransaction(sent.hash);
    if (res.status !== rpc.Api.GetTransactionStatus.SUCCESS) throw new Error(`trustline ${sent.hash}: ${res.status}`);
    return sent.hash;
  }

  async latestLedger(): Promise<number> {
    return (await this.server.getLatestLedger()).sequence;
  }
}

function decodeEvent(id: string, ledger: number, txHash: string, contractId: string, topic: xdr.ScVal[], value: xdr.ScVal): ChainEvent {
  return {
    id,
    ledger,
    txHash,
    contractId,
    topics: topic.map((t) => scValToNative(t)),
    data: (scValToNative(value) ?? {}) as Record<string, unknown>,
  };
}

/** contract.Client wraps contract `Result`s; unwrap them and throw on `Err`. */
function unwrap(v: unknown): unknown {
  if (v && typeof v === "object" && "isOk" in v && typeof (v as { isOk: unknown }).isOk === "function") {
    const r = v as { isOk(): boolean; unwrap(): unknown; unwrapErr(): unknown };
    if (r.isOk()) return r.unwrap();
    throw new Error(`contract error: ${JSON.stringify(r.unwrapErr())}`);
  }
  return v;
}
