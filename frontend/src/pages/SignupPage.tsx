import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApp } from '../app/AppContext'
import { errText, loadArtifacts, saveDemoCreds } from '../sdk/clearance'
import '../app/app.css'

export default function SignupPage() {
  const { signIn, connectWallet } = useApp()
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [setup, setSetup] = useState(false)
  const [pendingName, setPendingName] = useState('Ada')
  const [stellarSecret, setStellarSecret] = useState('')
  const [identitySecret, setIdentitySecret] = useState('')

  // Start fetching the proving files while the person fills in the form.
  useEffect(() => {
    loadArtifacts().catch(() => undefined)
  }, [])

  async function enter(displayName: string) {
    setBusy(true)
    setError('')
    try {
      await signIn(displayName)
      navigate('/app/home')
    } catch (e) {
      if (e instanceof Error && e.message === 'NO_DEMO_CREDS') {
        setPendingName(displayName)
        setSetup(true)
      } else {
        console.error(e)
        setError('Could not connect to Stellar testnet. Nothing changed. ' + errText(e))
      }
      setBusy(false)
    }
  }

  async function saveAndEnter() {
    if (!/^S[A-Z2-7]{55}$/.test(stellarSecret.trim()) || !identitySecret.trim()) {
      setError('Paste both keys exactly as you received them.')
      return
    }
    saveDemoCreds(stellarSecret, identitySecret)
    setStellarSecret('')
    setIdentitySecret('')
    await enter(pendingName)
  }

  async function connect() {
    setBusy(true)
    setError('')
    try {
      await connectWallet()
      navigate('/app/home')
    } catch {
      setError('Wallet connection was cancelled or failed. Nothing changed.')
      setBusy(false)
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!name.trim()) {
      setError('Enter your name.')
      return
    }
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      setError('Enter a valid email address.')
      return
    }
    if (password.length < 8) {
      setError('Use at least 8 characters for the password.')
      return
    }
    setError('')
    void enter(name.trim())
  }

  return (
    <div className="app-shell">
      <main className="app-screen">
        <div className="app-brand">
          <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true">
            <circle cx="13" cy="13" r="12" fill="#15181B" />
            <circle cx="13" cy="13" r="4.5" fill="#F3EFE6" />
          </svg>
          <span>Marigold</span>
        </div>

        <div>
          <h1 className="app-h1">Create your account</h1>
          <p className="app-sub">Send money privately, within your limit.</p>
        </div>

        {setup && (
          <div className="app-form">
            <div className="app-note">
              This demo account runs on Stellar testnet and needs its two keys
              once. They are saved in this browser only.
            </div>
            <div className="app-field">
              <label className="app-label" htmlFor="stellar">Account secret key (starts with S)</label>
              <input
                id="stellar"
                className="app-input mono"
                type="password"
                autoComplete="off"
                value={stellarSecret}
                onChange={(e) => setStellarSecret(e.target.value)}
              />
            </div>
            <div className="app-field">
              <label className="app-label" htmlFor="identity">Identity secret</label>
              <input
                id="identity"
                className="app-input mono"
                type="password"
                autoComplete="off"
                value={identitySecret}
                onChange={(e) => setIdentitySecret(e.target.value)}
              />
            </div>
            {error && <div className="app-error" role="alert">{error}</div>}
            <div className="app-actions">
              <button className="app-btn" type="button" disabled={busy} onClick={() => void saveAndEnter()}>
                {busy ? 'Connecting\u2026' : 'Save and continue'}
              </button>
              <button className="app-link" type="button" disabled={busy} onClick={() => setSetup(false)}>
                Back
              </button>
            </div>
          </div>
        )}

        {!setup && (
        <form className="app-form" onSubmit={onSubmit} noValidate>
          <div className="app-field">
            <label className="app-label" htmlFor="name">Full name</label>
            <input
              id="name"
              className="app-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ada Okafor"
              autoComplete="off"
            />
          </div>
          <div className="app-field">
            <label className="app-label" htmlFor="email">Email</label>
            <input
              id="email"
              className="app-input"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="ada@example.com"
              autoComplete="off"
            />
          </div>
          <div className="app-field">
            <label className="app-label" htmlFor="password">Password</label>
            <input
              id="password"
              className="app-input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 8 characters"
              autoComplete="new-password"
            />
          </div>

          {error && <div className="app-error" role="alert">{error}</div>}

          <div className="app-actions">
            <button className="app-btn" type="submit" disabled={busy}>
              {busy ? 'Connecting\u2026' : 'Create account'}
            </button>
            <button
              className="app-btn app-btn-outline"
              type="button"
              disabled={busy}
              onClick={() => void connect()}
            >
              Connect a Stellar wallet
            </button>
            <button
              className="app-link"
              type="button"
              disabled={busy}
              onClick={() => void enter('Ada')}
            >
              Use demo account
            </button>
          </div>
        </form>
        )}

        <div className="app-foot">
          <span>
            Marigold is a fictional demo app. Testnet only.
          </span>
          <span className="app-powered">
            <svg width="14" height="14" viewBox="0 0 26 26" aria-hidden="true">
              <rect x="1" y="1" width="24" height="24" rx="5" fill="#15181B" />
              <path d="M7 13.5l4 4 8-9" fill="none" stroke="#F3EFE6" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Powered by Clearance
          </span>
        </div>
      </main>
    </div>
  )
}