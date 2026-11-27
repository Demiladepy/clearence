// All numbers and sample data for the landing page live here.
// Tier limits follow the Nigeria rule pack, shown at a fixed demo rate of
// 1,600 NGN per USD (not a live price). They are illustrative until confirmed
// against regulator sources. Version 2 is an example, not yet published.

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
// Tier 1: ₦30,000 per payment, ₦50,000 a day.
// Her first payment clears. Her second is under the per-payment limit,
// but ₦25,000 + ₦28,000 = ₦53,000 is over the daily limit, so it is not sent.
// Neither amount sits exactly on a limit, so rounding cannot flip the result.
export const DAILY_LIMIT = 50000
export const PER_PAYMENT_LIMIT = 30000
export const METER_TICKS = 25
export const PAYMENT_SMALL = 25000 // Ada's first payment
export const PAYMENT_LARGE = 28000 // Ada's second payment
export const DEMO_RATE_NOTE = 'Shown at a fixed demo rate of ₦1,600 per US dollar.'

export const rulePacks: RulePack[] = [
  {
    id: 'V1',
    label: 'Version 1',
    title: 'Nigeria rule pack v1',
    note: 'Illustrative limits. Tier 2 and 3 figures are being confirmed. ' + DEMO_RATE_NOTE,
    tiers: [
      { name: 'Tier 1', perPayment: '₦30,000', daily: '₦50,000' },
      { name: 'Tier 2', perPayment: '—', daily: '₦200,000' },
      { name: 'Tier 3', perPayment: '—', daily: '₦5,000,000' },
    ],
  },
  {
    id: 'V2',
    label: 'Version 2',
    title: 'Nigeria rule pack v2',
    note: 'Example update: the operator tightens the Tier 1 per-payment limit from ₦30,000 to ₦20,000. The same payment is judged by the new rules.',
    tiers: [
      { name: 'Tier 1', perPayment: '₦20,000', daily: '₦50,000' },
      { name: 'Tier 2', perPayment: '—', daily: '₦200,000' },
      { name: 'Tier 3', perPayment: '—', daily: '₦5,000,000' },
    ],
  },
]

// Sample data for the "problem" section. Not real transactions.
export const publicRows: PublicRow[] = [
  { from: 'GA7K…3F2Q', to: 'GD2M…91CE', amount: '₦20,000' },
  { from: 'GB5T…K8LP', to: 'GA7K…3F2Q', amount: '₦1,450,000' },
  { from: 'GC9R…2WQA', to: 'GD2M…91CE', amount: '₦310,000' },
  { from: 'GA7K…3F2Q', to: 'GE4H…7ZNB', amount: '₦85,500' },
]

export function formatNaira(n: number): string {
  return n.toLocaleString('en-US')
}