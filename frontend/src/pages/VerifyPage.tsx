import { useEffect, useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { useApp } from '../app/AppContext'
import { DEMO_ADA, IS_MOCK, demoApproveUpgrade, usdToNaira } from '../sdk/mock'
import type { Budget } from '../sdk/types'
import { formatNaira, rulePacks } from '../data/content'
import '../app/app.css'

type Stage = 'intro' | 'waiting' | 'done'

const naira = (n: number) => '\u20A6' + formatNaira(n)
const toNgn = (usd: number) => Math.round(usdToNaira(usd))

export default function VerifyPage() {
  const { session, client, history } = useApp()
  const navigate = useNavigate()
  const [stage, setStage] = useState<Stage>('intro')
  const [budget, setBudget] = useState<Budget | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!client) return
    let live = true
    void client.getBudget().then((b) => {
      if (live) setBudget(b)
    })
    return () => {
      live = false
    }
  }, [client])

  if (!session) return <Navigate to="/app" replace />

  const last = history[0]
  const retryAmount = last && last.kind === 'not_sent' ? last.amountNgn : 28000
  const tierLabel = 'Tier ' + (budget ? budget.tier : 1) + ' \u00B7 NGN'
  const pack = rulePacks[0]
  const tier2 = pack.tiers[1]

  async function start() {
    if (!client) return
    setError('')
    setStage('waiting')
    try {
      const req = await client.requestTierUpgrade()
      if (!IS_MOCK) {
        window.open(req.interactiveUrl, '_blank', 'width=480,height=720')
      }
      await req.done
      setBudget(await client.getBudget())
      setStage('done')
    } catch {
      setError('Verification did not finish. Nothing changed. Try again.')
      setStage('intro')
    }
  }

  return (
    <div className="app-shell">
      <main className="app-screen">
        <div className="app-top">
          <button
            type="button"
            className="app-back"
            onClick={() => navigate(-1)}
          >
            &larr; Back
          </button>
          <div className="app-pill mono">{tierLabel}</div>
        </div>

        {stage === 'intro' && (
          <>
            <div>
              <div className="app-label">Verify identity</div>
              <h1 className="app-h1">Verify your identity for a higher limit.</h1>
              <p className="app-sub">
                Your provider checks your ID once. Then your limit goes up.
              </p>
            </div>

            <div className="app-panel app-rows mono">
              <div className="app-row">
                <span>Now</span>
                <span>
                  Tier {budget ? budget.tier : 1} &middot;{' '}
                  {budget ? naira(toNgn(budget.dailyLimitUsd)) : '\u2014'} a day
                </span>
              </div>
              <div className="app-row app-row-top app-good">
                <span>After</span>
                <span>Tier 2 &middot; {tier2.daily} a day</span>
              </div>
            </div>

            {error && <div className="app-error" role="alert">{error}</div>}

            <div className="app-foot">
              <button type="button" className="app-btn" onClick={() => void start()}>
                Verify identity
              </button>
              <span className="app-center-text">
                Takes a few minutes. In this demo, about 3 seconds.
              </span>
            </div>
          </>
        )}

        {stage === 'waiting' && (
          <>
            <div>
              <div className="app-label">Verify identity</div>
              <h1 className="app-h1">Waiting for your provider.</h1>
              <p className="app-sub">
                Your provider is checking your ID. You can leave this screen
                open.
              </p>
            </div>

            <div className="app-panel app-steps">
              <div className="app-step">
                <div className="app-mark app-mark-done mono">{'\u2713'}</div>
                <div className="app-step-label">Request sent</div>
                <div className="app-step-status mono app-good">Done</div>
              </div>
              <div className="app-step">
                <div className="app-mark app-mark-active mono">{'\u2026'}</div>
                <div className="app-step-label">ID check</div>
                <div className="app-step-status mono">Checking</div>
              </div>
              <div className="app-step">
                <div className="app-mark mono" />
                <div className="app-step-label app-dim">New credential issued</div>
                <div className="app-step-status mono">Waiting</div>
              </div>
            </div>

            {IS_MOCK && (
              <div className="app-foot">
                <button
                  type="button"
                  className="app-link app-center"
                  onClick={() => demoApproveUpgrade(DEMO_ADA)}
                >
                  Demo mode: approve now
                </button>
              </div>
            )}
          </>
        )}

        {stage === 'done' && (
          <>
            <div className="app-result-head">
              <span className="stamp stamp-cleared">VERIFIED</span>
              <h1 className="app-h1">You are now Tier {budget ? budget.tier : 2}.</h1>
            </div>

            <div className="app-panel app-rows mono">
              <div className="app-row">
                <span>Daily limit</span>
                <span>{budget ? naira(toNgn(budget.dailyLimitUsd)) : '\u2014'}</span>
              </div>
              <div className="app-row">
                <span>Per payment</span>
                <span>{budget ? naira(toNgn(budget.perPaymentLimitUsd)) : '\u2014'}</span>
              </div>
            </div>

            <div className="app-foot">
              <button
                type="button"
                className="app-btn"
                onClick={() => navigate('/app/send', { state: { amount: retryAmount } })}
              >
                Send {naira(retryAmount)} now
              </button>
              <button
                type="button"
                className="app-link app-center"
                onClick={() => navigate('/app/home')}
              >
                Back to wallet
              </button>
            </div>
          </>
        )}
      </main>
    </div>
  )
}
