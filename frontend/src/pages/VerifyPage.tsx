import { useEffect, useRef, useState } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import { stroopsToUsd } from '@clearance/sdk'
import { useApp } from '../app/AppContext'
import { addKycRequest, removeKycRequest, usdToNaira } from '../sdk/clearance'
import type { Budget, Tier } from '../sdk/types'
import { formatNaira } from '../data/content'
import '../app/app.css'

type Stage = 'intro' | 'waiting' | 'done'

const naira = (n: number) => '\u20A6' + formatNaira(n)
const toNgn = (usd: number) => Math.round(usdToNaira(usd))

export default function VerifyPage() {
  const { session, client, history } = useApp()
  const navigate = useNavigate()
  const [stage, setStage] = useState<Stage>('intro')
  const [budget, setBudget] = useState<Budget | null>(null)
  const [now, setNow] = useState<Tier | null>(null)
  const [afterDaily, setAfterDaily] = useState<number | null>(null)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const startTier = useRef<number>(0)

  useEffect(() => {
    if (!client) return
    let live = true
    void (async () => {
      try {
        const [b, t, pack] = await Promise.all([client.getBudget(), client.getTier(), client.getPack()])
        if (!live) return
        setBudget(b)
        const cur = t ? t.tier : null
        setNow(cur)
        const next = Math.min((cur ?? 0) + 1, 3)
        const row = pack.tiers[next - 1]
        setAfterDaily(row ? stroopsToUsd(row[1]) : null)
      } catch (e) {
        console.error(e)
      }
    })()
    return () => {
      live = false
    }
  }, [client])

  // While waiting: look for the tier the provider issues on chain.
  useEffect(() => {
    if (stage !== 'waiting' || !client) return
    let live = true
    const id = window.setInterval(() => {
      void (async () => {
        try {
          const t = await client.getTier()
          if (live && t && t.tier > startTier.current) {
            window.clearInterval(id)
            removeKycRequest(client.idCommitment)
            setBudget(await client.getBudget())
            setNow(t.tier)
            setStage('done')
          }
        } catch (e) {
          console.error(e)
        }
      })()
    }, 4000)
    return () => {
      live = false
      window.clearInterval(id)
    }
  }, [stage, client])

  if (!session) return <Navigate to="/app" replace />

  const last = history[0]
  const retryAmount = last && last.kind === 'not_sent' ? last.amountNgn : 28000
  const tierLabel = now ? 'Tier ' + now + ' \u00B7 NGN' : 'Not verified'
  const target = Math.min((now ?? 0) + 1, 3) as Tier

  async function start() {
    if (!client) return
    setError('')
    try {
      const t = await client.getTier()
      const cur = t ? t.tier : 0
      if (cur >= 3) {
        setError('You are already at the highest tier.')
        return
      }
      startTier.current = cur
      addKycRequest({
        idCommitment: client.idCommitment,
        name: session ? session.name : 'Customer',
        tier: (cur + 1) as Tier,
        at: new Date().toISOString(),
      })
      setStage('waiting')
    } catch (e) {
      console.error(e)
      setError('Could not reach Stellar testnet. Nothing changed. Try again.')
    }
  }

  async function copyRef() {
    if (!client) return
    try {
      await navigator.clipboard.writeText(client.idCommitment)
      setCopied(true)
    } catch {
      /* ignore */
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
                  {now ? 'Tier ' + now : 'Not verified'} &middot;{' '}
                  {budget && now ? naira(toNgn(budget.dailyLimitUsd)) : '\u2014'} a day
                </span>
              </div>
              <div className="app-row app-row-top app-good">
                <span>After</span>
                <span>
                  Tier {target} &middot;{' '}
                  {afterDaily !== null ? naira(toNgn(afterDaily)) : '\u2014'} a day
                </span>
              </div>
            </div>

            {error && <div className="app-error" role="alert">{error}</div>}

            <div className="app-foot">
              <button type="button" className="app-btn" onClick={() => void start()}>
                Verify identity
              </button>
              <span className="app-center-text">
                Takes a few minutes. Your provider checks your ID, then issues
                your new level on Stellar.
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

            <div className="app-note">
              Your provider sees this reference:{' '}
              <span className="mono">
                {client ? client.idCommitment.slice(0, 8) + '\u2026' + client.idCommitment.slice(-6) : ''}
              </span>{' '}
              <button type="button" className="app-inline" onClick={() => void copyRef()}>
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>

            <div className="app-foot">
              <Link className="app-link app-center" to="/operator" target="_blank">
                Provider view: open the operator console
              </Link>
            </div>
          </>
        )}

        {stage === 'done' && (
          <>
            <div className="app-result-head">
              <span className="stamp stamp-cleared">VERIFIED</span>
              <h1 className="app-h1">You are now Tier {now ?? (budget ? budget.tier : target)}.</h1>
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