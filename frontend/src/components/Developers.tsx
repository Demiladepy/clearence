import './Developers.css'

const code = `const clearance = await Clearance.connect({ network: "testnet", pool, wallet })
await clearance.send({ to, amountUsd: 15.625 })  // \u20A625,000: cleared
await clearance.send({ to, amountUsd: 17.5 })    // \u20A628,000: not sent, OVER_DAILY_BUDGET`

export default function Developers() {
  return (
    <section id="dev" className="dark">
      <div className="container dev">
        <div className="dev-copy">
          <div className="eyebrow">Developers</div>
          <h2 className="h2">Any licensed app, on Stellar.</h2>
          <p className="dev-text">
            Add compliant private payments in a few lines.
          </p>
          <a
            href="https://github.com/Demiladepy/clearence"
            className="dev-link"
            target="_blank"
            rel="noreferrer"
          >
            Read the docs
          </a>
        </div>

        <div className="dev-code">
          <div className="dev-code-label">SDK preview, API not final</div>
          <pre className="dev-pre"><code>{code}</code></pre>
        </div>
      </div>
    </section>
  )
}
