import { DAILY_LIMIT } from '../data/content'

export type PaymentStatus = 'cleared' | 'held'

export type PaymentResult = {
  status: PaymentStatus
  spent: number
}

// Mock. Replace the body with the real SDK call when it is ready.
// The component only depends on this function's shape.
export function sendPayment(spent: number, amount: number): PaymentResult {
  if (spent + amount > DAILY_LIMIT) {
    return { status: 'held', spent }
  }
  return { status: 'cleared', spent: spent + amount }
}