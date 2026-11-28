import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  connectOperator,
  disconnectOperator,
  errText,
  kycRequests,
  nairaToUsd,
  readPack,
  removeKycRequest,
  restoreOperator,
  usdToNaira,
} from '../sdk/clearance'
import type { KycRequest, Operator, PackView } from '../sdk/clearance'
import type { OpenedRecord, SealedRecordSummary, Tier } from '../sdk/types'
import { formatNaira } from '../data/content'
import '../app/operator.css'

const naira = (usd: number) => '\u20A6' + formatNaira(Math.round(usdToNaira(usd)))
const short = (a: string) => (a.length > 14 ? a.slice(0, 6) + '\u2026' + a.slice(-5) : a)

export default function OperatorPage() {
  const [op, setOp] = useState<Operator | null>(null)
  const [ready, setReady] = useState(false)
  const [secret, setSecret] = useState('')
  const [recordKey, setRecordKey] = useState('')
  const [pack, setPack] = useState<PackView | null>(null)
  const [records, setRecords] = useState<SealedRecordSummary[]>([])
  const [opened, setOpened] = useState<Record<string, OpenedRecord>>({})
  const [requests, setRequests] = useState<KycRequest[]>(kycRequests())
  const [manualRef, setManualRef] = useState('')
  const [tier1, setTier1] = useState('20000')
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [error, setError] = useState('')

  const load = useCallback(async (o: Operator) => {
    try {
      const [p, r] = await Promise.all([readPack(o), o.listRecords()])
      setPack(p)
      setRecords([...r].sort((a, b) => b.timestamp.localeCompare(a.timestamp)))
      setRequests(kycRequests())
    } catch (e) {
      console.error(e)
      setError('Could not read from Stellar testnet. ' + errText(e))
    }
  }, [])

  useEffect(() => {
    void (async () => {
      const o = await restoreOperator()
      setOp(o)
      setReady(true)
      if (o) await load(o)
    })()
  }, [load])

  async function signIn() {
    setBusy(true)
    setError('')
    try {
      const o = await connectOperator(secret, recordKey)
      setOp(o)
      setSecret('')
      setRecordKey('')
      await load(o)
    } catch (e) {
      console.error(e)
      setError('Those keys did not work. ' + errText(e))
    }
    setBusy(false)
  }

  function signOut() {
    disconnectOperator()
    setOp(null)
    setPack(null)
    setRecords([])
    setOpened({})
  }

  async function publish() {
    if (!op || !pack) return
    const n = Number(tier1.replace(/\D/g, ''))
    if (!n) {
      setError('Enter the new Tier 1 per-payment limit in naira.')
      return
    }
    setBusy(true)
    setError('')
    setMsg('')
    try {
      const tiers = ([1, 2, 3] as const).map((t) => ({
        perPaymentUsd: t === 1 ? nairaToUsd(n) : pack.tiers[t].perPaymentLimitUsd,
        dailyUsd: pack.tiers[t].dailyLimitUsd,
      }))
      const r = await op.publishPack({
        utcOffsetSecs: pack.utcOffsetSecs,
        travelRuleThresholdUsd: pack.travelRuleThresholdUsd,
        tiers,
      })
      await load(op)
      setConfirm(false)
      setMsg(r.packId + ' is active. Every new payment is checked against it.')
    } catch (e) {
      console.error(e)
      setError('Could not publish the rule pack. Nothing changed. ' + errText(e))
    }
    setBusy(false)
  }

  async function approve(idCommitment: string, tier: Tier) {
    if (!op) return
    setBusy(true)
    setError('')
    setMsg('')
    try {
      await op.issueTier({ idCommitment, tier })
      removeKycRequest(idCommitment)
      setRequests(kycRequests())
      setManualRef('')
      setMsg('Tier ' + tier + ' issued on Stellar. The customer sees it within a few seconds.')
    } catch (e) {
      console.error(e)
      setError('Could not issue the tier. ' + errText(e))
    }
    setBusy(false)
  }

  async function open(id: string) {
    if (!op) return
    setError('')
    try {
      const o = await op.openRecord(id)
      setOpened((prev) => ({ ...prev, [id]: o }))
    } catch (e) {
      console.error(e)
      setError('This key cannot open that record.')
    }
  }

  return (
    <div className="op-shell">
      <div className="op-wrap">
        <header className="op-head">
          <div className="op-brand">
            <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true">
              <circle cx="13" cy="13" r="12" fill="#15181B" />
              <circle cx="13" cy="13" r="4.5" fill="#F3EFE6" />
            </svg>
            <span>Marigold</span>
            <span className="op-sub">Operator console</span>
          </div>
          <div className="op-head-links">
            {op && (
              <button type="button" className="op-link-btn" onClick={signOut}>
                Disconnect
              </button>
            )}
            <Link className="op-link" to="/app/home">Back to wallet</Link>
          </div>
        </header>

        {error && <div className="op-error" role="alert">{error}</div>}
        {msg && <div className="op-good" role="status">{msg}</div>}

        {ready && !op && (
          <section className="op-card op-login">
            <div className="op-label">Operator sign-in</div>
            <div className="op-note">
              Marigold&rsquo;s licensed operator signs in with two keys. They stay
              in this browser and are never sent anywhere except to sign
              Stellar testnet transactions.
            </div>
            <label className="op-field">
              <span>Operator account secret key (starts with S)</span>
              <input
                className="op-input"
                type="password"
                autoComplete="off"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
              />
            </label>
            <label className="op-field">
              <span>Record key</span>
              <input
                className="op-input"
                type="password"
                autoComplete="off"
                value={recordKey}
                onChange={(e) => setRecordKey(e.target.value)}
              />
            </label>
            <button
              type="button"
              className="op-btn"
              disabled={busy || !secret || !recordKey}
              onClick={() => void signIn()}
            >
              {busy ? 'Connecting\u2026' : 'Sign in'}
            </button>
          </section>
        )}

        {op && (
          <div className="op-grid">
            <div className="op-col">
              <section className="op-card">
                <div className="op-label">Active rule pack</div>
                <div className="op-pack-id mono">{pack ? pack.id : '\u2014'}</div>

                {pack && (
                  <div className="op-table mono">
                    <div className="op-trow op-thead">
                      <span>Tier</span>
                      <span className="op-num">Per payment</span>
                      <span className="op-num">Daily</span>
                    </div>
                    {([1, 2, 3] as const).map((t) => (
                      <div key={t} className="op-trow">
                        <span>Tier {t}</span>
                        <span className="op-num">{naira(pack.tiers[t].perPaymentLimitUsd)}</span>
                        <span className="op-num">{naira(pack.tiers[t].dailyLimitUsd)}</span>
                      </div>
                    ))}
                    <div className="op-trow op-travel">
                      <span>Travel Rule flag</span>
                      <span className="op-num op-span2">
                        ${pack.travelRuleThresholdUsd} a day ({naira(pack.travelRuleThresholdUsd)})
                      </span>
                    </div>
                  </div>
                )}

                <label className="op-field">
                  <span>New Tier 1 per-payment limit (naira)</span>
                  <input
                    className="op-input mono"
                    inputMode="numeric"
                    value={tier1}
                    onChange={(e) => {
                      setTier1(e.target.value.replace(/\D/g, '').slice(0, 9))
                      setConfirm(false)
                    }}
                  />
                </label>

                {!confirm ? (
                  <button
                    type="button"
                    className="op-btn"
                    disabled={busy || !pack}
                    onClick={() => setConfirm(true)}
                  >
                    Publish new version
                  </button>
                ) : (
                  <button
                    type="button"
                    className="op-btn"
                    disabled={busy}
                    onClick={() => void publish()}
                  >
                    {busy ? 'Publishing\u2026' : 'Confirm: this is a real testnet transaction'}
                  </button>
                )}
                <div className="op-note">
                  Publishing applies the new version to every new payment at
                  once, for everyone. Other tiers stay as they are. Fixed demo
                  rate &#8358;1,600 per USD.
                </div>
              </section>

              <section className="op-card">
                <div className="op-label">Verification requests</div>
                {requests.length === 0 && (
                  <div className="op-empty">
                    No requests yet. A customer taps Verify identity in the
                    wallet and the request shows up here.
                  </div>
                )}
                {requests.map((r) => (
                  <div key={r.idCommitment} className="op-rec">
                    <div className="op-rec-top">
                      <div>
                        <div className="op-rec-id">{r.name}</div>
                        <div className="op-rec-meta mono">
                          {short(r.idCommitment)} &middot; wants Tier {r.tier}
                        </div>
                      </div>
                      <button
                        type="button"
                        className="op-open"
                        disabled={busy}
                        onClick={() => void approve(r.idCommitment, r.tier)}
                      >
                        Approve Tier {r.tier}
                      </button>
                    </div>
                  </div>
                ))}
                <label className="op-field">
                  <span>Or paste a customer reference</span>
                  <input
                    className="op-input mono"
                    value={manualRef}
                    onChange={(e) => setManualRef(e.target.value.trim())}
                    placeholder="Reference from the customer"
                  />
                </label>
                <div className="op-row-btns">
                  {([1, 2, 3] as const).map((t) => (
                    <button
                      key={t}
                      type="button"
                      className="op-open"
                      disabled={busy || !manualRef}
                      onClick={() => void approve(manualRef, t)}
                    >
                      Issue Tier {t}
                    </button>
                  ))}
                </div>
              </section>
            </div>

            <section className="op-card">
              <div className="op-card-head">
                <div className="op-label">Sealed records</div>
                <button type="button" className="op-link-btn" onClick={() => op && void load(op)}>
                  Refresh
                </button>
              </div>

              {records.length === 0 && (
                <div className="op-empty">
                  No sealed records yet. Send a payment in the wallet, then
                  refresh.
                </div>
              )}

              {records.map((r) => {
                const o = opened[r.recordId]
                return (
                  <div key={r.recordId} className="op-rec">
                    <div className="op-rec-top">
                      <div>
                        <div className="mono op-rec-id">#{short(r.recordId)}</div>
                        <div className="op-rec-meta">
                          {new Date(r.timestamp).toLocaleTimeString()} &middot; tx {short(r.txHash)}
                        </div>
                      </div>
                      {!o ? (
                        <button
                          type="button"
                          className="op-open"
                          onClick={() => void open(r.recordId)}
                        >
                          Open record
                        </button>
                      ) : (
                        <span className="op-open-done mono">OPENED</span>
                      )}
                    </div>

                    <div className="op-rec-rows mono">
                      <div className="op-rrow">
                        <span>Sender</span>
                        {o ? <span>{o.senderName ?? short(o.sender)}</span> : <span className="op-bar" />}
                      </div>
                      <div className="op-rrow">
                        <span>Receiver</span>
                        {o ? <span>{short(o.receiver)}</span> : <span className="op-bar" />}
                      </div>
                      <div className="op-rrow">
                        <span>Amount</span>
                        {o ? <span>{naira(o.amountUsd)}</span> : <span className="op-bar" />}
                      </div>
                      {o && (
                        <div className="op-rrow">
                          <span>Travel Rule</span>
                          <span className={o.travelRuleFlag ? 'op-flag' : ''}>
                            {o.travelRuleFlag ? 'FLAGGED' : 'Not flagged'}
                          </span>
                        </div>
                      )}
                    </div>
                    <div className="op-rec-foot">
                      {o
                        ? 'Only the operator key can read this. On the public chain there is no amount and no counterparty.'
                        : 'Locked. Only the operator key can open it.'}
                    </div>
                  </div>
                )
              })}
            </section>
          </div>
        )}

        <div className="op-note op-foot">
          Live on Stellar testnet. Marigold is a fictional demo app.
        </div>
      </div>
    </div>
  )
}