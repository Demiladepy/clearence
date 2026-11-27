import './HowItWorks.css'

const steps = [
  {
    n: '01',
    title: 'Your provider verifies you',
    body: 'After identity checks, your app gives you a private credential that says your tier.',
  },
  {
    n: '02',
    title: 'You pay privately',
    body: 'A proof checks your limit without revealing your name or the amount.',
  },
  {
    n: '03',
    title: 'The regulator sees the proof',
    body: 'Every payment carries a sealed record that only your licensed operator can open. Everyone else sees that a valid payment happened.',
},
]

export default function HowItWorks() {
  return (
    <section id="how" className="container how">
      <div className="how-head">
        <div className="eyebrow">§ 02 · How it works</div>
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