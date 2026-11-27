import { Link } from 'react-router-dom'
import './Hero.css'
import {
  DAILY_LIMIT,
  METER_TICKS,
  PAYMENT_SMALL,
  formatNaira,
} from '../data/content'

const filled = Math.round((PAYMENT_SMALL / DAILY_LIMIT) * METER_TICKS)
const ticks = Array.from({ length: METER_TICKS }, (_, i) => i < filled)

export default function Hero() {
  return (
    <section id="top" className="container hero">
      <div className="hero-copy">
        <div className="eyebrow">Stellar Buildathon 2026</div>
        <h1 className="hero-title">Private payments that follow the rules.</h1>
        <p className="hero-sub">
          Add compliant private payments to your app on Stellar. Every payment
          is proven to follow the rules, without showing who paid whom or how
          much.
        </p>
        <div className="hero-actions">
          <Link to="/app" className="btn btn-primary hero-cta">Try the demo</Link>
          <a href="#dev" className="hero-link">Read the docs</a>
        </div>
        <div className="hero-trust">
          Confidential, not anonymous. Built on Stellar Private Payments by
          Nethermind. Testnet only.
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
            <span className="hero-phone-brand">Marigold</span>
            <span className="hero-pill">Tier 1 &middot; NGN</span>
          </div>
          <div className="hero-phone-label">Left today</div>
          <div className="hero-phone-amount mono">
            &#8358;{formatNaira(DAILY_LIMIT - PAYMENT_SMALL)}
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
            <span>Spent &#8358;{formatNaira(PAYMENT_SMALL)}</span>
            <span>of &#8358;{formatNaira(DAILY_LIMIT)}</span>
          </div>
          <div className="hero-phone-btn">Send privately</div>
        </div>

        <span className="stamp stamp-held hero-stamp-held">NOT SENT</span>
      </div>
    </section>
  )
}
