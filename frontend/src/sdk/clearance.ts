// Live Clearance SDK glue (Stellar testnet). Replaces the old mock.
// Nothing here is simulated: proofs run in the browser, payments are Soroban
// transactions, and balances, budgets and records are read back from the chain.

import {
  ClearanceClient,
  ClearanceOperator,
  fetchArtifacts,
  initCrypto,
  keypairWallet,
  newIdentitySecret,
  stroopsToUsd,
} from '@clearance/sdk'
import type { CircuitArtifacts, PackId, Tier, TierLimits, WalletLike } from '@clearance/sdk'

export type Client = ClearanceClient
export type Operator = ClearanceOperator

// ---------- display currency (never on-chain, always labelled) ----------
export const DEMO_RATE_NGN_PER_USD = 1600
export const nairaToUsd = (n: number) => n / DEMO_RATE_NGN_PER_USD
export const usdToNaira = (u: number) => Math.round(u * DEMO_RATE_NGN_PER_USD)

// Demo recipient: a real Clearance address (public). Replace with an NG
// recipient address from Demilade when he sends one.
export const RECIPIENT = {
  label: 'Demo recipient',
  address:
    'clr:7600875842942481122511770653523116744408533769051511824914663485847463305137:71e76be3cf81c4fb004a398ce4e5549968e033013f1d11b6b15a13d5561fae0c',
}

// ---------- circuit assets (served from /clearance) ----------
let artifactsPromise: Promise<CircuitArtifacts> | null = null

export function loadArtifacts(): Promise<CircuitArtifacts> {
  if (!artifactsPromise) {
    artifactsPromise = (async () => {
      await initCrypto('/clearance/clearance_wasm_bg.wasm')
      return fetchArtifacts('/clearance')
    })()
    artifactsPromise.catch(() => {
      artifactsPromise = null
    })
  }
  return artifactsPromise
}

// ---------- demo account credentials ----------
// Never committed. Either saved once in this browser, or (optional) baked into
// the build with VITE_DEMO_STELLAR_SECRET / VITE_DEMO_IDENTITY_SECRET.
const K_STELLAR = 'clr-demo-secret'
const K_ID = 'clr-id'

const read = (k: string): string | null => {
  try {
    return localStorage.getItem(k)
  } catch {
    return null
  }
}

export function demoCreds(): { stellar: string; identity: string } | null {
  const stellar = (import.meta.env.VITE_DEMO_STELLAR_SECRET as string | undefined) || read(K_STELLAR)
  const identity = (import.meta.env.VITE_DEMO_IDENTITY_SECRET as string | undefined) || read(K_ID)
  return stellar && identity ? { stellar, identity } : null
}

export function saveDemoCreds(stellar: string, identity: string) {
  localStorage.setItem(K_STELLAR, stellar.trim())
  localStorage.setItem(K_ID, identity.trim())
}

export function clearDemoCreds() {
  try {
    localStorage.removeItem(K_STELLAR)
    localStorage.removeItem(K_ID)
  } catch {
    /* ignore */
  }
}

/** Identity secret for a person who connects their own wallet: same on every visit. */
export function identityForWallet(): string {
  const existing = read(K_ID)
  if (existing) return existing
  const fresh = newIdentitySecret()
  try {
    localStorage.setItem(K_ID, fresh)
  } catch {
    /* ignore */
  }
  return fresh
}

export async function connectLive(wallet: WalletLike, identitySecret: string): Promise<Client> {
  const artifacts = await loadArtifacts()
  return ClearanceClient.connect({ wallet, identitySecret, jurisdiction: 'NG', artifacts })
}

export async function connectDemoAccount(): Promise<Client> {
  const creds = demoCreds()
  if (!creds) throw new Error('NO_DEMO_CREDS')
  return connectLive(keypairWallet(creds.stellar), creds.identity)
}

// ---------- verification requests (user -> operator console) ----------
const K_REQ = 'clr-kyc-requests'

export interface KycRequest {
  idCommitment: string
  name: string
  tier: Tier
  at: string
}

export function kycRequests(): KycRequest[] {
  try {
    return JSON.parse(localStorage.getItem(K_REQ) ?? '[]') as KycRequest[]
  } catch {
    return []
  }
}

export function addKycRequest(r: KycRequest) {
  const rest = kycRequests().filter((x) => x.idCommitment !== r.idCommitment)
  try {
    localStorage.setItem(K_REQ, JSON.stringify([r, ...rest]))
  } catch {
    /* ignore */
  }
}

export function removeKycRequest(idCommitment: string) {
  try {
    localStorage.setItem(K_REQ, JSON.stringify(kycRequests().filter((x) => x.idCommitment !== idCommitment)))
  } catch {
    /* ignore */
  }
}

// ---------- operator ----------
const K_OP_SECRET = 'clr-op-secret'
const K_OP_KEY = 'clr-op-key'

let operator: Operator | null = null

export async function connectOperator(stellarSecret: string, recordKey: string): Promise<Operator> {
  await initCrypto('/clearance/clearance_wasm_bg.wasm')
  const op = await ClearanceOperator.connect({
    wallet: keypairWallet(stellarSecret.trim()),
    jurisdiction: 'NG',
    recordKey: recordKey.trim(),
  })
  operator = op
  try {
    localStorage.setItem(K_OP_SECRET, stellarSecret.trim())
    localStorage.setItem(K_OP_KEY, recordKey.trim())
  } catch {
    /* ignore */
  }
  return op
}

export async function restoreOperator(): Promise<Operator | null> {
  if (operator) return operator
  try {
    const s = localStorage.getItem(K_OP_SECRET)
    const k = localStorage.getItem(K_OP_KEY)
    if (s && k) return await connectOperator(s, k)
  } catch {
    /* fall through */
  }
  return null
}

export function disconnectOperator() {
  operator = null
  try {
    localStorage.removeItem(K_OP_SECRET)
    localStorage.removeItem(K_OP_KEY)
  } catch {
    /* ignore */
  }
}

// ---------- active rule pack, in the shape the console shows ----------
export interface PackView {
  id: PackId
  version: number
  utcOffsetSecs: number
  travelRuleThresholdUsd: number
  tiers: Record<Tier, TierLimits>
}

export async function readPack(op: Operator): Promise<PackView> {
  const p = await op.getActivePack()
  const tier = (i: number): TierLimits => ({
    perPaymentLimitUsd: stroopsToUsd(p.tiers[i]![0]),
    dailyLimitUsd: stroopsToUsd(p.tiers[i]![1]),
  })
  return {
    id: p.id,
    version: p.version,
    utcOffsetSecs: p.utcOffsetSecs,
    travelRuleThresholdUsd: stroopsToUsd(p.travelRuleThreshold),
    tiers: { 1: tier(0), 2: tier(1), 3: tier(2) },
  }
}

export const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))