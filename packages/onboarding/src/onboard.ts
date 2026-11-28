/**
 * Testnet onboarding, the stand-in for a licensed app's sign-up + KYC backend.
 *
 * A visitor's browser makes its own Stellar account and CLRUSD trustline
 * (signed in their wallet), then asks this service to:
 *   1. have the jurisdiction's operator issue tier 1 on-chain (allow-list insert),
 *   2. grant test CLRUSD to the public balance (admin mint).
 * Keys stay on the server (env vars), never in the browser bundle.
 *
 * Abuse limits: once per Stellar account (refused if the account already holds
 * CLRUSD), per-IP rate limit (server.ts / api), and a capacity floor so the
 * allow-list (depth 10 = 1,024 identities per country) is never filled.
 * Idempotent: a retry after a partial failure completes the missing step.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import {
  Chain, JURISDICTIONS, LEVELS, TESTNET, initCrypto, keypairWallet, tierLeaf, treeLeaves, usdToStroops, type Deployment,
} from "@clearance/sdk";

export type Jurisdiction = "NG" | "GH";

export interface OnboardConfig {
  deployment: Deployment;
  /** CLRUSD issuer / token admin (mints the grant). */
  adminSecret: string;
  /** Operator account per jurisdiction (allow-list admin). */
  operatorSecrets: Partial<Record<Jurisdiction, string>>;
  grantUsd: number;
  /** Identities kept free in each allow-list for the operators' own use. */
  reserve: number;
}

export interface OnboardRequest {
  address: string;
  idCommitment: string;
  jurisdiction: string;
}

export class OnboardError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): OnboardConfig {
  const need = (k: string) => {
    const v = env[k];
    if (!v) throw new Error(`missing env ${k}`);
    return v;
  };
  const operatorSecrets: Partial<Record<Jurisdiction, string>> = {};
  if (env.CLR_NG_OPERATOR_SECRET) operatorSecrets.NG = env.CLR_NG_OPERATOR_SECRET;
  if (env.CLR_GH_OPERATOR_SECRET) operatorSecrets.GH = env.CLR_GH_OPERATOR_SECRET;
  if (!Object.keys(operatorSecrets).length) throw new Error("set CLR_NG_OPERATOR_SECRET and/or CLR_GH_OPERATOR_SECRET");
  return {
    deployment: { ...TESTNET, rpcUrl: env.CLEARANCE_RPC ?? TESTNET.rpcUrl },
    adminSecret: need("CLR_ADMIN_SECRET"),
    operatorSecrets,
    grantUsd: Number(env.CLR_GRANT_USD ?? 100),
    reserve: Number(env.CLR_ALLOW_LIST_RESERVE ?? 64),
  };
}

let cryptoReady: Promise<void> | null = null;
function crypto(): Promise<void> {
  if (!cryptoReady) {
    const wasm = createRequire(import.meta.url).resolve("@clearance/sdk/wasm");
    cryptoReady = initCrypto(readFileSync(wasm));
  }
  return cryptoReady;
}

/** One write at a time per signing account: Stellar sequence numbers are per account. */
const queues = new Map<string, Promise<unknown>>();
function serial<T>(key: string, f: () => Promise<T>): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(f);
  queues.set(key, next);
  return next;
}
async function retry<T>(f: () => Promise<T>, tries = 3): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await f();
    } catch (e) {
      // A concurrent instance may have used the sequence number: rebuild and resend.
      if (i >= tries || !/bad_?seq|txBadSeq|TRY_AGAIN_LATER/i.test(String(e))) throw e;
      await new Promise((r) => setTimeout(r, 1500 * i));
    }
  }
}

export function validate(req: unknown): OnboardRequest & { jurisdiction: Jurisdiction } {
  const r = (req ?? {}) as Record<string, unknown>;
  const address = String(r.address ?? "");
  const idCommitment = String(r.idCommitment ?? "");
  const jurisdiction = String(r.jurisdiction ?? "");
  if (!StrKey.isValidEd25519PublicKey(address)) throw new OnboardError(400, "BAD_ADDRESS", "address must be a Stellar G... account");
  if (!/^[0-9]{1,78}$/.test(idCommitment) || BigInt(idCommitment) === 0n || BigInt(idCommitment) >= P)
    throw new OnboardError(400, "BAD_ID_COMMITMENT", "idCommitment must be a decimal field element");
  if (jurisdiction !== "NG" && jurisdiction !== "GH") throw new OnboardError(400, "BAD_JURISDICTION", "jurisdiction must be NG or GH");
  return { address, idCommitment, jurisdiction };
}

export async function onboard(input: unknown, cfg: OnboardConfig) {
  const req = validate(input);
  const opSecret = cfg.operatorSecrets[req.jurisdiction];
  if (!opSecret) throw new OnboardError(400, "JURISDICTION_NOT_SERVED", `this service has no ${req.jurisdiction} operator`);
  await crypto();
  const d = cfg.deployment;
  const admin = Keypair.fromSecret(cfg.adminSecret);
  const op = Keypair.fromSecret(opSecret);
  const adminChain = new Chain(d, keypairWallet(cfg.adminSecret), admin.publicKey());
  const opChain = new Chain(d, keypairWallet(opSecret), op.publicKey());
  const j = JURISDICTIONS[req.jurisdiction];
  const list = d.allowLists[j];
  if (!list) throw new OnboardError(500, "NO_ALLOW_LIST", `no allow-list for ${req.jurisdiction}`);

  // The account must exist and trust CLRUSD (the visitor signs that themselves).
  let balance: bigint;
  try {
    balance = BigInt(await adminChain.read<bigint>(d.token, "balance", { id: req.address }));
  } catch {
    throw new OnboardError(400, "NO_TRUSTLINE", "the account must exist and trust CLRUSD first (client.addTokenTrustline())");
  }

  const leaf = tierLeaf(req.idCommitment, j, 1);
  const leaves = await treeLeaves(adminChain, list);
  const listed = leaves.includes(leaf);
  const granted = balance > 0n;
  if (listed && granted) throw new OnboardError(409, "ALREADY_ONBOARDED", "this account already has test CLRUSD and this identity is already verified");
  if (granted) throw new OnboardError(409, "ALREADY_FUNDED", "onboarding is once per Stellar account");
  if (!listed && leaves.length >= 2 ** LEVELS.identity - cfg.reserve)
    throw new OnboardError(503, "ALLOW_LIST_FULL", `${req.jurisdiction} demo allow-list is full`);

  let kycTx: string | undefined;
  if (!listed) {
    kycTx = (await serial(op.publicKey(), () => retry(() => opChain.write(list, "insert_leaf", { leaf: BigInt(leaf) })))).hash;
  }
  const mintTx = (
    await serial(admin.publicKey(), () => retry(() => adminChain.write(d.token, "mint", { to: req.address, amount: usdToStroops(cfg.grantUsd) })))
  ).hash;
  return { jurisdiction: req.jurisdiction, tier: 1 as const, ...(kycTx ? { kycTx } : {}), mintTx, grantUsd: cfg.grantUsd };
}

/** Fixed-window per-key limiter (per process; good enough for a testnet faucet). */
export function rateLimiter(max: number, windowMs: number) {
  const hits = new Map<string, { n: number; t: number }>();
  return (key: string): boolean => {
    const now = Date.now();
    const h = hits.get(key);
    if (!h || now - h.t > windowMs) {
      hits.set(key, { n: 1, t: now });
      return true;
    }
    h.n++;
    return h.n <= max;
  };
}
