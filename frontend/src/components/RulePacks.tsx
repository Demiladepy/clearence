import { useState } from 'react'
import './RulePacks.css'
import { rulePacks } from '../data/content'

export default function RulePacks() {
  const [activeId, setActiveId] = useState(rulePacks[0].id)
  const pack = rulePacks.find((p) => p.id === activeId) ?? rulePacks[0]

  return (
    <section id="packs" className="container packs">
      <div className="packs-copy">
        <div className="eyebrow">Rule packs</div>
        <h2 className="h2">Change the rule. Every payment follows.</h2>
        <p className="packs-text">
          A rule pack holds your tier limits. Publish a new version and it
          applies at once.
        </p>
        <div className="packs-toggle">
          {rulePacks.map((p) => {
            const on = p.id === activeId
            return (
              <button
                key={p.id}
                type="button"
                className={`packs-btn${on ? ' packs-btn-on' : ''}`}
                aria-pressed={on}
                onClick={() => setActiveId(p.id)}
              >
                {p.label}
              </button>
            )
          })}
        </div>
      </div>

      <div className="packs-table mono">
        <div className="packs-head">
          <span>{pack.title}</span>
          <span className="packs-num">Per payment</span>
          <span className="packs-num">Daily</span>
        </div>
        {pack.tiers.map((t) => (
          <div key={t.name} className="packs-row">
            <span>{t.name}</span>
            <span className="packs-num">{t.perPayment}</span>
            <span className="packs-num packs-limit">{t.daily}</span>
          </div>
        ))}
        <div className="packs-note">{pack.note}</div>
      </div>
    </section>
  )
}
