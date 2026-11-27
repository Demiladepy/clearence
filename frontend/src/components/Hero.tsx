import './Hero.css'
import {
  DAILY_LIMIT,
  METER_TICKS,
  PAYMENT_LARGE,
  PAYMENT_SMALL,
  formatNaira,
} from '../data/content'

const filled = Math.round((PAYMENT_SMALL / DAILY_LIMIT) * METER_TICKS)
const ticks = Array.from({ length: METER_TICKS }, (_, i) => i < filled)

export default function Hero() {
  return (
    <section id="top" className="container hero">
      <div className="hero-copy">
        <div className="eyebrow">Stellar Buildathon · Nigeria and Ghana 2026</div>
        <h1 className="hero-title">Private payments that follow the rules.</h1>
        <p className="hero-sub">
                   Add compliant private payments to your existing app on Stellar.
          Clearance proves each payment stayed within the law, without showing
          who paid whom or how much.
        </p>
        <p className="hero-demo mono">
          Send ₦{formatNaira(PAYMENT_SMALL)} privately. Try ₦
          {formatNaira(PAYMENT_LARGE)} more and it is not sent at the ₦
          {formatNaira(DAILY_LIMIT)} Tier 1 limit.
        </p>
        <div className="hero-actions">
          <a href="#try" className="btn btn-primary hero-cta">See it work</a>
          <a href="#dev" className="hero-link">Read the docs</a>
        </div>
        <div className="hero-trust">
                    Confidential, not anonymous: every payment goes through a licensed
          operator. Built on Stellar Private Payments by Nethermind. Runs on
          Stellar testnet.
        </div>
      </div>

      <div className="hero-art" aria-hidden="true">
        <div className="hero-record">
          <div className="hero-record-head">
            <span>Payment record</span>
            <span>Tier 1</span>
          </div>
          <div className="hero-record-rows mono">
            <div className="hero-row">
              <span>From</span>
              <span className="bar hero-bar" style={{ width: 110, animationDelay: '0.6s' }} />
            </div>
            <div className="hero-row">
              <span>To</span>
              <span className="bar hero-bar" style={{ width: 90, animationDelay: '0.75s' }} />
            </div>
            <div className="hero-row">
              <span>Amount</span>
              <span className="bar hero-bar" style={{ width: 70, animationDelay: '0.9s' }} />
            </div>
            <div className="hero-row">
              <span>Daily limit</span>
              <span className="hero-passed">Passed</span>
            </div>
          </div>
          <div>
            <span className="stamp stamp-cleared hero-stamp-cleared">CLEARED</span>
          </div>
        </div>

        <div className="hero-phone">
          <div className="hero-phone-top">
            <span className="hero-phone-brand">Clearance</span>
            <span className="hero-pill">Tier 1 · NGN</span>
          </div>
          <div className="hero-phone-label">Left today</div>
          <div className="hero-phone-amount mono">
            ₦{formatNaira(DAILY_LIMIT - PAYMENT_SMALL)}
          </div>
          <div className="hero-ticks">
            {ticks.map((on, i) => (
              <div
                key={i}
                className="hero-tick"
                style={{ background: on ? 'var(--ink)' : 'transparent' }}
              />
            ))}
          </div>
          <div className="hero-phone-foot mono">
            <span>Spent ₦{formatNaira(PAYMENT_SMALL)}</span>
            <span>of ₦{formatNaira(DAILY_LIMIT)}</span>
          </div>
          <div className="hero-phone-btn">Send privately</div>
        </div>

<span className="stamp stamp-held hero-stamp-held">NOT SENT</span>
      </div>
    </section>
  )
}