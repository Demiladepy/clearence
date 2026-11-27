import { useEffect, useState } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import { useApp } from '../app/AppContext'
import { ClearanceError } from '../sdk/errors'
import { DEMO_CHIDI, IS_MOCK, nairaToUsd, usdToNaira } from '../sdk/mock'
import type { Budget, ProofStep, Receipt } from '../sdk/types'
import { formatNaira, METER_TICKS } from '../data/content'
import '../app/app.css'

type Stage = 'amount' | 'review' | 'proving' | 'cleared' | 'blocked'

interface Failure {
  code: string
  message: string
}

const STEPS: { key: ProofStep; label: string }[] = [
  { key: 'identity', label: 'Identity is in the allow-list' },
  { key: 'perPayment', label: 'Within per-payment limit' },
  { key: 'dailyBudget', label: 'Within today\u2019s budget' },
  { key: 'sealed', label: 'Record sealed' },
  { key: 'submitting', label: 'Submitting to Stellar' },
  { key: 'verified', label: 'Verified on Stellar' },
]

const CHIPS = [20000, 25000, 28000]

const naira = (n: number) => '\u20A6' + formatNaira(n)
const short = (a: string) =>
  a.length > 10 ? a.slice(0, 4) + '\u2026' + a.slice(-4) : a
const toNgn = (usd: number) => Math.round(usdToNaira(usd))

