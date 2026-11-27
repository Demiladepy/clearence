import './Problem.css'
import { publicRows } from '../data/content'

export default function Problem() {
  return (
    <section className="band">
      <div className="container problem">
        <div className="problem-head">
          <div className="eyebrow">The problem</div>
          <h2 className="h2">
            Public blockchains show everything. Privacy tools hide too much.
          </h2>
        </div>

        <div className="problem-panels">
          <div className="problem-panel problem-public">
            <div className="problem-label">Any public chain &middot; sample data</div>
            {publicRows.map((r, i) => (
              <div key={i} className="problem-row mono">
                <span>{r.from} &rarr; {r.to}</span>
                <span className="problem-amount">{r.amount}</span>
              </div>
            ))}
            <p className="problem-caption">
              Competitors can read your suppliers, payroll and cash flow.
            </p>
          </div>

          <div className="problem-panel problem-private">
            <div className="problem-label">With Clearance &middot; same payments</div>
            {publicRows.map((_, i) => (
              <div key={i} className="problem-row problem-row-private">
                <span className="bar problem-bar" />
                <span className="problem-valid mono">Valid</span>
              </div>
            ))}
            <p className="problem-caption">
              Each payment has a valid proof. Nothing else is visible.
            </p>
          </div>
        </div>
      </div>
    </section>
  )
}
