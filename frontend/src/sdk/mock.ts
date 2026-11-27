// Mock of the Clearance SDK, built on Demilade's types.
// Same shapes as the real SDK, so screens written against this do not change
// when the real functions go live. Swap one function at a time.
// Nothing here is real: every transaction hash is made up.

import type {
  Address,
  Balance,
  Budget,
  ConnectOptions,
  ListRecordsParams,
  OpenedRecord,
  PackId,
  ProofStep,
  Receipt,
  RulePack,
  SealedRecordSummary,
  SendParams,
  Tier,
  TierUpgradeRequest,
  WalletLike,
} from './types'
import { ClearanceError } from './errors'

export const IS_MOCK = true

// Display only. A fixed demo rate, never a live price.
export const DEMO_RATE_NGN_PER_USD = 1600
export const nairaToUsd = (n: number) => n / DEMO_RATE_NGN_PER_USD
export const usdToNaira = (u: number) => Math.round(u * DEMO_RATE_NGN_PER_USD)
export const formatNairaFromUsd = (u: number) =>
  '₦' + usdToNaira(u).toLocaleString('en-US')

export const DEMO_ADA = 'GA7K3F2Q-ADA'
export const DEMO_CHIDI = 'GB5TK8LP-CHIDI'

const EPS = 1e-9
let stepMs = 800
let upgradeMs = 3000