export default function SendPage() {
  const { session, client, addEntry } = useApp()
  const navigate = useNavigate()
  const [stage, setStage] = useState<Stage>('amount')
  const [amount, setAmount] = useState(25000)
  const [custom, setCustom] = useState('')
  const [budget, setBudget] = useState<Budget | null>(null)
  const [done, setDone] = useState(0)
  const [failedStep, setFailedStep] = useState<ProofStep | null>(null)
  const [receipt, setReceipt] = useState<Receipt | null>(null)
  const [failure, setFailure] = useState<Failure | null>(null)

  useEffect(() => {
    if (!client || stage !== 'amount') return
    let live = true
    void client.getBudget().then((b) => {
      if (live) setBudget(b)
    })
    return () => {
      live = false
    }
  }, [client, stage])

  if (!session) return <Navigate to="/app" replace />

  const spentNgn = budget ? toNgn(budget.spentTodayUsd) : 0
  const dailyNgn = budget ? toNgn(budget.dailyLimitUsd) : 0
  const perNgn = budget ? toNgn(budget.perPaymentLimitUsd) : 0
  const leftNgn = Math.max(dailyNgn - spentNgn, 0)
  const overPer = budget !== null && amount > perNgn
  const overDaily = budget !== null && amount > leftNgn
  const tierLabel = 'Tier ' + (budget ? budget.tier : 1) + ' \u00B7 NGN'

  async function run() {
    if (!client) return
    setStage('proving')
    setDone(0)
    setFailedStep(null)
    setReceipt(null)
    setFailure(null)
    const usd = nairaToUsd(amount)
    const call = 'clearance.send({ to, amountUsd: ' + usd + ' })'
    try {
      const r = await client.send({
        to: DEMO_CHIDI,
        amountUsd: usd,
        onProgress: (p) => {
          const i = STEPS.findIndex((s) => s.key === p.step)
          if (i >= 0) setDone(i)
        },
      })
      setDone(STEPS.length)
      setReceipt(r)
      addEntry({
        kind: 'cleared',
        amountNgn: amount,
        call,
        txHash: r.txHash,
        explorerUrl: r.explorerUrl,
        provingMs: r.provingMs,
      })
    } catch (e) {
      if (e instanceof ClearanceError) {
        const i = STEPS.findIndex((s) => s.key === e.context.step)
        setFailedStep(e.context.step ?? null)
        if (i >= 0) setDone(i)
        setFailure({ code: e.code, message: e.userMessage })
        addEntry({ kind: 'not_sent', amountNgn: amount, call, code: e.code })
      } else {
        setFailure({
          code: 'ERROR',
          message: 'Something went wrong. Nothing was sent.',
        })
        addEntry({ kind: 'not_sent', amountNgn: amount, call, code: 'ERROR' })
      }
    }
  }

  const suggest = Math.floor(Math.min(20000, perNgn, leftNgn) / 1000) * 1000

  if (stage === 'amount') {
    const hintLabel = overPer
      ? 'Over per-payment limit by'
      : overDaily
        ? 'Over today\u2019s limit by'
        : 'Left after this'
    const hintValue = overPer
      ? amount - perNgn
      : overDaily
        ? amount - leftNgn
        : leftNgn - amount
    const bad = overPer || overDaily
    return (
      <div className="app-shell">
        <main className="app-screen">
          <div className="app-top">
            <Link className="app-back" to="/app/home">&larr; Back</Link>
            <div className="app-pill mono">{tierLabel}</div>
          </div>

          <div className="app-field">
            <div className="app-label">To</div>
            <div className="app-panel mono">{short(DEMO_CHIDI)}</div>
          </div>

          <div className="app-field">
            <div className="app-label">Amount</div>
            <div className="app-amount mono">{naira(amount)}</div>
            <div className="app-chips">
              {CHIPS.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={'app-chip mono' + (amount === c ? ' app-chip-on' : '')}
                  onClick={() => {
                    setAmount(c)
                    setCustom('')
                  }}
                >
                  {naira(c)}
                </button>
              ))}
            </div>
            <input
              className="app-input mono"
              inputMode="numeric"
              placeholder="Or enter an amount in naira"
              aria-label="Amount in naira"
              value={custom}
              onChange={(e) => {
                const v = e.target.value.replace(/\D/g, '').slice(0, 9)
                setCustom(v)
                setAmount(Number(v) || 0)
              }}
            />
          </div>

          <div className="app-panel app-rows mono">
            <div className="app-row">
              <span>Left today</span>
              <span>{budget ? naira(leftNgn) : '\u2014'}</span>
            </div>
            <div className={'app-row app-row-top' + (bad ? ' app-bad' : ' app-good')}>
              <span>{hintLabel}</span>
              <span>{budget ? naira(Math.max(hintValue, 0)) : '\u2014'}</span>
            </div>
          </div>

          <div className={'app-note' + (bad ? ' app-bad' : '')}>
            {overPer
              ? 'This will not be sent. It is over your ' + naira(perNgn) + ' per-payment limit. Nothing leaves your wallet.'
              : overDaily
                ? 'This will not be sent. It is under your ' + naira(perNgn) + ' per-payment limit, but over today\u2019s daily limit. Nothing leaves your wallet.'
                : 'Within your limit. Your name, the receiver and the amount stay private.'}
          </div>

          <div className="app-foot">
            <button
              type="button"
              className="app-btn"
              disabled={amount <= 0 || !budget}
              onClick={() => setStage('review')}
            >
              Review
            </button>
            <span className="app-center-text">
              Marigold is a fictional demo app. Testnet only.
            </span>
          </div>
        </main>
      </div>
    )
  }

  if (stage === 'review') {
    return (
      <div className="app-shell">
        <main className="app-screen">
          <div className="app-top">
            <button type="button" className="app-back" onClick={() => setStage('amount')}>
              &larr; Edit
            </button>
            <div className="app-pill mono">{tierLabel}</div>
          </div>

          <div className="app-field">
            <div className="app-label">Review before sending</div>
            <div className="app-amount mono">{naira(amount)}</div>
          </div>

          <div className="app-panel app-rows mono">
            <div className="app-row"><span>To</span><span>{short(DEMO_CHIDI)}</span></div>
            <div className="app-row"><span>From</span><span>Private balance</span></div>
            <div className="app-row"><span>Fee</span><span>None</span></div>
            <div className="app-row-top app-rows">
              <div className="app-label">Checked on your device next</div>
              <div className="app-row"><span>Per payment</span><span>up to {naira(perNgn)}</span></div>
              <div className="app-row"><span>Left today</span><span>{naira(leftNgn)}</span></div>
            </div>
          </div>

          <div className="app-note">
            A sealed record is attached that only Marigold&rsquo;s licensed
            operator can open. Nothing is sent if a check fails.
          </div>

          <div className="app-foot">
            <button type="button" className="app-btn" onClick={() => void run()}>
              Send {naira(amount)}
            </button>
            <span className="app-center-text">
              Marigold is a fictional demo app. Testnet only.
            </span>
          </div>
        </main>
      </div>
    )
  }

  if (stage === 'proving') {
    const finished = receipt !== null || failure !== null
    const failedIdx = failedStep ? STEPS.findIndex((s) => s.key === failedStep) : -1
    return (
      <div className="app-shell">
        <main className="app-screen">
          <div className="app-top">
            <span className="app-back">&nbsp;</span>
            <div className="app-pill mono">{tierLabel}</div>
          </div>

          <div className="app-field">
            <div className="app-label">Sending privately</div>
            <div className="app-amount mono">{naira(amount)}</div>
          </div>

          <div className="app-panel app-steps">
            <div className="app-steps-head">
              <div className="app-steps-title">
                {receipt ? 'Proof complete' : failure ? 'Stopped' : 'Proving your payment'}
              </div>
              <div className="app-dim mono">{finished ? 'done' : 'about 4s'}</div>
            </div>
            {STEPS.map((s, i) => {
              const isFailed = i === failedIdx
              const isDone = !isFailed && i < done
              const isActive = !finished && i === done
              const mark = isFailed ? '\u2715' : isDone ? '\u2713' : isActive ? '\u2026' : ''
              const status = isFailed
                ? 'Failed'
                : isDone
                  ? 'Passed'
                  : isActive
                    ? 'Checking'
                    : failure
                      ? 'Not run'
                      : 'Waiting'
              return (
                <div key={s.key} className="app-step">
                  <div
                    className={
                      'app-mark mono' +
                      (isFailed ? ' app-mark-fail' : isDone ? ' app-mark-done' : isActive ? ' app-mark-active' : '')
                    }
                  >
                    {mark}
                  </div>
                  <div className={'app-step-label' + (isDone || isActive || isFailed ? '' : ' app-dim')}>
                    {s.label}
                  </div>
                  <div className={'app-step-status mono' + (isFailed ? ' app-bad' : isDone ? ' app-good' : '')}>
                    {status}
                  </div>
                </div>
              )
            })}
          </div>

          {!finished && (
            <div className="app-note">
              The proof is built on your device. Your name, the receiver and the
              amount never leave it.
            </div>
          )}

          <div className="app-foot">
            {finished && (
              <button
                type="button"
                className="app-btn"
                onClick={() => setStage(receipt ? 'cleared' : 'blocked')}
              >
                Continue
              </button>
            )}
          </div>
        </main>
      </div>
    )
  }

  if (stage === 'cleared' && receipt) {
    const rSpent = toNgn(receipt.budget.spentTodayUsd)
    const rDaily = toNgn(receipt.budget.dailyLimitUsd)
    const rLeft = Math.max(rDaily - rSpent, 0)
    const filled = rDaily > 0 ? Math.round((rSpent / rDaily) * METER_TICKS) : 0
    return (
      <div className="app-shell">
        <main className="app-screen">
          <div className="app-top">
            <div className="app-back">Payment</div>
            <div className="app-pill mono">{tierLabel}</div>
          </div>

          <div className="app-result-head">
            <span className="stamp stamp-cleared">CLEARED</span>
            <h1 className="app-h1">{naira(amount)} sent privately.</h1>
          </div>

          <div className="app-panel app-rows mono">
            <div className="app-row">
              <span>To</span>
              <span className="app-redact" />
            </div>
            <div className="app-row">
              <span>Proved in</span>
              <span>{(receipt.provingMs / 1000).toFixed(1)}s &middot; {receipt.packId}</span>
            </div>
            <div className="app-row">
              <span>Receipt</span>
              <span>tx {receipt.txHash.slice(0, 6)}&hellip;{receipt.txHash.slice(-4)}</span>
            </div>
            <a className="app-inline" href={receipt.explorerUrl} target="_blank" rel="noreferrer">
              View on Stellar Expert
            </a>
            <div className="app-row-top app-rows">
              <div className="app-row">
                <span>Left today</span>
                <span>{naira(rLeft)}</span>
              </div>
              <div className="app-ticks" role="img" aria-label="Spent today against the daily limit">
                {Array.from({ length: METER_TICKS }, (_, i) => (
                  <div
                    key={i}
                    className="app-tick"
                    style={{ background: i < filled ? '#15181B' : 'transparent' }}
                  />
                ))}
              </div>
            </div>
          </div>

          <div className="app-note">
            {IS_MOCK ? 'Sample transaction. Real links come from the SDK. ' : ''}
            Fixed demo rate &#8358;1,600 per USD.
          </div>

          <div className="app-foot">
            <button type="button" className="app-btn" onClick={() => navigate('/app/home')}>
              Done
            </button>
          </div>
        </main>
      </div>
    )
  }

  const code = failure ? failure.code : 'ERROR'
  const headline =
    code === 'OVER_DAILY_BUDGET'
      ? 'Over your ' + tierLabel.split(' \u00B7')[0] + ' daily limit'
      : code === 'OVER_PER_PAYMENT_LIMIT'
        ? 'Over your per-payment limit'
        : 'Payment not sent'
  return (
    <div className="app-shell">
      <main className="app-screen">
        <div className="app-top">
          <button type="button" className="app-back" onClick={() => setStage('amount')}>
            &larr; Back
          </button>
          <div className="app-pill mono">{tierLabel}</div>
        </div>

        <div className="app-field">
          <div className="app-label">Sending privately</div>
          <div className="app-amount mono">{naira(amount)}</div>
        </div>

        <div className="app-panel app-panel-held">
          <div className="app-result-head app-result-row">
            <span className="stamp stamp-held">NOT SENT</span>
            <div className="app-steps-title">{headline}</div>
          </div>

          {code === 'OVER_DAILY_BUDGET' && (
            <div className="app-rows mono app-row-top">
              <div className="app-row"><span>Already sent today</span><span>{naira(spentNgn)}</span></div>
              <div className="app-row"><span>This payment</span><span>{naira(amount)}</span></div>
              <div className="app-row app-row-top"><span>Total</span><span>{naira(spentNgn + amount)}</span></div>
              <div className="app-row app-bad"><span>Daily limit</span><span>{naira(dailyNgn)}</span></div>
            </div>
          )}
          {code === 'OVER_PER_PAYMENT_LIMIT' && (
            <div className="app-rows mono app-row-top">
              <div className="app-row"><span>This payment</span><span>{naira(amount)}</span></div>
              <div className="app-row app-bad"><span>Per-payment limit</span><span>{naira(perNgn)}</span></div>
            </div>
          )}

          <div className="app-note">
            {failure ? failure.message : 'Nothing was sent.'}
          </div>
          <div className="mono app-bad app-code">{code}</div>
        </div>

        <div className="app-actions">
          {suggest >= 1000 && (
            <button
              type="button"
              className="app-btn"
              onClick={() => {
                setAmount(suggest)
                setCustom('')
                setStage('amount')
              }}
            >
              Try {naira(suggest)} instead
            </button>
          )}
          <Link className="app-link app-center" to="/app/verify">
            Verify identity for a higher limit
          </Link>
        </div>

        <div className="app-foot">
          <span>
            Your {naira(leftNgn)} left today is unchanged. Verifying takes a few
            minutes: your provider checks your ID, then you try again.
          </span>
        </div>
      </main>
    </div>
  )
}
