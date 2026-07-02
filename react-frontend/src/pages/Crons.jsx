import { useState, useEffect, useCallback } from 'react'
import pageStyles from './Integrations.module.css'

const API = import.meta.env.VITE_API_BASE_URL || ''

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

const INTERVAL_OPTIONS = [
  { value: 5,    label: 'Every 5 minutes'  },
  { value: 15,   label: 'Every 15 minutes' },
  { value: 30,   label: 'Every 30 minutes' },
  { value: 60,   label: 'Every 1 hour'     },
  { value: 360,  label: 'Every 6 hours'    },
  { value: 720,  label: 'Every 12 hours'   },
  { value: 1440, label: 'Every 24 hours'   },
]

function fmtSchedule(schedule) {
  if (!schedule) return '—'
  const { type, interval_minutes, time, days, window_start, window_end } = schedule
  let base
  if (type === 'interval') {
    const opt = INTERVAL_OPTIONS.find(o => o.value === interval_minutes)
    base = opt ? opt.label : `Every ${interval_minutes} min`
    if (window_start && window_end)
      base += ` · ${window_start}–${window_end} IST`
  } else if (type === 'daily') {
    base = `Daily at ${time || '00:00'} IST`
  } else if (type === 'weekly') {
    const dayStr = (days || []).map(d => DAY_LABELS[d]).join(', ')
    base = `Weekly on ${dayStr || '—'} at ${time || '00:00'} IST`
  } else {
    base = type || '—'
  }
  return base
}

function fmtDt(iso) {
  if (!iso) return null
  try {
    return new Date(iso).toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: true,
    }) + ' IST'
  } catch { return iso }
}

