import { useEffect, useState } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { useApp } from '../app/AppContext'
import { IS_MOCK, usdToNaira } from '../sdk/mock'
import type { Balance, Budget } from '../sdk/types'
import { formatNaira, METER_TICKS } from '../data/content'
import '../app/app.css'

const HIDDEN = '\u20A6 \u2022\u2022\u2022\u2022\u2022\u2022'

export default function WalletPage() {
  const { session, client, history, signOut } = useApp()
  const [budget, setBudget] = useState<Budget | null>(null)
  const [balance, setBalance] = useState<Balance | null>(null)
  const [hide, setHide] = useState(false)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!client) return
    let live = true
    void Promise.all([client.getBudget(), client.getBalance()]).then(([b, bal]) => {
      if (live) {
        setBudget(b)
        setBalance(bal)
      }
    })
    return () => {
      live = false
    }
  }, [client, history.length])

  if (!session) return <Navigate to="/app" replace />

  const ngn = (usd: number) => '\u20A6' + formatNaira(usdToNaira(usd))
  const show = (text: string) => (hide ? HIDDEN : text)

  const spent = budget ? budget.spentTodayUsd : 0
  const daily = budget ? budget.dailyLimitUsd : 0
  const left = Math.max(daily - spent, 0)
  const filled = daily > 0 ? Math.round((spent / daily) * METER_TICKS) : 0
  const last = history[0]

  return (
    <div className="app-shell">
      <main className="app-screen app-home">
        <div className="app-top">
          <div className="app-brand">
            <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true">
              <circle cx="13" cy="13" r="12" fill="#15181B" />
              <circle cx="13" cy="13" r="4.5" fill="#F3EFE6" />
            </svg>
            <span>Marigold</span>
          </div>
          <div className="app-avatar" aria-label={session.name}>
            {session.name.charAt(0).toUpperCase()}
          </div>
        </div>

        <div className="app-balance-block">
          <div className="app-balance-row">
            <div className="app-label">Private balance</div>
            <button
              type="button"
              className="app-quiet"
              onClick={() => setHide((h) => !h)}
            >
              {hide ? 'Show' : 'Hide'}
            </button>
          </div>
          <div className="app-balance mono">
            {balance ? show(ngn(balance.shieldedUsd)) : '\u2014'}
          </div>
        </div>

        <div className="app-actions">
          <Link className="app-btn" to="/app/send">Send privately</Link>
          <Link className="app-link app-center" to="/app/fund">
            Fund private balance
          </Link>
        </div>

        <div className="app-card">
          <div className="app-card-row">
            <div className="app-label">Today&rsquo;s limit</div>
            <div className="app-left mono">
              {budget ? show(ngn(left)) : '\u2014'} left
            </div>
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
          <div className="app-card-foot">
            <span>
              {budget ? show(ngn(spent)) : '\u2014'} of {budget ? show(ngn(daily)) : '\u2014'} spent
            </span>
            <Link className="app-inline" to="/app/verify">Raise limit</Link>
          </div>
        </div>

        <div className="app-activity">
          <div className="app-label">Activity</div>
          {history.length === 0 && (
            <div className="app-empty">No payments yet.</div>
          )}
          {history.slice(0, 3).map((e) => (
            <div key={e.id} className="app-act-row">
              <div>
                <div className="app-act-to">
                  To <span className="app-redact" />
                </div>
                <div className="mono app-act-amt">
                  {show('\u20A6' + formatNaira(e.amountNgn))}
                </div>
              </div>
              <span
                className={
                  e.kind === 'cleared'
                    ? 'stamp stamp-cleared'
                    : 'stamp stamp-held'
                }
              >
                {e.kind === 'cleared' ? 'CLEARED' : 'NOT SENT'}
              </span>
            </div>
          ))}
        </div>

        <div className="app-foot">
          <div className="app-foot-row">
            <span>Marigold is a fictional demo app.</span>
            <button type="button" className="app-quiet" onClick={signOut}>
              Sign out
            </button>
          </div>
          <span className="app-powered">
            <svg width="14" height="14" viewBox="0 0 26 26" aria-hidden="true">
              <rect x="1" y="1" width="24" height="24" rx="5" fill="#15181B" />
              <path d="M7 13.5l4 4 8-9" fill="none" stroke="#F3EFE6" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Powered by Clearance
          </span>
        </div>

        <div className="app-drawer">
          <button
            type="button"
            className="app-drawer-btn"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
          >
            <span>Developer &middot; {history.length} {history.length === 1 ? 'call' : 'calls'}</span>
            <span>{open ? 'Hide' : 'Show'}</span>
          </button>
          {open && (
            <div className="app-drawer-body mono">
              {last ? (
                <>
                  <div className="app-drawer-dim">Last action</div>
                  <div className="app-drawer-code">{last.call}</div>
                  <div className="app-drawer-line">
                    <span className={last.kind === 'cleared' ? 'app-drawer-ok' : 'app-drawer-bad'}>
                      {last.kind === 'cleared' ? 'cleared' : last.code ?? 'not sent'}
                    </span>
                    {last.provingMs !== undefined && (
                      <span className="app-drawer-dim">
                        proved in {(last.provingMs / 1000).toFixed(1)}s
                      </span>
                    )}
                  </div>
                  {last.txHash && (
                    <div className="app-drawer-dim">
                      tx {last.txHash.slice(0, 6)}&hellip;{last.txHash.slice(-4)}
                      {last.explorerUrl && (
                        <>
                          {' '}&middot;{' '}
                          <a className="app-drawer-a" href={last.explorerUrl} target="_blank" rel="noreferrer">
                            View on Stellar
                          </a>
                        </>
                      )}
                      {IS_MOCK && ' (sample)'}
                    </div>
                  )}
                </>
              ) : (
                <div className="app-drawer-dim">
                  No calls yet. Send a payment to see the SDK call here.
                </div>
              )}
              <div className="app-drawer-dim">
                {IS_MOCK ? 'Mock SDK' : 'Live SDK'} &middot; fixed demo rate &#8358;1,600 per USD
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  )
}
