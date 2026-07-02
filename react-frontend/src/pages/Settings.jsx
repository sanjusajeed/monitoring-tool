import { useState, useEffect } from 'react'
import styles from './Settings.module.css'

const API_BASE = import.meta.env.VITE_API_BASE_URL || ''
const BASE_URL = `${API_BASE}/api/support/email-config`
const DETECTOR_URL = `${API_BASE}/api/settings/large-workflow-detector`
const RETENTION_ALL_URL = `${API_BASE}/api/settings/retention`
const RETENTION_URL     = `${API_BASE}/api/settings/data-retention`
const API_MON_RET_URL   = `${API_BASE}/api/settings/api-monitor-retention`

const EMPTY = {
  smtp_host: '',
  smtp_port: 587,
  username: '',
  password: '',
  from_email: '',
  to_email: '',
  use_tls: true,
}

function relTime(iso) {
  if (!iso) return null
  const t = new Date(iso).getTime()
  if (isNaN(t)) return null
  const mins = Math.max(0, Math.round((Date.now() - t) / 60000))
  if (mins < 1)   return 'just now'
  if (mins < 60)  return `${mins} min ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 48)   return `${hrs} hr ago`
  return `${Math.round(hrs / 24)} d ago`
}

function Settings() {
  const [form, setForm] = useState(EMPTY)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [configured, setConfigured] = useState(false)
  const [passwordMasked, setPasswordMasked] = useState('')
  const [status, setStatus] = useState(null) // { type: 'success'|'error', text }

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(BASE_URL)
        const data = await res.json()
        if (data.configured) {
          setConfigured(true)
          setPasswordMasked(data.password_masked || '')
          setForm({
            smtp_host: data.smtp_host || '',
            smtp_port: data.smtp_port ?? 587,
            username: data.username || '',
            password: '', // never pre-fill password
            from_email: data.from_email || '',
            to_email: data.to_email || '',
            use_tls: data.use_tls ?? true,
          })
        }
      } catch (e) {
        setStatus({ type: 'error', text: `Failed to load config: ${e.message}` })
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  function update(field, value) {
    setForm(f => ({ ...f, [field]: value }))
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setSaving(true)
    setStatus(null)
    try {
      const res = await fetch(BASE_URL, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, smtp_port: Number(form.smtp_port) }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail || `HTTP ${res.status}`)
      }
      setStatus({ type: 'success', text: 'Email configuration saved.' })
      setConfigured(true)
    } catch (e) {
      setStatus({ type: 'error', text: e.message })
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className={styles.page}>
        <div className={styles.loadingWrap}>Loading...</div>
      </div>
    )
  }

  return (
    <div className={styles.page}>
      <div className={styles.topbar}>
        <div>
          <h1 className={styles.title}>Settings</h1>
          <p className={styles.subtitle}>Configure email for issue reports sent via the support bot</p>
        </div>
      </div>

      <form className={styles.card} onSubmit={handleSubmit}>
        <h2 className={styles.sectionTitle}>Email (SMTP) configuration</h2>

        <div className={styles.grid}>
          <label className={styles.field}>
            <span>SMTP host</span>
            <input
              type="text"
              value={form.smtp_host}
              onChange={e => update('smtp_host', e.target.value)}
              placeholder="smtp.gmail.com"
              required
            />
          </label>

          <label className={styles.field}>
            <span>SMTP port</span>
            <input
              type="number"
              value={form.smtp_port}
              onChange={e => update('smtp_port', e.target.value)}
              placeholder="587"
              min={1}
              max={65535}
              required
            />
          </label>

          <label className={styles.field}>
            <span>Username</span>
            <input
              type="text"
              value={form.username}
              onChange={e => update('username', e.target.value)}
              placeholder="you@example.com"
              required
            />
          </label>

          <label className={styles.field}>
            <span>Password {configured && passwordMasked && <em className={styles.hint}>(currently {passwordMasked}, leave blank to keep)</em>}</span>
            <input
              type="password"
              value={form.password}
              onChange={e => update('password', e.target.value)}
              placeholder={configured ? 'Leave blank to keep existing' : 'App password or SMTP password'}
              required={!configured}
            />
          </label>

          <label className={styles.field}>
            <span>From address</span>
            <input
              type="email"
              value={form.from_email}
              onChange={e => update('from_email', e.target.value)}
              placeholder="alerts@example.com"
              required
            />
          </label>

          <label className={styles.field}>
            <span>Send issue reports to</span>
            <input
              type="email"
              value={form.to_email}
              onChange={e => update('to_email', e.target.value)}
              placeholder="support@example.com"
              required
            />
          </label>

          <label className={`${styles.field} ${styles.checkboxField}`}>
            <input
              type="checkbox"
              checked={form.use_tls}
              onChange={e => update('use_tls', e.target.checked)}
            />
            <span>Use STARTTLS (uncheck for SMTPS on port 465)</span>
          </label>
        </div>

        {status && (
          <div className={status.type === 'success' ? styles.success : styles.error}>
            {status.text}
          </div>
        )}

        <div className={styles.actions}>
          <button type="submit" className={styles.saveBtn} disabled={saving}>
            {saving ? 'Saving...' : 'Save configuration'}
          </button>
        </div>
      </form>

      <LargeWorkflowDetectorCard />
      <RetentionSettingsCard />
      <TeamsWebhooksCard />
    </div>
  )
}


// ─── Large Workflow Detector ────────────────────────────────────────────────
function LargeWorkflowDetectorCard() {
  const [thresholdMb, setThresholdMb]       = useState(30)
  const [intervalMin, setIntervalMin]       = useState(30)
  const [lastRunAt, setLastRunAt]           = useState(null)
  const [lastMatchCount, setLastMatchCount] = useState(null)
  const [limits, setLimits]                 = useState(null)
  const [loading, setLoading]               = useState(true)
  const [saving,    setSaving]    = useState(false)
  const [status,    setStatus]    = useState(null)
  const [scanning,  setScanning]  = useState(false)
  const [scanResult, setScanResult] = useState(null)

  useEffect(() => {
    (async () => {
      try {
        const res  = await fetch(DETECTOR_URL)
        const data = await res.json()
        setThresholdMb(Math.round((data.threshold_bytes || 30_000_000) / 1024 / 1024))
        setIntervalMin(data.interval_minutes || 30)
        setLastRunAt(data.last_run_at || null)
        setLastMatchCount(data.last_match_count ?? null)
        setLimits(data.limits || null)
      } catch (e) {
        setStatus({ type: 'error', text: `Failed to load detector settings: ${e.message}` })
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  async function handleRunNow() {
    setScanning(true)
    setScanResult(null)
    setStatus(null)
    try {
      const res = await fetch(`${DETECTOR_URL}/run-now`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail ? JSON.stringify(data.detail) : `HTTP ${res.status}`)
      setScanResult(data)
      setLastRunAt(new Date().toISOString())
      setLastMatchCount(data.matches ?? 0)
    } catch (e) {
      setStatus({ type: 'error', text: `Scan failed: ${e.message}` })
    } finally {
      setScanning(false)
    }
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setSaving(true)
    setStatus(null)
    const payload = {
      threshold_bytes:  Math.round(Number(thresholdMb) * 1024 * 1024),
      interval_minutes: Number(intervalMin),
    }
    try {
      const res = await fetch(DETECTOR_URL, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail ? JSON.stringify(err.detail) : `HTTP ${res.status}`)
      }
      setStatus({ type: 'success', text: 'Detector settings saved.' })
    } catch (e) {
      setStatus({ type: 'error', text: e.message })
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return <div className={styles.card}><div className={styles.loadingWrap}>Loading detector settings…</div></div>
  }

  // Bounds (fall back to plan defaults if the server didn't surface them).
  const minMb       = limits ? Math.round(limits.threshold_bytes.min / 1024 / 1024) : 1
  const maxMb       = limits ? Math.round(limits.threshold_bytes.max / 1024 / 1024) : 1000
  const minInterval = limits?.interval_minutes?.min ?? 5
  const maxInterval = limits?.interval_minutes?.max ?? 360

  const lastRunLabel = lastRunAt
    ? `Last scan ran ${relTime(lastRunAt)}${lastMatchCount != null ? ` · found ${lastMatchCount} oversized workflow${lastMatchCount === 1 ? '' : 's'}` : ''}.`
    : 'No scan has run yet.'

  return (
    <form className={styles.card} onSubmit={handleSubmit} style={{ marginTop: 18 }}>
      <h2 className={styles.sectionTitle}>Large Workflow Detector</h2>
      <p style={{ fontSize: 13, color: '#6b7280', margin: '4px 0 14px' }}>
        Scans Temporal every few minutes for workflows whose history exceeds a size threshold,
        then saves the matches so they appear on the Dashboard.
      </p>

      <div className={styles.grid}>
        <label className={styles.field}>
          <span>History size threshold (MB)</span>
          <input
            type="number"
            value={thresholdMb}
            onChange={e => setThresholdMb(e.target.value)}
            min={minMb}
            max={maxMb}
            step={1}
            required
          />
          <em className={styles.hint}>{minMb}–{maxMb} MB. Default 30.</em>
        </label>

        <label className={styles.field}>
          <span>Scan interval (minutes)</span>
          <input
            type="number"
            value={intervalMin}
            onChange={e => setIntervalMin(e.target.value)}
            min={minInterval}
            max={maxInterval}
            step={1}
            required
          />
          <em className={styles.hint}>{minInterval}–{maxInterval} min. Default 30.</em>
        </label>
      </div>

      <div style={{ marginTop: 6, fontSize: 12, color: '#6b7280' }}>
        {lastRunLabel}
      </div>
      <div style={{ marginTop: 6, fontSize: 12, color: '#9ca3af' }}>
        Changes take effect within 5 minutes (the K8s cron tick).
      </div>

      {scanResult && !scanning && (
        <div style={{ marginTop: 12, padding: '12px 16px', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8, fontSize: 13, color: '#166534' }}>
          <strong>Scan complete.</strong> Scanned {scanResult.scanned?.toLocaleString() ?? '?'} workflows
          in the last {scanResult.interval_min} min window —
          found <strong>{scanResult.matches}</strong> exceeding {Math.round((scanResult.threshold_bytes || 0) / 1024 / 1024)} MB.
          {scanResult.matches > 0 && ' Results updated on Dashboard.'}
        </div>
      )}

      {status && (
        <div className={status.type === 'success' ? styles.success : styles.error}>
          {status.text}
        </div>
      )}

      <div className={styles.actions} style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
        <button
          type="button"
          onClick={handleRunNow}
          disabled={scanning}
          style={{ padding: '10px 20px', borderRadius: 9, border: '1.5px solid #6366f1', background: scanning ? '#e0e7ff' : '#fff', color: '#4f46e5', fontWeight: 600, fontSize: 14, cursor: scanning ? 'default' : 'pointer' }}
        >
          {scanning ? '⏳ Scanning…' : '▶ Run Now'}
        </button>
        <button type="submit" className={styles.saveBtn} disabled={saving}>
          {saving ? 'Saving…' : 'Save detector settings'}
        </button>
      </div>
    </form>
  )
}


// ─── Retention Settings (Log + API Monitor — single fetch) ───────────────────
function RetentionSettingsCard() {
  // Log retention state
  const [logDays,       setLogDays]       = useState(14)
  const [logLastRun,    setLogLastRun]     = useState(null)
  const [logLastStats,  setLogLastStats]   = useState(null)
  const [logSaving,     setLogSaving]      = useState(false)
  const [logCleaning,   setLogCleaning]    = useState(false)
  const [logResult,     setLogResult]      = useState(null)

  // API Monitor retention state
  const [apiDays,       setApiDays]        = useState(30)
  const [apiLastRun,    setApiLastRun]      = useState(null)
  const [apiLastDel,    setApiLastDel]      = useState(null)
  const [apiSaving,     setApiSaving]       = useState(false)
  const [apiCleaning,   setApiCleaning]     = useState(false)
  const [apiResult,     setApiResult]       = useState(null)

  const [loading, setLoading] = useState(true)
  const [status,  setStatus]  = useState(null)

  // Single fetch for both settings
  useEffect(() => {
    (async () => {
      try {
        const res  = await fetch(RETENTION_ALL_URL)
        const data = await res.json()
        const log = data.log || {}
        const api = data.api_monitor || {}

        setLogDays(log.retention_days || 14)
        setLogLastRun(log.last_run_at || null)
        if (log.last_run_at) {
          setLogLastStats({
            app_insights:    log.last_deleted_app_insights    ?? 0,
            tenant_insights: log.last_deleted_tenant_insights ?? 0,
            wf_docs:         log.last_trimmed_wf_docs          ?? 0,
          })
        }

        setApiDays(api.retention_days || 30)
        setApiLastRun(api.last_run_at || null)
        setApiLastDel(api.last_deleted_runs ?? null)
      } catch (e) {
        setStatus({ type: 'error', text: `Failed to load retention settings: ${e.message}` })
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  async function handleLogClean() {
    setLogCleaning(true)
    setLogResult(null)
    setStatus(null)
    try {
      const res  = await fetch(`${RETENTION_URL}/run-now`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail ? JSON.stringify(data.detail) : `HTTP ${res.status}`)
      setLogResult(data)
      setLogLastRun(new Date().toISOString())
      setLogLastStats({ app_insights: data.deleted_app_insights ?? 0, tenant_insights: data.deleted_tenant_insights ?? 0, wf_docs: data.trimmed_wf_docs ?? 0 })
    } catch (e) {
      setStatus({ type: 'error', text: `Log cleanup failed: ${e.message}` })
    } finally {
      setLogCleaning(false)
    }
  }

  async function handleLogSave(e) {
    e.preventDefault()
    setLogSaving(true)
    setStatus(null)
    try {
      const res = await fetch(RETENTION_URL, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ retention_days: Number(logDays) }) })
      if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.detail ? JSON.stringify(err.detail) : `HTTP ${res.status}`) }
      setStatus({ type: 'success', text: 'Log retention saved.' })
    } catch (e) {
      setStatus({ type: 'error', text: e.message })
    } finally {
      setLogSaving(false)
    }
  }

  async function handleApiClean() {
    setApiCleaning(true)
    setApiResult(null)
    setStatus(null)
    try {
      const res  = await fetch(`${API_MON_RET_URL}/run-now`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail ? JSON.stringify(data.detail) : `HTTP ${res.status}`)
      setApiResult(data)
      setApiLastRun(new Date().toISOString())
      setApiLastDel(data.deleted_runs ?? 0)
    } catch (e) {
      setStatus({ type: 'error', text: `API Monitor cleanup failed: ${e.message}` })
    } finally {
      setApiCleaning(false)
    }
  }

  async function handleApiSave(e) {
    e.preventDefault()
    setApiSaving(true)
    setStatus(null)
    try {
      const res = await fetch(API_MON_RET_URL, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ retention_days: Number(apiDays) }) })
      if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.detail ? JSON.stringify(err.detail) : `HTTP ${res.status}`) }
      setStatus({ type: 'success', text: 'API Monitor retention saved.' })
    } catch (e) {
      setStatus({ type: 'error', text: e.message })
    } finally {
      setApiSaving(false)
    }
  }

  if (loading) {
    return <div className={styles.card} style={{ marginTop: 18 }}><div className={styles.loadingWrap}>Loading retention settings…</div></div>
  }

  const divider = <hr style={{ border: 'none', borderTop: '1px solid #e5e7eb', margin: '20px 0' }} />

  const logLastLabel = logLastRun
    ? `Last cleanup ${relTime(logLastRun)}${logLastStats ? ` · removed ${(logLastStats.app_insights + logLastStats.tenant_insights).toLocaleString()} snapshots, trimmed ${logLastStats.wf_docs} wf docs` : ''}.`
    : 'No cleanup has run yet.'

  const apiLastLabel = apiLastRun
    ? `Last cleanup ${relTime(apiLastRun)}${apiLastDel != null ? ` · deleted ${apiLastDel.toLocaleString()} run${apiLastDel === 1 ? '' : 's'}` : ''}.`
    : 'No cleanup has run yet.'

  const btnStyle = (color, active) => ({
    padding: '10px 20px', borderRadius: 9, border: `1.5px solid ${color}`,
    background: active ? '#fee2e2' : '#fff', color, fontWeight: 600, fontSize: 14,
    cursor: active ? 'default' : 'pointer',
  })

  return (
    <div className={styles.card} style={{ marginTop: 18 }}>

      {/* ── Log Retention ── */}
      <form onSubmit={handleLogSave}>
        <h2 className={styles.sectionTitle}>Log Retention</h2>
        <p style={{ fontSize: 13, color: '#6b7280', margin: '4px 0 14px' }}>
          Deletes old app insight snapshots, tenant insight snapshots, and workflow execution
          history every night at 12:00 AM IST.
        </p>
        <div className={styles.grid}>
          <label className={styles.field}>
            <span>Keep data for (days)</span>
            <input type="number" value={logDays} onChange={e => setLogDays(e.target.value)} min={1} max={365} step={1} required />
            <em className={styles.hint}>Default 14. Older data deleted nightly.</em>
          </label>
        </div>
        <div style={{ marginTop: 6, fontSize: 12, color: '#6b7280' }}>{logLastLabel}</div>
        {logResult && !logCleaning && (
          <div style={{ marginTop: 10, padding: '10px 14px', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8, fontSize: 13, color: '#166534' }}>
            <strong>Done.</strong> Deleted {logResult.deleted_app_insights?.toLocaleString()} app + {logResult.deleted_tenant_insights?.toLocaleString()} tenant snapshots,
            trimmed {logResult.trimmed_wf_docs?.toLocaleString()} wf docs (kept last {logResult.retention_days}d).
          </div>
        )}
        <div className={styles.actions} style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 12 }}>
          <button type="button" onClick={handleLogClean} disabled={logCleaning} style={btnStyle('#dc2626', logCleaning)}>
            {logCleaning ? '⏳ Cleaning…' : '🗑 Clean Now'}
          </button>
          <button type="submit" className={styles.saveBtn} disabled={logSaving}>
            {logSaving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>

      {divider}

      {/* ── API Monitor Retention ── */}
      <form onSubmit={handleApiSave}>
        <h2 className={styles.sectionTitle}>API Monitor Retention</h2>
        <p style={{ fontSize: 13, color: '#6b7280', margin: '4px 0 14px' }}>
          Deletes old API Monitor cron run history every night at 12:00 AM IST.
        </p>
        <div className={styles.grid}>
          <label className={styles.field}>
            <span>Keep run history for (days)</span>
            <input type="number" value={apiDays} onChange={e => setApiDays(e.target.value)} min={1} max={365} step={1} required />
            <em className={styles.hint}>Default 30. Older runs deleted nightly.</em>
          </label>
        </div>
        <div style={{ marginTop: 6, fontSize: 12, color: '#6b7280' }}>{apiLastLabel}</div>
        {apiResult && !apiCleaning && (
          <div style={{ marginTop: 10, padding: '10px 14px', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8, fontSize: 13, color: '#166534' }}>
            <strong>Done.</strong> Deleted {apiResult.deleted_runs?.toLocaleString()} API Monitor run{apiResult.deleted_runs === 1 ? '' : 's'} (kept last {apiResult.retention_days}d).
          </div>
        )}
        <div className={styles.actions} style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 12 }}>
          <button type="button" onClick={handleApiClean} disabled={apiCleaning} style={btnStyle('#dc2626', apiCleaning)}>
            {apiCleaning ? '⏳ Cleaning…' : '🗑 Clean Now'}
          </button>
          <button type="submit" className={styles.saveBtn} disabled={apiSaving}>
            {apiSaving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>

      {status && (
        <div className={status.type === 'success' ? styles.success : styles.error} style={{ marginTop: 12 }}>
          {status.text}
        </div>
      )}
    </div>
  )
}


// ─── Teams Webhooks ──────────────────────────────────────────────────────────
const WEBHOOKS_URL = `${API_BASE}/api/settings/teams-webhooks`

function TeamsWebhooksCard() {
  const [webhooks, setWebhooks] = useState([])
  const [loading,  setLoading]  = useState(true)
  const [adding,   setAdding]   = useState(false)
  const [newName,  setNewName]  = useState('')
  const [newUrl,   setNewUrl]   = useState('')
  const [saving,   setSaving]   = useState(false)
  const [testing,  setTesting]  = useState(null)   // id of webhook being tested
  const [status,   setStatus]   = useState(null)   // { type, text }

  useEffect(() => {
    fetch(WEBHOOKS_URL)
      .then(r => r.json())
      .then(d => setWebhooks(d.webhooks || []))
      .catch(e => setStatus({ type: 'error', text: `Failed to load webhooks: ${e.message}` }))
      .finally(() => setLoading(false))
  }, [])

  async function handleAdd(e) {
    e.preventDefault()
    if (!newName.trim() || !newUrl.trim()) return
    setSaving(true)
    setStatus(null)
    try {
      const res  = await fetch(WEBHOOKS_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ name: newName.trim(), url: newUrl.trim() }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const created = await res.json()
      setWebhooks(prev => [...prev, created])
      setNewName('')
      setNewUrl('')
      setAdding(false)
      setStatus({ type: 'success', text: `Webhook "${created.name}" added.` })
    } catch (e) {
      setStatus({ type: 'error', text: e.message })
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(id, name) {
    if (!window.confirm(`Delete webhook "${name}"?`)) return
    setStatus(null)
    try {
      await fetch(`${WEBHOOKS_URL}/${id}`, { method: 'DELETE' })
      setWebhooks(prev => prev.filter(w => w._id !== id))
      setStatus({ type: 'success', text: `Webhook "${name}" deleted.` })
    } catch (e) {
      setStatus({ type: 'error', text: e.message })
    }
  }

  async function handleTest(id, name) {
    setTesting(id)
    setStatus(null)
    try {
      const res = await fetch(`${WEBHOOKS_URL}/${id}/test`, { method: 'POST' })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail || `HTTP ${res.status}`)
      }
      setStatus({ type: 'success', text: `Test message sent to "${name}".` })
    } catch (e) {
      setStatus({ type: 'error', text: `Test failed: ${e.message}` })
    } finally {
      setTesting(null)
    }
  }

  if (loading) {
    return <div className={styles.card}><div className={styles.loadingWrap}>Loading webhooks…</div></div>
  }

  return (
    <div className={styles.card}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <h2 className={styles.sectionTitle} style={{ margin: 0 }}>Microsoft Teams Webhooks</h2>
        {!adding && (
          <button
            type="button"
            onClick={() => { setAdding(true); setStatus(null) }}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '7px 14px', borderRadius: 8, border: 'none',
              background: '#2563eb', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer',
            }}
          >
            + Add webhook
          </button>
        )}
      </div>

      <p style={{ fontSize: 13, color: '#6b7280', margin: '-8px 0 16px' }}>
        Save named webhooks here — then select them from alert rules, Sev A rules, and cron jobs.
      </p>

      {/* Existing webhooks */}
      {webhooks.length === 0 && !adding && (
        <div style={{ fontSize: 13, color: '#9ca3af', padding: '12px 0' }}>No webhooks configured yet.</div>
      )}

      {webhooks.map(w => (
        <div key={w._id} style={{
          display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
          padding: '12px 14px', borderRadius: 10, background: '#f8fafc',
          border: '1px solid #e5e7eb', marginBottom: 8,
        }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 14, color: '#111827', marginBottom: 2 }}>{w.name}</div>
            <div style={{ fontSize: 12, color: '#6b7280', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {w.url}
            </div>
          </div>
          <button
            type="button"
            onClick={() => handleTest(w._id, w.name)}
            disabled={testing === w._id}
            style={{
              padding: '6px 14px', borderRadius: 7, border: '1.5px solid #2563eb',
              background: '#eff6ff', color: '#2563eb', fontSize: 12, fontWeight: 600, cursor: 'pointer',
              opacity: testing === w._id ? 0.6 : 1,
            }}
          >
            {testing === w._id ? 'Sending…' : 'Test'}
          </button>
          <button
            type="button"
            onClick={() => handleDelete(w._id, w.name)}
            style={{
              padding: '6px 14px', borderRadius: 7, border: '1.5px solid #fca5a5',
              background: '#fef2f2', color: '#dc2626', fontSize: 12, fontWeight: 600, cursor: 'pointer',
            }}
          >
            Delete
          </button>
        </div>
      ))}

      {/* Add new webhook form */}
      {adding && (
        <form onSubmit={handleAdd} style={{
          display: 'flex', flexDirection: 'column', gap: 10,
          padding: '14px', borderRadius: 10, background: '#f0f9ff',
          border: '1.5px solid #bae6fd', marginTop: 4,
        }}>
          <div style={{ fontWeight: 600, fontSize: 13, color: '#0369a1' }}>New webhook</div>
          <div className={styles.grid}>
            <label className={styles.field}>
              <span>Name</span>
              <input
                type="text"
                value={newName}
                onChange={e => setNewName(e.target.value)}
                placeholder="e.g. Alerts — axosclearing"
                required
              />
            </label>
            <label className={styles.field}>
              <span>Webhook URL</span>
              <input
                type="url"
                value={newUrl}
                onChange={e => setNewUrl(e.target.value)}
                placeholder="https://outlook.office.com/webhook/..."
                required
              />
            </label>
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" onClick={() => { setAdding(false); setNewName(''); setNewUrl('') }}
              style={{ padding: '7px 16px', borderRadius: 8, border: '1.5px solid #e5e7eb', background: '#fff', color: '#6b7280', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
              Cancel
            </button>
            <button type="submit" disabled={saving}
              style={{ padding: '7px 16px', borderRadius: 8, border: 'none', background: '#2563eb', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', opacity: saving ? 0.6 : 1 }}>
              {saving ? 'Saving…' : 'Save webhook'}
            </button>
          </div>
        </form>
      )}

      {status && (
        <div className={status.type === 'success' ? styles.success : styles.error} style={{ marginTop: 12 }}>
          {status.text}
        </div>
      )}
    </div>
  )
}


export default Settings
