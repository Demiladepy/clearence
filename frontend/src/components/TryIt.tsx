import { useState } from 'react'
import './TryIt.css'
import {
  DAILY_LIMIT,
  METER_TICKS,
  PAYMENT_LARGE,
  PAYMENT_SMALL,
  formatNaira,
} from '../data/content'
import { sendPayment } from '../services/clearance'

type Status = 'idle' | 'cleared' | 'held'

export default function TryIt() {
  const [spent, setSpent] = useState(0)
  const [status, setStatus] = useState<Status>('idle')

  const filled = Math.round((spent / DAILY_LIMIT) * METER_TICKS)
  const ticks = Array.from({ length: METER_TICKS }, (_, i) => i < filled)

  function pay(amount: number) {
    const result = sendPayment(spent, amount)
    setSpent(result.spent)
    setStatus(result.status)
  }

  function reset() {
    setSpent(0)
    setStatus('idle')
  }

  return (
    <section id="try" className="dark">
      <div className="container try">
        <div className="try-copy">
          <div className="eyebrow">§ 03 · Try it</div>
          <h2 className="h2">
            Ada has ₦{formatNaira(DAILY_LIMIT)} a day. Send two payments.
          </h2>
          <div className="try-buttons">
            <button type="button" className="try-btn try-btn-solid" onClick={() => pay(PAYMENT_SMALL)}>
              Send ₦{formatNaira(PAYMENT_SMALL)}
            </button>
            <button type="button" className="try-btn try-btn-outline" onClick={() => pay(PAYMENT_LARGE)}>
              Send ₦{formatNaira(PAYMENT_LARGE)}
            </button>
            <button type="button" className="try-reset" onClick={reset}>
              Reset
            </button>
          </div>
        </div>

        <div className="try-card">
          <div className="try-label">Private spending left today</div>
          <div className="try-amount mono">₦{formatNaira(DAILY_LIMIT - spent)}</div>

          <div className="try-ticks" role="img" aria-label={`Spent ${formatNaira(spent)} of ${formatNaira(DAILY_LIMIT)}`}>
            {ticks.map((on, i) => (
              <div
                key={i}
                className="try-tick"
                style={{ background: on ? 'var(--ink)' : 'transparent' }}
              />
            ))}
          </div>

          <div className="try-foot mono">
            <span>Spent ₦{formatNaira(spent)}</span>
            <span>Limit ₦{formatNaira(DAILY_LIMIT)}</span>
          </div>

          <div className="try-status" aria-live="polite">
            {status === 'idle' && (
              <div className="try-note try-note-idle">No payments yet. Try one.</div>
            )}
            {status === 'cleared' && (
              <div className="try-result" key={`c-${spent}`}>
                <span className="stamp stamp-cleared try-stamp">CLEARED</span>
                <span className="try-note">Within your Tier 1 limit.</span>
              </div>
            )}
            {status === 'held' && (
              <div className="try-result" key={`h-${spent}`}>
<span className="stamp stamp-held try-stamp">NOT SENT</span>
                <span className="try-note">
                  Nothing left your wallet. This would take you over ₦
                  {formatNaira(DAILY_LIMIT)} today.
                </span>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}