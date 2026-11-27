import { useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { useApp } from '../app/AppContext'
import { IS_MOCK, nairaToUsd } from '../sdk/mock'
import { formatNaira } from '../data/content'
import '../app/app.css'

const CHIPS = [100000, 400000]
const naira = (n: number) => '\u20A6' + formatNaira(n)

export default function FundPage() {
  const { session, client } = useApp()
  const navigate = useNavigate()
  const [amount, setAmount] = useState(100000)
  const [busy, setBusy] = useState(false)
  const [tx, setTx] = useState('')
  const [error, setError] = useState('')

  if (!session) return <Navigate to="/app" replace />

  async function fund() {
    if (!client) return
    setBusy(true)
    setError('')
    try {
      const r = await client.deposit(nairaToUsd(amount))
      setTx(r.txHash)
    } catch {
      setError('Funding did not finish. Nothing changed. Try again.')
    }
    setBusy(false)
  }

  return (
    <div className="app-shell">
      <main className="app-screen">
        <div className="app-top">
          <button type="button" className="app-back" onClick={() => navigate('/app/home')}>
            &larr; Back
          </button>
        </div>

        {!tx && (
          <>
            <div>
              <div className="app-label">Fund private balance</div>
              <div className="app-amount mono">{naira(amount)}</div>
              <div className="app-chips">
                {CHIPS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className={'app-chip mono' + (amount === c ? ' app-chip-on' : '')}
                    onClick={() => setAmount(c)}
                  >
                    {naira(c)}
                  </button>
                ))}
              </div>
            </div>

            <div className="app-note">
              This moves test funds into your private balance. Only you can see
              what is in it.
            </div>

            {error && <div className="app-error" role="alert">{error}</div>}

            <div className="app-foot">
              <button type="button" className="app-btn" disabled={busy} onClick={() => void fund()}>
                {busy ? 'Funding\u2026' : 'Fund ' + naira(amount)}
              </button>
              <span className="app-center-text">
                Testnet only. Fixed demo rate &#8358;1,600 per USD.
              </span>
            </div>
          </>
        )}

        {tx && (
          <>
            <div className="app-result-head">
              <span className="stamp stamp-cleared">FUNDED</span>
              <h1 className="app-h1">{naira(amount)} added to your private balance.</h1>
            </div>
            <div className="app-panel app-rows mono">
              <div className="app-row">
                <span>Receipt</span>
                <span>tx {tx.slice(0, 6)}&hellip;{tx.slice(-4)}</span>
              </div>
            </div>
            {IS_MOCK && (
              <div className="app-note">Sample transaction. Real links come from the SDK.</div>
            )}
            <div className="app-foot">
              <button type="button" className="app-btn" onClick={() => navigate('/app/home')}>
                Done
              </button>
            </div>
          </>
        )}
      </main>
    </div>
  )
}
