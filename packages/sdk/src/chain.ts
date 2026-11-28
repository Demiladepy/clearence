/**
 * Soroban access: typed contract calls (spec read from chain), signing via the
 * user's wallet, and event reading. Nothing here is simulated locally: every
 * read is a call against the network's state, every write a real transaction.
 */
import { Asset, BASE_FEE, Operation, TransactionBuilder, contract, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import type { Deployment } from "./config.js";
import type { WalletLike } from "./types.js";

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

  private client(id: string): Promise<contract.Client> {
    let c = this.clients.get(id);
    if (!c) {
      const wallet = this.wallet;
      c = contract.Client.from({
        contractId: id,
        rpcUrl: this.d.rpcUrl,
        networkPassphrase: this.d.networkPassphrase,
        allowHttp: this.d.rpcUrl.startsWith("http://"),
        ...(this.source ? { publicKey: this.source } : {}),
        ...(wallet
          ? {
              signTransaction: async (txXdr: string, opts?: { networkPassphrase?: string }) =>
                wallet.signTransaction(txXdr, { networkPassphrase: opts?.networkPassphrase ?? this.d.networkPassphrase }),
            }
          : {}),
      });
      this.clients.set(id, c);
    }
    return c;
  }

  /** Read-only call (simulated against current ledger state). */
  async read<T>(id: string, fn: string, args: Record<string, unknown> = {}): Promise<T> {
    const c = (await this.client(id)) as unknown as Record<string, (a: unknown) => Promise<contract.AssembledTransaction<unknown>>>;
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

  /** All events of `ids` from the deployment's start ledger, in order. */
  async events(ids: string[], startLedger = this.d.startLedger): Promise<ChainEvent[]> {
    const out: ChainEvent[] = [];
    let cursor: string | undefined;
    for (;;) {
      const req: rpc.Server.GetEventsRequest = cursor
        ? { cursor, filters: [{ type: "contract", contractIds: ids }], limit: 1000 }
        : { startLedger, filters: [{ type: "contract", contractIds: ids }], limit: 1000 };
      const page = await this.server.getEvents(req);
      for (const e of page.events) {
        out.push({
          id: e.id,
          ledger: e.ledger,
          txHash: e.txHash,
          contractId: e.contractId?.toString() ?? "",
          topics: e.topic.map((t: xdr.ScVal) => scValToNative(t)),
          data: (scValToNative(e.value) ?? {}) as Record<string, unknown>,
        });
      }
      // The RPC scans a bounded ledger window per request, so a short page is
      // not the end: keep going until the cursor reaches the latest ledger.
      // (A cursor is a TOID: the ledger sequence is its top 32 bits.)
      if (!page.cursor) break;
      const scannedTo = Number(BigInt(page.cursor.split("-")[0]!) >> 32n);
      if (page.events.length < 1000 && scannedTo >= page.latestLedger) break;
      cursor = page.cursor;
    }
    return out;
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

/** contract.Client wraps contract `Result`s; unwrap them and throw on `Err`. */
function unwrap(v: unknown): unknown {
  if (v && typeof v === "object" && "isOk" in v && typeof (v as { isOk: unknown }).isOk === "function") {
    const r = v as { isOk(): boolean; unwrap(): unknown; unwrapErr(): unknown };
    if (r.isOk()) return r.unwrap();
    throw new Error(`contract error: ${JSON.stringify(r.unwrapErr())}`);
  }
  return v;
}
