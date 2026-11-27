import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { IS_MOCK, mockOperator, usdToNaira } from '../sdk/mock'
import type { OpenedRecord, PackId, RulePack, SealedRecordSummary } from '../sdk/types'
import { formatNaira } from '../data/content'
import '../app/operator.css'

const naira = (usd: number) => '\u20A6' + formatNaira(Math.round(usdToNaira(usd)))

export default function OperatorPage() {
  const [pack, setPack] = useState<RulePack | null>(null)
  const [records, setRecords] = useState<SealedRecordSummary[]>([])
  const [opened, setOpened] = useState<Record<string, OpenedRecord>>({})
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    const [p, r] = await Promise.all([
      mockOperator.getActivePack(),
      mockOperator.listRecords({}),
    ])
    setPack(p)
    setRecords(
      [...r].sort((a, b) => b.timestamp.localeCompare(a.timestamp)),
    )
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function publish() {
    if (!pack) return
    setBusy(true)
    setError('')
    setMsg('')
    const next = (pack.id === 'NG-v1' ? 'NG-v2' : 'NG-v1') as PackId
    try {
      await mockOperator.setPack(next)
      await load()
      setMsg(next + ' is active. Every new payment is checked against it.')
    } catch {
      setError('Could not publish the rule pack. Nothing changed.')
    }
    setBusy(false)
  }

  async function open(id: string) {
    setError('')
    try {
      const o = await mockOperator.openRecord(id)
      setOpened((prev) => ({ ...prev, [id]: o }))
    } catch {
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
          <Link className="op-link" to="/app/home">Back to wallet</Link>
        </header>

        {error && <div className="op-error" role="alert">{error}</div>}

        <div className="op-grid">
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

            <button
              type="button"
              className="op-btn"
              disabled={busy || !pack}
              onClick={() => void publish()}
            >
              {pack && pack.id === 'NG-v1' ? 'Publish NG-v2' : 'Switch back to NG-v1'}
            </button>
            {msg && <div className="op-good" role="status">{msg}</div>}
            <div className="op-note">
              Publishing a new version applies it to every new payment at once.
              Fixed demo rate &#8358;1,600 per USD.
            </div>
          </section>

          <section className="op-card">
            <div className="op-card-head">
              <div className="op-label">Sealed records</div>
              <button type="button" className="op-link-btn" onClick={() => void load()}>
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
                      <div className="mono op-rec-id">#{r.recordId}</div>
                      <div className="op-rec-meta">
                        {new Date(r.timestamp).toLocaleTimeString()} &middot; {r.packId}
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
                      {o ? <span>{o.senderName ?? o.sender}</span> : <span className="op-bar" />}
                    </div>
                    <div className="op-rrow">
                      <span>Receiver</span>
                      {o ? <span>{o.receiver}</span> : <span className="op-bar" />}
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

        {IS_MOCK && (
          <div className="op-note op-foot">
            Sample data from the mock SDK. Marigold is a fictional demo app.
            Testnet only.
          </div>
        )}
      </div>
    </div>
  )
}