export function setMockSpeed(opts: { stepMs?: number; upgradeMs?: number }) {
  if (opts.stepMs !== undefined) stepMs = opts.stepMs
  if (opts.upgradeMs !== undefined) upgradeMs = opts.upgradeMs
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function fakeHash(): string {
  let s = ''
  for (let i = 0; i < 64; i++) s += Math.floor(Math.random() * 16).toString(16)
  return s
}

const today = () => Math.floor(Date.now() / 86_400_000)

// ---------- rule packs ----------
// Tier 1: ₦30,000 per payment, ₦50,000 a day (matches testnet pack v1).
// Tier 2 and 3: daily figures follow the CBN circular we quote and are being
// confirmed. Per-payment for tiers 2 and 3 is set equal to daily until the
// real figures are published.
// v2 example: operator tightens Tier 1 per-payment from ₦30,000 to ₦20,000.
function makePack(version: number): RulePack {
  const tier1PerPayment = version >= 2 ? nairaToUsd(20000) : nairaToUsd(30000)
  return {
    jurisdiction: 'NG',
    version,
    id: `NG-v${version}` as PackId,
    utcOffsetSecs: 3600,
    travelRuleThresholdUsd: 1000,
    tiers: {
      1: { perPaymentLimitUsd: tier1PerPayment, dailyLimitUsd: nairaToUsd(50000) },
      2: { perPaymentLimitUsd: nairaToUsd(200000), dailyLimitUsd: nairaToUsd(200000) },
      3: { perPaymentLimitUsd: nairaToUsd(5000000), dailyLimitUsd: nairaToUsd(5000000) },
    },
    operatorKey: { x: 'mock', y: 'mock' },
    packHash: 'mock',
    publishedAt: new Date().toISOString(),
  }
}

// ---------- in-memory state ----------
type Customer = { tier: Tier; spentUsd: number; balanceUsd: number }
type StoredRecord = { summary: SealedRecordSummary; opened: OpenedRecord }

const state = {
  activeVersion: 1,
  customers: new Map<Address, Customer>(),
  records: [] as StoredRecord[],
  nextRecord: 415,
  approvals: new Map<Address, () => void>(),
}

function getCustomer(address: Address): Customer {
  let c = state.customers.get(address)
  if (!c) {
    c = { tier: 1, spentUsd: 0, balanceUsd: 500 }
    state.customers.set(address, c)
  }
  return c
}

function budgetFor(address: Address): Budget {
  const c = getCustomer(address)
  const limits = makePack(state.activeVersion).tiers[c.tier]
  const next = new Date()
  next.setUTCHours(24, 0, 0, 0)
  return {
    tier: c.tier,
    spentTodayUsd: c.spentUsd,
    dailyLimitUsd: limits.dailyLimitUsd,
    perPaymentLimitUsd: limits.perPaymentLimitUsd,
    resetsAt: next.toISOString(),
  }
}

function addRecord(
  recordId: string,
  sender: string,
  receiver: string,
  amountUsd: number,
  flag: boolean,
  version: number,
) {
  const packId = `NG-v${version}` as PackId
  state.records.push({
    summary: {
      recordId,
      txHash: fakeHash(),
      timestamp: new Date().toISOString(),
      epoch: today(),
      packId,
      sealedRecordHex: fakeHash() + fakeHash(),
    },
    opened: {
      recordId,
      sender,
      receiver,
      amountUsd,
      epoch: today(),
      travelRuleFlag: flag,
      senderJurisdiction: 'NG',
      receiverJurisdiction: 'NG',
      packVersion: packId,
    },
  })
}

function seed() {
  state.records = []
  addRecord('#0412', 'GA7K…3F2Q', 'GD2M…91CE', nairaToUsd(20000), false, 1)
  // Tier 3 sample over $1,000 for the day, so the Travel Rule flag is on.
  addRecord('#0413', 'GB5T…K8LP', 'GA7K…3F2Q', nairaToUsd(1750000), true, 1)
  addRecord('#0414', 'GC9R…2WQA', 'GE4H…7ZNB', nairaToUsd(85500), false, 1)
}
seed()

export function resetMockDemo() {
  state.activeVersion = 1
  state.customers.clear()
  state.nextRecord = 415
  state.approvals.clear()
  seed()
}

export function createDemoWallet(address: Address): WalletLike {
  return {
    getAddress: async () => ({ address }),
    signTransaction: async (xdr) => ({ signedTxXdr: xdr }),
  }
}

// ---------- the client (what the wallet screens call) ----------
export async function connectMock(opts: ConnectOptions) {
  const { address } = await opts.wallet.getAddress()

  return {
    address,
    isMock: true as const,

    async getTier(): Promise<{ tier: Tier; revoked: boolean }> {
      return { tier: getCustomer(address).tier, revoked: false }
    },

    async getBudget(): Promise<Budget> {
      return budgetFor(address)
    },

    async getBalance(): Promise<Balance> {
      return { shieldedUsd: getCustomer(address).balanceUsd }
    },

    // The UI calls this "Fund private balance".
    async deposit(amountUsd: number): Promise<{ txHash: string }> {
      await sleep(stepMs)
      getCustomer(address).balanceUsd += amountUsd
      return { txHash: fakeHash() }
    },

    async send(p: SendParams): Promise<Receipt> {
      const started = Date.now()
      const emit = (step: ProofStep) =>
        p.onProgress?.({ step, elapsedMs: Date.now() - started })
      const c = getCustomer(address)
      const pack = makePack(state.activeVersion)
      const limits = pack.tiers[c.tier]

      if (p.amountUsd > c.balanceUsd + EPS) {
        throw new ClearanceError('INSUFFICIENT_BALANCE')
      }

      emit('identity')
      await sleep(stepMs)

      emit('perPayment')
      await sleep(stepMs)
      if (p.amountUsd > limits.perPaymentLimitUsd + EPS) {
        throw new ClearanceError('OVER_PER_PAYMENT_LIMIT', {
          limitLocal: formatNairaFromUsd(limits.perPaymentLimitUsd),
          limitUsd: limits.perPaymentLimitUsd,
          step: 'perPayment',
        })
      }

      emit('dailyBudget')
      await sleep(stepMs)
      if (c.spentUsd + p.amountUsd > limits.dailyLimitUsd + EPS) {
        throw new ClearanceError('OVER_DAILY_BUDGET', {
          limitLocal: formatNairaFromUsd(limits.dailyLimitUsd),
          limitUsd: limits.dailyLimitUsd,
          remainingUsd: limits.dailyLimitUsd - c.spentUsd,
          step: 'dailyBudget',
        })
      }

      emit('sealed')
      await sleep(stepMs)
      emit('submitting')
      await sleep(stepMs)

      c.spentUsd += p.amountUsd
      c.balanceUsd -= p.amountUsd
      const flag = c.spentUsd >= pack.travelRuleThresholdUsd
      const recordId = '#0' + state.nextRecord++
      addRecord(recordId, address, p.to, p.amountUsd, flag, state.activeVersion)

      emit('verified')
      const txHash = fakeHash()
      return {
        proved: { tier: true, perPayment: true, dailyBudget: true, sealed: true },
        txHash,
        provingMs: Date.now() - started,
        explorerUrl: `https://stellar.expert/explorer/testnet/tx/${txHash}`,
        packId: pack.id,
        receiverPackId: pack.id,
        budget: budgetFor(address),
      }
    },

    // KYC only. Resolves on its own after a few seconds, or at once when
    // demoApproveUpgrade(address) is called ("Demo mode: approve now").
    async requestTierUpgrade(): Promise<TierUpgradeRequest> {
      const done = new Promise<{ tier: Tier }>((resolve) => {
        const finish = () => {
          getCustomer(address).tier = 2
          state.approvals.delete(address)
          resolve({ tier: 2 })
        }
        const t = setTimeout(finish, upgradeMs)
        state.approvals.set(address, () => {
          clearTimeout(t)
          finish()
        })
      })
      return { interactiveUrl: 'about:blank', done }
    },
  }
}

export type MockClearance = Awaited<ReturnType<typeof connectMock>>

export function demoApproveUpgrade(address: Address) {
  state.approvals.get(address)?.()
}

// ---------- the operator side ----------
export const mockOperator = {
  async getActivePack(): Promise<RulePack> {
    return makePack(state.activeVersion)
  },

  // Publishes and activates a version, e.g. "NG-v2".
  async setPack(id: PackId): Promise<{ packVersion: PackId; txHash: string }> {
    const m = /^NG-v(\d+)$/.exec(id)
    if (!m) throw new Error(`Unknown pack ${id}`)
    await sleep(600)
    state.activeVersion = Number(m[1])
    return { packVersion: id, txHash: fakeHash() }
  },

  async listRecords(_params?: ListRecordsParams): Promise<SealedRecordSummary[]> {
    return state.records.map((r) => r.summary)
  },

  async openRecord(recordId: string): Promise<OpenedRecord> {
    const found = state.records.find((r) => r.summary.recordId === recordId)
    if (!found) throw new ClearanceError('RECORD_KEY_INVALID')
    await sleep(400)
    return found.opened
  },
}