function relTime(iso) {
  if (!iso) return null
  const ms = Date.now() - new Date(iso).getTime()
  if (!isFinite(ms) || ms < 0) return null
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function Crons() {
  const [crons,      setCrons]      = useState([])
  const [loading,    setLoading]    = useState(true)
  const [loadErr,    setLoadErr]    = useState(null)
  const [modalOpen,  setModalOpen]  = useState(false)
  const [editing,    setEditing]    = useState(null)
  const [runningId,  setRunningId]  = useState(null)
  const [runResults, setRunResults] = useState({})

  const loadCrons = useCallback(async () => {
    try {
      const r = await fetch(`${API}/api/crons`)
      const j = await r.json()
      if (!r.ok) throw new Error(j.detail || `HTTP ${r.status}`)
      setCrons(j.crons || [])
      setLoadErr(null)
    } catch (e) {
      setLoadErr(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadCrons() }, [loadCrons])

  async function handleSave(payload) {
    const url    = editing ? `${API}/api/crons/${editing.id}` : `${API}/api/crons`
    const method = editing ? 'PATCH' : 'POST'
    const r = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!r.ok) {
      const j = await r.json().catch(() => ({}))
      throw new Error(j.detail || `HTTP ${r.status}`)
    }
    setModalOpen(false)
    setEditing(null)
    loadCrons()
  }

  async function handleDelete(id) {
    if (!confirm('Delete this cron job?')) return
    await fetch(`${API}/api/crons/${id}`, { method: 'DELETE' })
    loadCrons()
  }

  async function handleToggle(cron) {
    await fetch(`${API}/api/crons/${cron.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: !cron.enabled }),
    })
    loadCrons()
  }

  async function handleRunNow(cron) {
    setRunningId(cron.id)
    setRunResults(prev => ({ ...prev, [cron.id]: null }))
    try {
      const r = await fetch(`${API}/api/crons/${cron.id}/run-now`, { method: 'POST' })
      const j = await r.json()
      if (!r.ok) throw new Error(j.detail || `HTTP ${r.status}`)
      setRunResults(prev => ({ ...prev, [cron.id]: j }))
      loadCrons()
    } catch (e) {
      setRunResults(prev => ({ ...prev, [cron.id]: { error: e.message } }))
    } finally {
      setRunningId(null)
    }
  }

  function openCreate() { setEditing(null); setModalOpen(true) }
  function openEdit(c)  { setEditing(c);    setModalOpen(true) }

  return (
    <div style={{ background: '#f1f5f9', minHeight: '100vh', fontFamily: "'Inter', -apple-system, system-ui, sans-serif" }}>

      {/* ── Sticky skyline header ── */}
      <div style={{ background: '#fff', borderBottom: '1px solid #e2e8f0', position: 'sticky', top: 0, zIndex: 20, overflow: 'hidden' }}>
        {/* Skyline watermark — left half */}
        <div aria-hidden style={{
          position: 'absolute', top: 0, bottom: -50, left: 0, right: '50%',
          backgroundImage: 'url(/skyline.png)', backgroundRepeat: 'no-repeat',
          backgroundPosition: 'right bottom', backgroundSize: 'auto 200%',
          opacity: 0.45, pointerEvents: 'none', zIndex: 0,
        }} />
        {/* Skyline watermark — right half (mirrored) */}
        <div aria-hidden style={{
          position: 'absolute', top: 0, bottom: -50, left: '50%', right: 0,
          backgroundImage: 'url(/skyline.png)', backgroundRepeat: 'no-repeat',
          backgroundPosition: 'left bottom', backgroundSize: 'auto 200%',
          opacity: 0.45, pointerEvents: 'none', zIndex: 0, transform: 'scaleX(-1)',
        }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 24px', position: 'relative', zIndex: 1 }}>
          <div style={{ width: 38, height: 38, borderRadius: 10, background: 'linear-gradient(135deg,#6366f1,#4f46e5)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', flexShrink: 0 }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
            </svg>
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 800, fontSize: 16, color: '#0f172a', letterSpacing: '-0.3px' }}>Crons</div>
            <div style={{ fontSize: 11.5, color: '#94a3b8', marginTop: 1 }}>Scheduled API Monitor runs · automated SMTP alerts on failure</div>
          </div>
          <button
            onClick={openCreate}
            style={{ background: '#6366f1', color: '#fff', border: 'none', borderRadius: 10, padding: '9px 20px', fontSize: 14, fontWeight: 600, cursor: 'pointer', flexShrink: 0 }}
          >
            + New Cron
          </button>
        </div>
      </div>

      {/* ── Content ── */}
      <div style={{ padding: '24px 36px', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <section>
        <div className={pageStyles.sectionHeader}>
          <h2 className={pageStyles.sectionTitle}>
            Configured
            {crons.length > 0 && <span className={pageStyles.badge}>{crons.length}</span>}
          </h2>
        </div>

        {loading && (
          <div className={pageStyles.loadingWrap}>
            <div className={pageStyles.spinner} />
            <span>Loading crons…</span>
          </div>
        )}

        {loadErr && (
          <div className={pageStyles.errorBox}>Failed to load crons: {loadErr}</div>
        )}

        {!loading && !loadErr && crons.length === 0 && (
          <div className={pageStyles.empty}>
            <span className={pageStyles.emptyIcon}>⏰</span>
            <p>No cron jobs yet.</p>
            <p className={pageStyles.emptyHint}>
              Click <strong>+ New Cron</strong> above to schedule your first API Monitor run.
            </p>
          </div>
        )}

        {!loading && crons.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {crons.map(c => (
              <CronCard
                key={c.id}
                cron={c}
                runResult={runResults[c.id]}
                running={runningId === c.id}
                onEdit={() => openEdit(c)}
                onDelete={() => handleDelete(c.id)}
                onToggle={() => handleToggle(c)}
                onRunNow={() => handleRunNow(c)}
              />
            ))}
          </div>
        )}
      </section>
      </div>

      {modalOpen && (
        <CronModal
          initial={editing}
          onSave={handleSave}
          onClose={() => { setModalOpen(false); setEditing(null) }}
        />
      )}
    </div>
  )
}

// ─── Cron card ────────────────────────────────────────────────────────────────

function RunHistoryPanel({ cronId }) {
  const [runs,    setRuns]    = useState(null)
  const [loading, setLoading] = useState(true)
  const [err,     setErr]     = useState(null)

  useEffect(() => {
    fetch(`${API}/api/crons/${cronId}/runs?limit=10`)
      .then(r => r.json())
      .then(j => { setRuns(j.runs || []); setLoading(false) })
      .catch(e => { setErr(e.message); setLoading(false) })
  }, [cronId])

  if (loading) return <div style={{ padding: '12px 0', color: '#9ca3af', fontSize: 13 }}>Loading history…</div>
  if (err)     return <div style={{ padding: '12px 0', color: '#dc2626', fontSize: 13 }}>Error: {err}</div>
  if (!runs?.length) return <div style={{ padding: '12px 0', color: '#9ca3af', fontSize: 13 }}>No runs recorded yet.</div>

  return (
    <div style={{ marginTop: 12, borderTop: '1px solid #f1f5f9', paddingTop: 12 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
        Run History (last {runs.length})
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {runs.map(run => {
          const ok = run.failed === 0
          return (
            <div key={run.id} style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '8px 12px', borderRadius: 8,
              background: ok ? '#f0fdf4' : '#fef2f2',
              border: `1px solid ${ok ? '#bbf7d0' : '#fecaca'}`,
              fontSize: 12,
            }}>
              <span style={{
                width: 18, height: 18, borderRadius: '50%', flexShrink: 0,
                background: ok ? '#16a34a' : '#dc2626',
                color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 10, fontWeight: 800,
              }}>{ok ? '✓' : '✗'}</span>
              <span style={{ color: '#374151', fontWeight: 600 }}>
                {run.passed}/{run.total} passed
                {run.failed > 0 && <span style={{ color: '#dc2626', marginLeft: 4 }}>· {run.failed} failed</span>}
              </span>
              <span style={{ color: '#9ca3af', marginLeft: 'auto', whiteSpace: 'nowrap' }}>
                {fmtDt(run.ran_at)}
              </span>
              {run.duration_ms > 0 && (
                <span style={{ color: '#6b7280', whiteSpace: 'nowrap' }}>
                  {run.duration_ms >= 1000 ? `${(run.duration_ms / 1000).toFixed(1)}s` : `${run.duration_ms}ms`}
                </span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function CronCard({ cron, runResult, running, onEdit, onDelete, onToggle, onRunNow }) {
  const [showHistory, setShowHistory] = useState(false)
  const lr = cron.last_results
  const apiLabel = cron.api_filter
    ? `${cron.api_filter.length} API${cron.api_filter.length !== 1 ? 's' : ''}`
    : 'All APIs'

  return (
    <div style={{
      background: '#fff', border: '1px solid #eef0f5', borderRadius: 14,
      padding: '18px 22px', boxShadow: '0 1px 4px rgba(0,0,0,0.04)',
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, flexWrap: 'wrap' }}>
        {/* Left: icon */}
        <div style={{
          width: 42, height: 42, borderRadius: 10, flexShrink: 0,
          background: cron.enabled ? '#eef2ff' : '#f3f4f6',
          color: cron.enabled ? '#6366f1' : '#9ca3af',
          display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20,
        }}>⏰</div>

        {/* Middle: info */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 700, fontSize: 15, color: '#111827' }}>{cron.name}</span>
            <span style={{
              fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 999,
              background: cron.enabled ? '#dcfce7' : '#f3f4f6',
              color: cron.enabled ? '#15803d' : '#9ca3af',
            }}>
              {cron.enabled ? 'ENABLED' : 'DISABLED'}
            </span>
            {cron.teams_enabled && (
              <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px',
                borderRadius: 999, background: '#eff6ff', color: '#2563eb',
                border: '1px solid #bfdbfe', whiteSpace: 'nowrap' }}>
                Teams
              </span>
            )}
            {lr && (
              <span style={{
                fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 999,
                background: lr.failed > 0 ? '#fee2e2' : '#dcfce7',
                color: lr.failed > 0 ? '#dc2626' : '#15803d',
              }}>
                {lr.failed > 0 ? `${lr.failed} failed` : `${lr.passed} passed`}
              </span>
            )}
          </div>

          <div style={{ display: 'flex', gap: 16, marginTop: 6, flexWrap: 'wrap', fontSize: 13, color: '#6b7280' }}>
            <span>Collection: <strong style={{ color: '#374151' }}>{cron.collection_name}</strong></span>
            <span>APIs: <strong style={{ color: '#374151' }}>{apiLabel}</strong></span>
            <span>Schedule: <strong style={{ color: '#374151' }}>{fmtSchedule(cron.schedule)}</strong></span>
            <span style={{
              fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 999,
              background: '#f0f9ff', color: '#0369a1', border: '1px solid #bae6fd',
            }}>
              {cron.alert_condition === 'always' ? 'Report always' : 'Alert on failure'}
            </span>
          </div>

          <div style={{ display: 'flex', gap: 16, marginTop: 4, flexWrap: 'wrap', fontSize: 12, color: '#9ca3af' }}>
            {cron.last_run_at && (
              <span>Last run: {relTime(cron.last_run_at)} ({fmtDt(cron.last_run_at)})</span>
            )}
            {cron.next_run_at && cron.enabled && (
              <span>Next run: {fmtDt(cron.next_run_at)}</span>
            )}
            {cron.alert_emails?.length > 0 && (
              <span>Alert emails: {cron.alert_emails.join(', ')}</span>
            )}
          </div>

          {/* run-now result inline */}
          {runResult && !runResult.error && (
            <div style={{
              marginTop: 8, padding: '6px 10px', borderRadius: 7, fontSize: 12,
              background: runResult.failed > 0 ? '#fef2f2' : '#f0fdf4',
              color: runResult.failed > 0 ? '#dc2626' : '#15803d',
              border: `1px solid ${runResult.failed > 0 ? '#fecaca' : '#bbf7d0'}`,
            }}>
              Run complete — {runResult.passed}/{runResult.total} passed
              {runResult.failed > 0 && ` · ${runResult.failed} failed (alert sent if SMTP configured)`}
            </div>
          )}
          {runResult?.error && (
            <div style={{
              marginTop: 8, padding: '6px 10px', borderRadius: 7, fontSize: 12,
              background: '#fef2f2', color: '#dc2626', border: '1px solid #fecaca',
            }}>
              Run error: {runResult.error}
            </div>
          )}
        </div>

        {/* Right: actions */}
        <div style={{ display: 'flex', gap: 8, flexShrink: 0, alignItems: 'center' }}>
          <button
            onClick={onToggle}
            title={cron.enabled ? 'Disable' : 'Enable'}
            style={{
              padding: '6px 12px', borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: 'pointer',
              border: '1.5px solid #e5e7eb',
              background: cron.enabled ? '#fef2f2' : '#f0fdf4',
              color: cron.enabled ? '#dc2626' : '#16a34a',
            }}
          >
            {cron.enabled ? 'Disable' : 'Enable'}
          </button>
          <button
            onClick={onRunNow}
            disabled={running}
            title="Run now"
            style={{
              padding: '6px 12px', borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: running ? 'not-allowed' : 'pointer',
              border: '1.5px solid #e5e7eb',
              background: running ? '#f3f4f6' : '#fff',
              color: running ? '#9ca3af' : '#374151',
            }}
          >
            {running ? 'Running…' : 'Run now'}
          </button>
          <button
            onClick={onEdit}
            style={{
              padding: '6px 12px', borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: 'pointer',
              border: '1.5px solid #e5e7eb', background: '#fff', color: '#374151',
            }}
          >
            Edit
          </button>
          <button
            onClick={onDelete}
            style={{
              padding: '6px 12px', borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: 'pointer',
              border: '1.5px solid #fecaca', background: '#fef2f2', color: '#dc2626',
            }}
          >
            Delete
          </button>
          <button
            onClick={() => setShowHistory(h => !h)}
            style={{
              padding: '6px 12px', borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: 'pointer',
              border: '1.5px solid #e5e7eb',
              background: showHistory ? '#eef2ff' : '#fff',
              color: showHistory ? '#6366f1' : '#374151',
            }}
          >
            {showHistory ? 'Hide History' : 'History'}
          </button>
        </div>
      </div>

      {showHistory && <RunHistoryPanel cronId={cron.id} />}
    </div>
  )
}

// ─── Create / Edit modal ──────────────────────────────────────────────────────

function CronModal({ initial, onSave, onClose }) {
  const isEdit = !!initial

  const [name,        setName]        = useState(initial?.name        || '')
  const [tenant,      setTenant]      = useState(initial?.tenant      || '')
  const [tenants,     setTenants]     = useState([])
  const [collections, setCollections] = useState([])
  const [colId,       setColId]       = useState(initial?.collection_id   || '')
  const [apiFilter,   setApiFilter]   = useState(initial?.api_filter       || null)  // null = all
  const [allApis,     setAllApis]     = useState([])
  const [schedType,    setSchedType]    = useState(initial?.schedule?.type             || 'interval')
  const [intervalMin,  setIntervalMin]  = useState(initial?.schedule?.interval_minutes || 60)
  const [schedTime,    setSchedTime]    = useState(initial?.schedule?.time             || '08:00')
  const [schedDays,    setSchedDays]    = useState(initial?.schedule?.days             || [1])
  const [windowEnabled, setWindowEnabled] = useState(!!(initial?.schedule?.window_start))
  const [windowStart,   setWindowStart]   = useState(initial?.schedule?.window_start  || '17:30')
  const [windowEnd,     setWindowEnd]     = useState(initial?.schedule?.window_end    || '05:30')
  const [alertEmails,    setAlertEmails]    = useState((initial?.alert_emails || []).join(', '))
  const [alertCondition, setAlertCondition] = useState(initial?.alert_condition || 'on_failure')
  const [enabled,        setEnabled]        = useState(initial?.enabled ?? true)
  const [teamsEnabled,   setTeamsEnabled]   = useState(initial?.teams_enabled ?? false)
  const [teamsWebhookId, setTeamsWebhookId] = useState(initial?.teams_webhook_id ?? '')
  const [savedWebhooks,  setSavedWebhooks]  = useState([])
  const [slaResponseMs,  setSlaResponseMs]  = useState(initial?.sla_response_ms  != null ? String(initial.sla_response_ms)  : '')
  const [slaPassRatePct, setSlaPassRatePct] = useState(initial?.sla_pass_rate_pct != null ? String(initial.sla_pass_rate_pct) : '')
  const [saving,      setSaving]      = useState(false)
  const [saveErr,     setSaveErr]     = useState(null)

  // Load tenants + saved webhooks
  useEffect(() => {
    fetch(`${API}/api/insights/tenants`)
      .then(r => r.json())
      .then(j => setTenants(j.tenants || []))
      .catch(() => {})
    fetch(`${API}/api/settings/teams-webhooks`)
      .then(r => r.json())
      .then(d => setSavedWebhooks(d.webhooks || []))
      .catch(() => {})
  }, [])

  // Load collections when tenant changes
  useEffect(() => {
    if (!tenant) { setCollections([]); setColId(''); setAllApis([]); return }
    fetch(`${API}/api/crons/collections?tenant=${encodeURIComponent(tenant)}`)
      .then(r => r.json())
      .then(j => {
        setCollections(j.collections || [])
        // Keep colId if valid; else reset
        const valid = (j.collections || []).find(c => c.id === colId)
        if (!valid) { setColId(''); setAllApis([]) }
      })
      .catch(() => {})
  }, [tenant])

  // Update API list when collection changes
  useEffect(() => {
    const col = collections.find(c => c.id === colId)
    setAllApis(col ? col.requests : [])
    // Reset filter if collection changed in a way that makes old names stale
    if (colId && !initial?.collection_id) setApiFilter(null)
  }, [colId, collections])

  function toggleDay(d) {
    setSchedDays(prev => prev.includes(d) ? prev.filter(x => x !== d) : [...prev, d])
  }

  function toggleApi(name) {
    if (apiFilter === null) {
      // Switch from "all" to explicit list minus this one
      setApiFilter(allApis.filter(a => a !== name))
    } else if (apiFilter.includes(name)) {
      const next = apiFilter.filter(a => a !== name)
      setApiFilter(next.length === 0 ? [] : next)
    } else {
      const next = [...apiFilter, name]
      if (next.length === allApis.length) setApiFilter(null) // back to "all"
      else setApiFilter(next)
    }
  }

  async function handleSubmit(e) {
    e.preventDefault()
    if (!name.trim())  { setSaveErr('Name is required'); return }
    if (!tenant)       { setSaveErr('Tenant is required'); return }
    if (!colId)        { setSaveErr('Collection is required'); return }

    const schedule =
      schedType === 'interval' ? {
        type: 'interval', interval_minutes: Number(intervalMin),
        ...(windowEnabled ? { window_start: windowStart, window_end: windowEnd } : {}),
      }
      : schedType === 'daily'  ? { type: 'daily',  time: schedTime }
      :                          { type: 'weekly',  time: schedTime, days: schedDays }

    const emails = alertEmails
      .split(/[,\s]+/)
      .map(s => s.trim())
      .filter(Boolean)

    const payload = {
      name:            name.trim(),
      tenant,
      collection_id:   colId,
      api_filter:      apiFilter,
      schedule,
      alert_emails:    emails,
      alert_condition: alertCondition,
      enabled,
      teams_enabled:    teamsEnabled,
      teams_webhook_id: teamsEnabled ? teamsWebhookId : null,
      sla_response_ms:   slaResponseMs  ? parseInt(slaResponseMs,  10) : null,
      sla_pass_rate_pct: slaPassRatePct ? parseInt(slaPassRatePct, 10) : null,
    }

    setSaving(true)
    setSaveErr(null)
    try {
      await onSave(payload)
    } catch (err) {
      setSaveErr(err.message || 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const inputStyle = {
    width: '100%', padding: '8px 11px', borderRadius: 8,
    border: '1.5px solid #e5e7eb', fontSize: 13, outline: 'none',
    boxSizing: 'border-box', background: '#fff', color: '#111827',
  }
  const labelStyle = { fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4, display: 'block' }
  const fieldStyle = { display: 'flex', flexDirection: 'column', gap: 4 }

  const allSelected = apiFilter === null
  const selSet = new Set(apiFilter || [])

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
    }}>
      <div style={{
        background: '#fff', borderRadius: 16, padding: 0, width: 560, maxWidth: '95vw',
        maxHeight: '90vh', overflow: 'hidden', display: 'flex', flexDirection: 'column',
        boxShadow: '0 20px 60px rgba(0,0,0,0.18)',
      }}>
        {/* Header */}
        <div style={{
          padding: '20px 24px', borderBottom: '1px solid #f3f4f6',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <span style={{ fontSize: 17, fontWeight: 700, color: '#111827' }}>
            {isEdit ? 'Edit Cron Job' : 'New Cron Job'}
          </span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: '#9ca3af' }}>×</button>
        </div>

        {/* Body */}
        <form onSubmit={handleSubmit} style={{ overflowY: 'auto', padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 16 }}>

          {/* Name */}
          <div style={fieldStyle}>
            <label style={labelStyle}>Name *</label>
            <input style={inputStyle} value={name} onChange={e => setName(e.target.value)} placeholder="e.g. AXOS nightly health" />
          </div>

          {/* Tenant */}
          <div style={fieldStyle}>
            <label style={labelStyle}>Tenant *</label>
            <select style={inputStyle} value={tenant} onChange={e => setTenant(e.target.value)}>
              <option value="">— select tenant —</option>
              {tenants.map(t => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>

          {/* Collection */}
          <div style={fieldStyle}>
            <label style={labelStyle}>Collection *</label>
            <select style={inputStyle} value={colId} onChange={e => setColId(e.target.value)} disabled={!tenant}>
              <option value="">— select collection —</option>
              {collections.map(c => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>

          {/* API filter */}
          {colId && allApis.length > 0 && (
            <div style={fieldStyle}>
              <label style={labelStyle}>APIs to run</label>
              <div style={{
                border: '1.5px solid #e5e7eb', borderRadius: 8, maxHeight: 160,
                overflowY: 'auto', background: '#fafafa',
              }}>
                {/* All APIs */}
                <label style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '7px 12px', borderBottom: '1px solid #f3f4f6',
                  cursor: 'pointer', fontWeight: 600, fontSize: 12, color: '#374151',
                }}>
                  <input
                    type="checkbox" checked={allSelected}
                    onChange={() => setApiFilter(allSelected ? [] : null)}
                  />
                  All APIs ({allApis.length})
                </label>
                {!allSelected && allApis.map(a => (
                  <label key={a} style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '5px 12px 5px 24px', cursor: 'pointer',
                    fontSize: 12, color: '#6b7280',
                    background: selSet.has(a) ? '#eef2ff' : 'transparent',
                  }}>
                    <input
                      type="checkbox" checked={selSet.has(a)}
                      onChange={() => toggleApi(a)}
                    />
                    {a}
                  </label>
                ))}
              </div>
              {!allSelected && (
                <span style={{ fontSize: 11, color: '#9ca3af' }}>
                  {(apiFilter || []).length} of {allApis.length} selected
                </span>
              )}
            </div>
          )}

          {/* Schedule type */}
          <div style={fieldStyle}>
            <label style={labelStyle}>Schedule type</label>
            <div style={{ display: 'flex', gap: 10 }}>
              {['interval', 'daily', 'weekly'].map(t => (
                <label key={t} style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  cursor: 'pointer', fontSize: 13, color: '#374151',
                }}>
                  <input type="radio" name="schedType" value={t} checked={schedType === t} onChange={() => setSchedType(t)} />
                  {t.charAt(0).toUpperCase() + t.slice(1)}
                </label>
              ))}
            </div>
          </div>

          {/* Interval options */}
          {schedType === 'interval' && (
            <div style={fieldStyle}>
              <label style={labelStyle}>Interval</label>
              <select style={inputStyle} value={intervalMin} onChange={e => setIntervalMin(Number(e.target.value))}>
                {INTERVAL_OPTIONS.map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
          )}

          {/* Time window (interval only) */}
          {schedType === 'interval' && (
            <div style={{ border: '1.5px solid #e5e7eb', borderRadius: 10, padding: '12px 14px', background: '#fafafa' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={windowEnabled}
                  onChange={e => setWindowEnabled(e.target.checked)}
                />
                <span style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>Restrict to time window (IST)</span>
              </label>
              {windowEnabled && (
                <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <div style={fieldStyle}>
                    <label style={{ ...labelStyle, fontSize: 11 }}>From</label>
                    <input
                      type="time"
                      style={{ ...inputStyle, width: 130 }}
                      value={windowStart}
                      onChange={e => setWindowStart(e.target.value)}
                    />
                  </div>
                  <div style={{ marginTop: 16, color: '#9ca3af', fontWeight: 600 }}>→</div>
                  <div style={fieldStyle}>
                    <label style={{ ...labelStyle, fontSize: 11 }}>To</label>
                    <input
                      type="time"
                      style={{ ...inputStyle, width: 130 }}
                      value={windowEnd}
                      onChange={e => setWindowEnd(e.target.value)}
                    />
                  </div>
                  <div style={{ marginTop: 14, fontSize: 11, color: '#6b7280', flex: '1 1 100%' }}>
                    Runs every {INTERVAL_OPTIONS.find(o => o.value === intervalMin)?.label?.toLowerCase() || `${intervalMin}m`} between {windowStart} and {windowEnd} IST.
                    {windowStart > windowEnd && <span style={{ color: '#6366f1' }}> Spans midnight IST.</span>}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Daily / Weekly time */}
          {(schedType === 'daily' || schedType === 'weekly') && (
            <div style={fieldStyle}>
              <label style={labelStyle}>Time (IST)</label>
              <input type="time" style={{ ...inputStyle, width: 140 }} value={schedTime} onChange={e => setSchedTime(e.target.value)} />
            </div>
          )}

          {/* Weekly days */}
          {schedType === 'weekly' && (
            <div style={fieldStyle}>
              <label style={labelStyle}>Days of week</label>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {DAY_LABELS.map((d, i) => (
                  <label key={i} style={{
                    display: 'flex', alignItems: 'center', gap: 4,
                    cursor: 'pointer', fontSize: 13,
                    padding: '4px 10px', borderRadius: 7,
                    border: `1.5px solid ${schedDays.includes(i) ? '#6366f1' : '#e5e7eb'}`,
                    background: schedDays.includes(i) ? '#eef2ff' : '#fff',
                    color: schedDays.includes(i) ? '#4f46e5' : '#374151',
                    fontWeight: schedDays.includes(i) ? 600 : 400,
                  }}>
                    <input
                      type="checkbox" checked={schedDays.includes(i)}
                      onChange={() => toggleDay(i)} style={{ display: 'none' }}
                    />
                    {d}
                  </label>
                ))}
              </div>
            </div>
          )}

          {/* Alert condition */}
          <div style={fieldStyle}>
            <label style={labelStyle}>Alert condition</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {[
                { value: 'always',     label: 'Always',        desc: 'Send a full run report after every execution — shows all APIs with pass/fail status.' },
                { value: 'on_failure', label: 'On failure only', desc: 'Only send an alert when at least one API does not match its expected status code.' },
              ].map(opt => (
                <label key={opt.value} style={{
                  display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer',
                  padding: '10px 12px', borderRadius: 8,
                  border: `1.5px solid ${alertCondition === opt.value ? '#6366f1' : '#e5e7eb'}`,
                  background: alertCondition === opt.value ? '#eef2ff' : '#fafafa',
                }}>
                  <input
                    type="radio" name="alertCondition" value={opt.value}
                    checked={alertCondition === opt.value}
                    onChange={() => setAlertCondition(opt.value)}
                    style={{ marginTop: 2, flexShrink: 0 }}
                  />
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: alertCondition === opt.value ? '#4f46e5' : '#374151' }}>
                      {opt.label}
                    </div>
                    <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{opt.desc}</div>
                  </div>
                </label>
              ))}
            </div>
          </div>

          {/* Alert emails */}
          <div style={fieldStyle}>
            <label style={labelStyle}>Alert emails (comma-separated)</label>
            <input
              style={inputStyle}
              value={alertEmails}
              onChange={e => setAlertEmails(e.target.value)}
              placeholder="e.g. ops@example.com, dev@example.com (uses SMTP default if empty)"
            />
            <span style={{ fontSize: 11, color: '#9ca3af' }}>
              Alerts also go to the default SMTP recipient configured in Settings.
            </span>
          </div>

          {/* Teams notification */}
          <div style={fieldStyle}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={teamsEnabled}
                onChange={e => setTeamsEnabled(e.target.checked)}
                style={{ width: 16, height: 16, cursor: 'pointer', accentColor: '#2563eb' }}
              />
              <span style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>
                Send alert to Microsoft Teams
              </span>
            </label>
            {teamsEnabled && (
              savedWebhooks.length === 0 ? (
                <p style={{ fontSize: 12, color: '#9ca3af', marginTop: 6 }}>
                  No webhooks configured. Add one in <strong>Settings → Microsoft Teams Webhooks</strong>.
                </p>
              ) : (
                <select
                  style={{ ...inputStyle, marginTop: 8 }}
                  value={teamsWebhookId}
                  onChange={e => setTeamsWebhookId(e.target.value)}
                  required={teamsEnabled}
                >
                  <option value="">— Select a webhook —</option>
                  {savedWebhooks.map(w => (
                    <option key={w._id} value={w._id}>{w.name}</option>
                  ))}
                </select>
              )
            )}
          </div>

          {/* SLA Alerts */}
          <div style={{ borderTop: '1px solid #f1f5f9', paddingTop: 16 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>SLA Alerts <span style={{ fontWeight: 400, color: '#9ca3af', textTransform: 'none', fontSize: 11 }}>(optional — fires independently of the alert condition above)</span></div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div style={fieldStyle}>
                <label style={labelStyle}>Response time threshold (ms)</label>
                <input
                  type="number" min="0" style={inputStyle}
                  value={slaResponseMs}
                  onChange={e => setSlaResponseMs(e.target.value)}
                  placeholder="e.g. 2000"
                />
                <span style={{ fontSize: 11, color: '#9ca3af' }}>Alert if any API responds slower than this.</span>
              </div>
              <div style={fieldStyle}>
                <label style={labelStyle}>Minimum pass rate (%)</label>
                <input
                  type="number" min="0" max="100" style={inputStyle}
                  value={slaPassRatePct}
                  onChange={e => setSlaPassRatePct(e.target.value)}
                  placeholder="e.g. 95"
                />
                <span style={{ fontSize: 11, color: '#9ca3af' }}>Alert if overall pass rate drops below this.</span>
              </div>
            </div>
          </div>

          {/* Enabled toggle */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <label style={{ ...labelStyle, margin: 0 }}>Enabled</label>
            <button
              type="button"
              onClick={() => setEnabled(v => !v)}
              style={{
                width: 44, height: 24, borderRadius: 12, border: 'none', cursor: 'pointer',
                background: enabled ? '#6366f1' : '#d1d5db', position: 'relative', transition: 'background 0.2s',
              }}
            >
              <span style={{
                position: 'absolute', top: 2, left: enabled ? 22 : 2,
                width: 20, height: 20, borderRadius: '50%',
                background: '#fff', transition: 'left 0.2s',
              }} />
            </button>
            <span style={{ fontSize: 12, color: '#9ca3af' }}>{enabled ? 'On' : 'Off'}</span>
          </div>

          {saveErr && (
            <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '10px 14px', fontSize: 13, color: '#dc2626' }}>
              {saveErr}
            </div>
          )}

          {/* Footer */}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, paddingTop: 4 }}>
            <button type="button" onClick={onClose} style={{
              padding: '9px 20px', borderRadius: 9, border: '1.5px solid #e5e7eb',
              background: '#fff', color: '#374151', fontSize: 14, fontWeight: 600, cursor: 'pointer',
            }}>
              Cancel
            </button>
            <button type="submit" disabled={saving} style={{
              padding: '9px 20px', borderRadius: 9, border: 'none',
              background: saving ? '#c7d2fe' : '#6366f1', color: '#fff',
              fontSize: 14, fontWeight: 600, cursor: saving ? 'not-allowed' : 'pointer',
            }}>
              {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Create cron'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
