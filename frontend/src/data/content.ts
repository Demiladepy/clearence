// All numbers and sample data for the landing page live here.
// Tier limits are the Nigeria rule pack (v1) published on Stellar testnet,
// shown at a fixed demo rate of 1,600 NGN per USD (not a live price). They are
// illustrative. The app itself reads the live limits from the chain.
// The second rule pack is an example, not a published version.

export type Tier = {
  name: string
  perPayment: string
  daily: string
}

export type RulePack = {
  id: 'V1' | 'V2'
  label: string
  title: string
  note: string
  tiers: Tier[]
}

export type PublicRow = {
  from: string
  to: string
  amount: string
}

// Demo rules: Ada is Tier 1 under rule pack v1.
// Tier 1: 30,000 NGN per payment, 50,000 NGN a day.
// Her first payment clears. Her second is under the per-payment limit,
// but 25,000 + 28,000 = 53,000 NGN is over the daily limit, so it is not sent.
// Neither amount sits exactly on a limit, so rounding cannot flip the result.
export const DAILY_LIMIT = 50000
export const PER_PAYMENT_LIMIT = 30000
export const METER_TICKS = 25
export const PAYMENT_SMALL = 25000 // Ada's first payment
export const PAYMENT_LARGE = 28000 // Ada's second payment
export const DEMO_RATE_NOTE = 'Shown at a fixed demo rate of \u20A61,600 per US dollar.'

export const rulePacks: RulePack[] = [
  {
    id: 'V1',
    label: 'Live pack',
    title: 'Nigeria rule pack v1',
    note: 'Illustrative limits, published on Stellar testnet. ' + DEMO_RATE_NOTE,
    tiers: [
      { name: 'Tier 1', perPayment: '\u20A630,000', daily: '\u20A650,000' },
      { name: 'Tier 2', perPayment: '\u20A61,000,000', daily: '\u20A62,000,000' },
      { name: 'Tier 3', perPayment: '\u20A65,000,000', daily: '\u20A610,000,000' },
    ],
  },
  {
    id: 'V2',
    label: 'Example update',
    title: 'Example: a new version',
    note: 'Example only. The operator tightens the Tier 1 per-payment limit from \u20A630,000 to \u20A620,000, and the same payment is judged by the new rules.',
    tiers: [
      { name: 'Tier 1', perPayment: '\u20A620,000', daily: '\u20A650,000' },
      { name: 'Tier 2', perPayment: '\u20A61,000,000', daily: '\u20A62,000,000' },
      { name: 'Tier 3', perPayment: '\u20A65,000,000', daily: '\u20A610,000,000' },
    ],
  },
]

// Sample data for the "problem" section. Not real transactions.
export const publicRows: PublicRow[] = [
  { from: 'GA7K\u20263F2Q', to: 'GD2M\u202691CE', amount: '\u20A620,000' },
  { from: 'GB5T\u2026K8LP', to: 'GA7K\u20263F2Q', amount: '\u20A61,450,000' },
  { from: 'GC9R\u20262WQA', to: 'GD2M\u202691CE', amount: '\u20A6310,000' },
  { from: 'GA7K\u20263F2Q', to: 'GE4H\u20267ZNB', amount: '\u20A685,500' },
]

export function formatNaira(n: number): string {
  return n.toLocaleString('en-US')
}