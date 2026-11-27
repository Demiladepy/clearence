import './HowItWorks.css'

const steps = [
  {
    n: '01',
    title: 'Your provider verifies you',
    body: 'After an identity check, you get a private credential for your tier.',
  },
  {
    n: '02',
    title: 'You pay privately',
    body: 'A proof checks your limit without revealing your name or the amount.',
  },
  {
    n: '03',
    title: 'Only the operator can open it',
    body: 'Every payment carries a sealed record. Everyone else just sees a valid payment.',
  },
]

export default function HowItWorks() {
  return (
    <section id="how" className="container how">
      <div className="how-head">
        <div className="eyebrow">How it works</div>
        <h2 className="h2">Regulators already wrote the rules. We enforce them.</h2>
      </div>

      <div className="how-steps">
        {steps.map((s) => (
          <div key={s.n} className="how-step">
            <div className="how-num mono">{s.n}</div>
            <div className="how-title">{s.title}</div>
            <div className="how-body">{s.body}</div>
          </div>
        ))}
      </div>
    </section>
  )
}
