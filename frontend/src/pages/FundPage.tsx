import { useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { useApp } from '../app/AppContext'
import { stroopsToUsd } from '@clearance/sdk'
import { errText, nairaToUsd } from '../sdk/clearance'
import { formatNaira } from '../data/content'
import '../app/app.css'

const CHIPS = [50000, 100000]
const naira = (n: number) => '\u20A6' + formatNaira(n)

export default function FundPage() {
  const { session, client } = useApp()
  const navigate = useNavigate()
  const [amount, setAmount] = useState(50000)
  const [busy, setBusy] = useState(false)
  const [tx, setTx] = useState('')
  const [url, setUrl] = useState('')
  const [error, setError] = useState('')

  if (!session) return <Navigate to="/app" replace />

  async function fund() {
    if (!client) return
    setBusy(true)
    setError('')
    try {
      const usd = nairaToUsd(amount)
      const have = await client.getPublicBalance().then(stroopsToUsd, () => null)
      if (have === null || have < usd) {
        setError('This account does not hold enough test funds for ' + naira(amount) + '. Nothing changed.')
        setBusy(false)
        return
      }
      const r = await client.deposit(usd)
      setTx(r.txHash)
      setUrl(r.explorerUrl)
    } catch (e) {
      console.error(e)
      setError('Funding did not finish. Nothing changed. ' + errText(e))
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
                {busy ? 'Funding\u2026 about 10 seconds' : 'Fund ' + naira(amount)}
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
            {url && (
              <a className="app-inline" href={url} target="_blank" rel="noreferrer">
                View on Stellar Expert
              </a>
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