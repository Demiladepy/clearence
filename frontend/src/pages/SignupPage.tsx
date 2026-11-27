import { useState } from 'react'
import type { FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApp } from '../app/AppContext'
import '../app/app.css'

export default function SignupPage() {
  const { signIn } = useApp()
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function enter(displayName: string) {
    setBusy(true)
    await signIn(displayName)
    navigate('/app/home')
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
              Create account
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

        <div className="app-foot">
          <span>
            Demo only. Nothing you type here is stored or sent. Marigold is a
            fictional app.
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
