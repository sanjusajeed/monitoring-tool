import { useState, useEffect } from 'react'
import pageStyles from './Integrations.module.css'
import modalStyles from '../components/JiffyModal.module.css'
import cardStyles from '../components/IntegrationCard.module.css'

const API = import.meta.env.VITE_API_BASE_URL || ''

const ENV_OPTIONS = [
  { key: 'develop', label: 'Develop',    dot: '#0ea5e9' },
  { key: 'prod',    label: 'Production', dot: '#dc2626' },
  { key: 'uat',     label: 'UAT',        dot: '#d97706' },
  { key: 'qa',      label: 'QA',         dot: '#2563eb' },
  { key: 'dev',     label: 'Dev',        dot: '#10b981' },
  { key: 'stage',   label: 'Stage',      dot: '#8b5cf6' },
  { key: 'demo',    label: 'Demo',       dot: '#0ea5e9' },
]

const CONDITIONS = [
  { key: 'workflow_failed', label: 'Workflow failures', unit: 'count' },
]

const ALERT_TYPE = {
  id:      'rule',
  name:    'Sev A Rule',
  desc:    'Trigger a Sev A alert when a tenant + environment matches your conditions.',
  logo:    '🚨',
  color:   '#dc2626',
  colorBg: '#fef2f2',
}

const fmtCond = (c) => c.key === 'workflow_failed'
  ? `${c.label}: any failure`
  : `${c.label} > ${c.threshold}${c.unit === 'percent' ? '%' : ''}`
const fmtEnvs = (envs) => (envs || []).map(e => {
  const meta = ENV_OPTIONS.find(o => o.key === e)
  return meta?.label || e
}).join(', ')

function relTime(iso) {
  if (!iso) return null
  const ms = Date.now() - new Date(iso).getTime()
  if (!isFinite(ms) || ms < 0) return null
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} hr ago`
  const d = Math.floor(h / 24)
  return `${d} day${d === 1 ? '' : 's'} ago`
}

function SevA() {
  const [rules,      setRules]      = useState([])
  const [loading,    setLoading]    = useState(true)
  const [loadErr,    setLoadErr]    = useState(null)
  const [modalOpen,  setModalOpen]  = useState(false)
  const [editing,    setEditing]    = useState(null)
  const [evaluating, setEvaluating] = useState(false)
  const [evalResult, setEvalResult] = useState(null)

  async function loadRules() {
    try {
      const r = await fetch(`${API}/api/sev-a/rules`)
      const j = await r.json()
      if (!r.ok) throw new Error(j.detail || `HTTP ${r.status}`)
      setRules(j.rules || [])
      setLoadErr(null)
    } catch (e) {
      setLoadErr(e.message || 'Failed to load rules')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadRules() }, [])

  async function handleSave(payload) {
    if (editing) {
      await fetch(`${API}/api/sev-a/rules/${encodeURIComponent(editing.id)}`, { method: 'DELETE' })
    }
    const r = await fetch(`${API}/api/sev-a/rules`, {
      method:  'POST',
      headers: { 'content-type': 'application/json' },
      body:    JSON.stringify(payload),
    })
    if (!r.ok) {
      const j = await r.json().catch(() => ({}))
      throw new Error(j.detail || `HTTP ${r.status}`)
    }
    setModalOpen(false)
    setEditing(null)
    loadRules()
  }

  async function handleDelete(id) {
    if (!confirm('Delete this Sev A rule?')) return
    await fetch(`${API}/api/sev-a/rules/${encodeURIComponent(id)}`, { method: 'DELETE' })
    loadRules()
  }

  async function evaluateNow() {
    setEvaluating(true)
    setEvalResult(null)
    try {
      const r = await fetch(`${API}/api/sev-a/evaluate-now`, { method: 'POST' })
      const j = await r.json()
      if (!r.ok) throw new Error(j.detail || `HTTP ${r.status}`)
      setEvalResult(j)
      loadRules()
    } catch (e) {
      setEvalResult({ error: e.message || 'Evaluation failed' })
    } finally {
      setEvaluating(false)
    }
  }

  function openCreate() { setEditing(null); setModalOpen(true) }
  function openEdit(r)  { setEditing(r);    setModalOpen(true) }

  return (
    <div style={{ background: '#f1f5f9', minHeight: '100vh', fontFamily: "'Inter', -apple-system, system-ui, sans-serif" }}>

      {/* ── Sticky skyline header ── */}
      <div style={{ background: '#fff', borderBottom: '1px solid #e2e8f0', position: 'sticky', top: 0, zIndex: 20, overflow: 'hidden' }}>
        <div aria-hidden style={{ position: 'absolute', top: 0, bottom: -50, left: 0, right: '50%', backgroundImage: 'url(/skyline.png)', backgroundRepeat: 'no-repeat', backgroundPosition: 'right bottom', backgroundSize: 'auto 200%', opacity: 0.45, pointerEvents: 'none', zIndex: 0 }} />
        <div aria-hidden style={{ position: 'absolute', top: 0, bottom: -50, left: '50%', right: 0, backgroundImage: 'url(/skyline.png)', backgroundRepeat: 'no-repeat', backgroundPosition: 'left bottom', backgroundSize: 'auto 200%', opacity: 0.45, pointerEvents: 'none', zIndex: 0, transform: 'scaleX(-1)' }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 24px', position: 'relative', zIndex: 1 }}>
          <div style={{ width: 38, height: 38, borderRadius: 10, background: 'linear-gradient(135deg,#6366f1,#4f46e5)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', flexShrink: 0 }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
            </svg>
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 800, fontSize: 16, color: '#0f172a', letterSpacing: '-0.3px' }}>Sev A</div>
            <div style={{ fontSize: 11.5, color: '#94a3b8', marginTop: 1 }}>Build Sev A rules that trigger when conditions are met</div>
          </div>
        </div>
      </div>

      {/* ── Content ── */}
      <div style={{ padding: '24px 36px', display: 'flex', flexDirection: 'column', gap: 16 }}>

      <section>
        <h2 className={pageStyles.sectionTitle}>Available</h2>
        <div className={pageStyles.catalogue}>
          <div className={pageStyles.catalogueCard}>
            <div className={pageStyles.catalogueLogo} style={{ background: ALERT_TYPE.colorBg, color: ALERT_TYPE.color }}>
              {ALERT_TYPE.logo}
            </div>
            <div className={pageStyles.catalogueInfo}>
              <span className={pageStyles.catalogueName}>{ALERT_TYPE.name}</span>
              <span className={pageStyles.catalogueDesc}>{ALERT_TYPE.desc}</span>
            </div>
            <button className={pageStyles.addBtn} onClick={openCreate}>+ Add</button>
          </div>
        </div>
      </section>

      <section>
        <div className={pageStyles.sectionHeader}>
          <h2 className={pageStyles.sectionTitle}>
            Configured
            {rules.length > 0 && <span className={pageStyles.badge}>{rules.length}</span>}
          </h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {evalResult && !evalResult.error && (
              <span style={{ fontSize: 12, color: '#6b7280' }}>
                Last run: {evalResult.rules_evaluated} rule{evalResult.rules_evaluated === 1 ? '' : 's'} ·
                {' '}{evalResult.emails_sent} email{evalResult.emails_sent === 1 ? '' : 's'} sent
                {!evalResult.smtp_configured && <span style={{ color: '#dc2626' }}> · SMTP not configured</span>}
              </span>
            )}
            {evalResult?.error && (
              <span style={{ fontSize: 12, color: '#dc2626' }}>{evalResult.error}</span>
            )}
            <button
              type="button"
              onClick={evaluateNow}
              disabled={evaluating || rules.length === 0}
              style={{
                background: (evaluating || rules.length === 0) ? '#e5e7eb' : '#fff',
                color: (evaluating || rules.length === 0) ? '#9ca3af' : '#374151',
                border: '1.5px solid #e5e7eb',
                borderRadius: 9,
                padding: '7px 14px', fontSize: 12.5, fontWeight: 600,
                cursor: (evaluating || rules.length === 0) ? 'not-allowed' : 'pointer',
              }}
            >
              {evaluating ? 'Evaluating…' : 'Evaluate now'}
            </button>
          </div>
        </div>

        {loading && (
          <div className={pageStyles.loadingWrap}>
            <div className={pageStyles.spinner} />
            <span>Loading rules...</span>
          </div>
        )}

        {loadErr && (
          <div className={pageStyles.errorBox}>
            Failed to load rules: {loadErr}
          </div>
        )}

        {!loading && !loadErr && rules.length === 0 && (
          <div className={pageStyles.empty}>
            <span className={pageStyles.emptyIcon}>🚨</span>
            <p>No Sev A rules yet.</p>
            <p className={pageStyles.emptyHint}>
              Click <strong>+ Add</strong> above to create your first rule.
            </p>
          </div>
        )}

        {!loading && rules.length > 0 && (
          <div className={pageStyles.cardGrid}>
            {rules.map(r => (
              <RuleCard
                key={r.id}
                rule={r}
                onEdit={() => openEdit(r)}
                onDelete={() => handleDelete(r.id)}
              />
            ))}
          </div>
        )}
      </section>

      </div>{/* end content */}

      {modalOpen && (
        <SevARuleModal
          initial={editing}
          onSave={handleSave}
          onClose={() => { setModalOpen(false); setEditing(null) }}
        />
      )}
    </div>
  )
}

function RuleCard({ rule, onEdit, onDelete }) {
  const envs = rule.envs && rule.envs.length ? rule.envs : (rule.env ? [rule.env] : [])
  return (
    <div className={cardStyles.card}>
      <div className={cardStyles.cardHeader}>
        <div className={cardStyles.logoWrap} style={{ background: ALERT_TYPE.colorBg, color: ALERT_TYPE.color }}>
          {ALERT_TYPE.logo}
        </div>
        <div className={cardStyles.info}>
          <span className={cardStyles.name}>{rule.tenant}</span>
          <span className={cardStyles.env} style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
            {envs.map(e => {
              const meta = ENV_OPTIONS.find(o => o.key === e)
              return (
                <span key={e} style={{
                  display: 'inline-flex', alignItems: 'center', gap: 5,
                  padding: '2px 8px', borderRadius: 999,
                  background: '#f3f4f6', color: '#374151',
                  fontSize: 11, fontWeight: 500,
                }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: meta?.dot || '#6b7280' }} />
                  {meta?.label || e}
                </span>
              )
            })}
          </span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
          <span className={cardStyles.activePill}>Active</span>
          {rule.teams_enabled && (
            <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px',
              borderRadius: 999, background: '#eff6ff', color: '#2563eb',
              border: '1px solid #bfdbfe', whiteSpace: 'nowrap' }}>
              Teams
            </span>
          )}
        </div>
      </div>

      <div className={cardStyles.fields}>
        {(rule.conditions || []).map(c => (
          <div key={c.key} className={cardStyles.field}>
            <span className={cardStyles.fieldLabel}>{c.label}</span>
            <span className={cardStyles.fieldValue}>
              {c.key === 'workflow_failed' ? 'any failure' : `> ${c.threshold}${c.unit === 'percent' ? '%' : ''}`}
            </span>
          </div>
        ))}
        <div className={cardStyles.field}>
          <span className={cardStyles.fieldLabel}>Window</span>
          <span className={cardStyles.fieldValue}>{rule.window_minutes} min</span>
        </div>
      </div>

      {(rule.workflow_names || []).length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, fontSize: 11, color: '#6b7280', alignItems: 'center' }}>
          <span style={{ fontWeight: 600, marginRight: 4 }}>Workflows:</span>
          {rule.workflow_names.map(n => (
            <span key={n} style={{
              padding: '2px 8px', borderRadius: 999,
              background: '#fef2f2', border: '1px solid #fca5a5', color: '#991b1b',
              fontWeight: 500,
            }}>{n}</span>
          ))}
        </div>
      )}

      {(rule.extra_emails || []).length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, fontSize: 11, color: '#6b7280', alignItems: 'center' }}>
          <span style={{ fontWeight: 600, marginRight: 4 }}>CC:</span>
          {rule.extra_emails.map(e => (
            <span key={e} style={{
              padding: '2px 8px', borderRadius: 999,
              background: '#fff7ed', border: '1px solid #fed7aa', color: '#9a3412',
              fontWeight: 500,
            }}>{e}</span>
          ))}
        </div>
      )}

      <div style={{ fontSize: 11, color: '#9ca3af', marginTop: -4 }}>
        {rule.last_evaluated_at
          ? <>Last evaluated {relTime(rule.last_evaluated_at)}</>
          : <>Not evaluated yet</>}
      </div>

      <div className={cardStyles.actions}>
        <button className={cardStyles.editBtn} onClick={onEdit}>Edit</button>
        <button className={cardStyles.deleteBtn} onClick={onDelete}>Delete</button>
      </div>
    </div>
  )
}

function SevARuleModal({ initial, onSave, onClose }) {
  const [tenants,       setTenants]       = useState([])
  const [tenantsErr,    setTenantsErr]    = useState(null)
  const [tenant,        setTenant]        = useState(initial?.tenant || '')
  const [envs,          setEnvs]          = useState(() => {
    if (initial?.envs && initial.envs.length) return initial.envs
    if (initial?.env) return [initial.env]
    return []
  })
  const [windowMin,       setWindowMin]       = useState(initial?.window_minutes ?? 60)
  const [selectedConds,   setSelectedConds]   = useState(
    initial?.conditions?.map(c => ({ key: c.key, threshold: c.threshold })) || []
  )
  const [selectedWfs,     setSelectedWfs]     = useState(initial?.workflow_names || [])
  const [availableWfs,    setAvailableWfs]     = useState([])
  const [wfsLoading,      setWfsLoading]       = useState(false)
  const [wfSearch,        setWfSearch]         = useState('')
  const [useExtraEmails,  setUseExtraEmails]   = useState(() => (initial?.extra_emails || []).length > 0)
  const [extraEmailsRaw,  setExtraEmailsRaw]   = useState((initial?.extra_emails || []).join(', '))
  const [teamsEnabled,    setTeamsEnabled]      = useState(initial?.teams_enabled ?? false)
  const [teamsWebhookId,  setTeamsWebhookId]    = useState(initial?.teams_webhook_id ?? '')
  const [savedWebhooks,   setSavedWebhooks]     = useState([])
  const [saving,  setSaving]  = useState(false)
  const [error,   setError]   = useState(null)

  useEffect(() => {
    fetch(`${API}/api/settings/teams-webhooks`)
      .then(r => r.json())
      .then(d => setSavedWebhooks(d.webhooks || []))
      .catch(() => {})
  }, [])

  useEffect(() => {
    let cancelled = false
    fetch(`${API}/api/insights/tenants`)
      .then(r => r.ok ? r.json() : r.json().then(j => Promise.reject(j.detail || `HTTP ${r.status}`)))
      .then(json => {
        if (cancelled) return
        const list = Array.isArray(json) ? json : (json.tenants || json.items || [])
        setTenants(list)
      })
      .catch(e => { if (!cancelled) setTenantsErr(typeof e === 'string' ? e : 'Failed to load tenants') })
    return () => { cancelled = true }
  }, [])

  // Fetch workflow names whenever tenant changes
  useEffect(() => {
    if (!tenant) { setAvailableWfs([]); return }
    let cancelled = false
    setWfsLoading(true)
    fetch(`${API}/api/sev-a/tenants/${encodeURIComponent(tenant)}/workflows`)
      .then(r => r.ok ? r.json() : { workflows: [] })
      .then(json => { if (!cancelled) setAvailableWfs(json.workflows || []) })
      .catch(() => { if (!cancelled) setAvailableWfs([]) })
      .finally(() => { if (!cancelled) setWfsLoading(false) })
    return () => { cancelled = true }
  }, [tenant])

  const toggleCondition = (key) => {
    setSelectedConds(prev => {
      const existing = prev.find(c => c.key === key)
      if (existing) return prev.filter(c => c.key !== key)
      const meta = CONDITIONS.find(c => c.key === key)
      return [...prev, { key, threshold: key === 'workflow_failed' ? 0 : (meta?.unit === 'percent' ? 5 : 10) }]
    })
  }
  const setCondThreshold = (key, value) =>
    setSelectedConds(prev => prev.map(c => c.key === key ? { ...c, threshold: value } : c))

  const allCondsValid = selectedConds.length > 0
    && selectedConds.every(c => c.threshold !== '' && Number(c.threshold) >= 0)
  const teamsOk = !teamsEnabled || !!teamsWebhookId
  const canSave = tenant && envs.length > 0 && allCondsValid && Number(windowMin) > 0 && teamsOk && !saving

  const addEnv    = (key) => { if (!key || envs.includes(key)) return; setEnvs(prev => [...prev, key]) }
  const removeEnv = (key) => setEnvs(prev => prev.filter(e => e !== key))
  const toggleWf  = (name) => setSelectedWfs(prev =>
    prev.includes(name) ? prev.filter(n => n !== name) : [...prev, name]
  )
  const removeWf  = (name) => setSelectedWfs(prev => prev.filter(n => n !== name))

  const filteredWfs = availableWfs.filter(w =>
    !selectedWfs.includes(w.name) &&
    w.name.toLowerCase().includes(wfSearch.toLowerCase())
  )

  const parsedExtraEmails = useExtraEmails
    ? extraEmailsRaw.split(',').map(s => s.trim()).filter(Boolean)
    : []

  async function handleSubmit(e) {
    e.preventDefault()
    if (!canSave) return
    const payload = {
      tenant, envs,
      conditions: selectedConds.map(c => {
        const meta = CONDITIONS.find(m => m.key === c.key)
        const threshold = c.key === 'workflow_failed' ? 0 : Number(c.threshold)
        return { key: c.key, label: meta?.label || c.key, unit: meta?.unit || 'count', threshold }
      }),
      window_minutes:  Number(windowMin),
      workflow_names:  selectedWfs,
      extra_emails:    parsedExtraEmails,
      teams_enabled:     teamsEnabled,
      teams_webhook_id:  teamsEnabled ? teamsWebhookId : null,
    }
    setSaving(true)
    setError(null)
    try {
      await onSave(payload)
    } catch (err) {
      setError(err.message || 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className={modalStyles.overlay} onClick={e => e.target === e.currentTarget && onClose()}>
      <div className={modalStyles.modal} style={{ maxWidth: 540, maxHeight: 'calc(100vh - 48px)', display: 'flex', flexDirection: 'column' }}>
        <div className={modalStyles.modalHeader}>
          <div className={modalStyles.modalIcon} style={{ background: ALERT_TYPE.colorBg, color: ALERT_TYPE.color }}>
            {ALERT_TYPE.logo}
          </div>
          <div>
            <h2 className={modalStyles.modalTitle}>{initial ? 'Edit' : 'Add'} Sev A Rule</h2>
            <p className={modalStyles.modalSub}>Choose a tenant, environment, and one or more conditions</p>
          </div>
          <button className={modalStyles.closeBtn} onClick={onClose}>✕</button>
        </div>

        <form className={modalStyles.form} onSubmit={handleSubmit} style={{ overflowY: 'auto', flex: 1 }}>
          <div className={modalStyles.fieldWrap}>
            <label className={modalStyles.label}>Tenant</label>
            <select
              className={modalStyles.input}
              value={tenant}
              onChange={e => setTenant(e.target.value)}
            >
              <option value="">{tenants.length ? 'Select tenant' : 'Loading…'}</option>
              {tenants.map(name => <option key={name} value={name}>{name}</option>)}
            </select>
            {tenantsErr && <span className={modalStyles.error}>{tenantsErr}</span>}
          </div>

          <div className={modalStyles.fieldWrap}>
            <label className={modalStyles.label}>
              Environments <span style={{ color: '#9ca3af', fontWeight: 500 }}>· add one or more</span>
            </label>
            {envs.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                {envs.map(key => {
                  const meta = ENV_OPTIONS.find(o => o.key === key)
                  return (
                    <span key={key} style={{
                      display: 'inline-flex', alignItems: 'center', gap: 6,
                      padding: '4px 4px 4px 10px', borderRadius: 999,
                      background: '#fff7ed', border: '1px solid #fed7aa',
                      fontSize: 12, fontWeight: 500, color: '#9a3412',
                    }}>
                      <span style={{ width: 6, height: 6, borderRadius: '50%', background: meta?.dot || '#6b7280' }} />
                      {meta?.label || key}
                      <button
                        type="button"
                        onClick={() => removeEnv(key)}
                        aria-label={`Remove ${meta?.label || key}`}
                        style={{
                          width: 18, height: 18, borderRadius: '50%',
                          border: 'none', background: 'transparent', color: '#9a3412',
                          fontSize: 13, lineHeight: 1, cursor: 'pointer',
                          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        }}
                      >×</button>
                    </span>
                  )
                })}
              </div>
            )}
            <select
              className={modalStyles.input}
              value=""
              onChange={e => { addEnv(e.target.value); e.target.value = '' }}
            >
              <option value="">{envs.length ? 'Add another environment' : 'Select environment'}</option>
              {ENV_OPTIONS.filter(o => !envs.includes(o.key)).map(o =>
                <option key={o.key} value={o.key}>{o.label}</option>
              )}
            </select>
          </div>

          {/* ── Workflow selector ───────────────────────────────────── */}
          <div className={modalStyles.fieldWrap}>
            <label className={modalStyles.label}>
              Workflows <span style={{ color: '#9ca3af', fontWeight: 500 }}>· optional — leave empty to monitor all</span>
            </label>

            {/* Selected workflow chips */}
            {selectedWfs.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                {selectedWfs.map(name => (
                  <span key={name} style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    padding: '4px 4px 4px 10px', borderRadius: 999,
                    background: '#fef2f2', border: '1px solid #fca5a5',
                    fontSize: 12, fontWeight: 500, color: '#991b1b',
                  }}>
                    {name}
                    <button
                      type="button"
                      onClick={() => removeWf(name)}
                      style={{
                        width: 18, height: 18, borderRadius: '50%',
                        border: 'none', background: 'transparent', color: '#991b1b',
                        fontSize: 13, lineHeight: 1, cursor: 'pointer',
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      }}
                    >×</button>
                  </span>
                ))}
              </div>
            )}

            {/* Search + dropdown list */}
            {!tenant ? (
              <div style={{ fontSize: 12, color: '#9ca3af', padding: '8px 0' }}>
                Select a tenant first to load available workflows.
              </div>
            ) : wfsLoading ? (
              <div style={{ fontSize: 12, color: '#9ca3af', padding: '8px 0' }}>Loading workflows…</div>
            ) : (
              <>
                <input
                  type="text"
                  placeholder="Search workflows…"
                  value={wfSearch}
                  onChange={e => setWfSearch(e.target.value)}
                  style={{
                    width: '100%', padding: '8px 10px', fontSize: 13,
                    border: '1.5px solid #e5e7eb', borderRadius: 8,
                    outline: 'none', color: '#111827', boxSizing: 'border-box', marginBottom: 6,
                  }}
                />
                {filteredWfs.length === 0 && availableWfs.length === 0 ? (
                  <div style={{ fontSize: 12, color: '#9ca3af' }}>No failed workflows found for this tenant.</div>
                ) : filteredWfs.length === 0 ? (
                  <div style={{ fontSize: 12, color: '#9ca3af' }}>All matching workflows already selected.</div>
                ) : (
                  <div style={{
                    maxHeight: 180, overflowY: 'auto',
                    border: '1.5px solid #e5e7eb', borderRadius: 8,
                    background: '#fff',
                  }}>
                    {filteredWfs.map(w => (
                      <button
                        key={w.name}
                        type="button"
                        onClick={() => toggleWf(w.name)}
                        style={{
                          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                          width: '100%', padding: '8px 12px',
                          background: 'none', border: 'none', cursor: 'pointer',
                          borderBottom: '1px solid #f3f4f6', textAlign: 'left',
                        }}
                        onMouseEnter={e => e.currentTarget.style.background = '#fef2f2'}
                        onMouseLeave={e => e.currentTarget.style.background = 'none'}
                      >
                        <span style={{ fontSize: 13, color: '#111827', fontWeight: 500 }}>{w.name}</span>
                        {w.app && (
                          <span style={{
                            fontSize: 10, color: '#9ca3af', fontWeight: 500,
                            background: '#f3f4f6', borderRadius: 4, padding: '1px 6px', marginLeft: 8, flexShrink: 0,
                          }}>{w.app}</span>
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>

          <div className={modalStyles.fieldWrap}>
            <label className={modalStyles.label}>Window (minutes)</label>
            <input
              className={modalStyles.input}
              type="number" min="1" step="1"
              value={windowMin}
              onChange={e => setWindowMin(e.target.value)}
              style={{ maxWidth: 200 }}
            />
          </div>

          <div className={modalStyles.fieldWrap}>
            <label className={modalStyles.label}>
              Conditions <span style={{ color: '#9ca3af', fontWeight: 500 }}>· pick one or more (AND)</span>
            </label>
            <div style={{ display: 'grid', gap: 8 }}>
              {CONDITIONS.map(c => {
                const sel = selectedConds.find(s => s.key === c.key)
                const checked = !!sel
                return (
                  <div key={c.key} style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '10px 12px',
                    border: `1.5px solid ${checked ? '#f97316' : '#e5e7eb'}`,
                    background: checked ? '#fff7ed' : '#fff',
                    borderRadius: 10,
                    transition: 'background 0.12s, border-color 0.12s',
                  }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', flex: 1, minWidth: 0 }}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleCondition(c.key)}
                        style={{ width: 16, height: 16, cursor: 'pointer', accentColor: '#f97316' }}
                      />
                      <span style={{ fontSize: 13, fontWeight: 600, color: '#111827' }}>{c.label}</span>
                      <span style={{ fontSize: 11, color: '#9ca3af' }}>({c.unit})</span>
                    </label>
                    {checked && (
                      c.key === 'workflow_failed' ? (
                        <span style={{
                          fontSize: 11, fontWeight: 600, color: '#dc2626',
                          background: '#fef2f2', border: '1px solid #fecaca',
                          borderRadius: 6, padding: '3px 8px', flexShrink: 0,
                        }}>Any failure</span>
                      ) : (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                          <span style={{ fontSize: 12, color: '#6b7280' }}>&gt;</span>
                          <input
                            type="number" min="0" step={c.unit === 'percent' ? 0.1 : 1}
                            value={sel.threshold}
                            onChange={e => setCondThreshold(c.key, e.target.value)}
                            style={{
                              width: 80, padding: '6px 10px', fontSize: 13,
                              border: '1.5px solid #e5e7eb', borderRadius: 8,
                              outline: 'none', color: '#111827',
                            }}
                          />
                          <span style={{ fontSize: 12, color: '#9ca3af', width: 16 }}>
                            {c.unit === 'percent' ? '%' : ''}
                          </span>
                        </div>
                      )
                    )}
                  </div>
                )
              })}
            </div>
          </div>

          <div className={modalStyles.fieldWrap}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={useExtraEmails}
                onChange={() => setUseExtraEmails(v => !v)}
                style={{ width: 16, height: 16, cursor: 'pointer', accentColor: '#f97316' }}
              />
              <span style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>
                Send to additional emails
              </span>
              <span style={{ fontSize: 11, color: '#9ca3af' }}>(besides the configured SMTP recipient)</span>
            </label>
            {useExtraEmails && (
              <input
                className={modalStyles.input}
                type="text"
                placeholder="email1@example.com, email2@example.com"
                value={extraEmailsRaw}
                onChange={e => setExtraEmailsRaw(e.target.value)}
                style={{ marginTop: 8 }}
              />
            )}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
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
                  className={modalStyles.input}
                  value={teamsWebhookId}
                  onChange={e => setTeamsWebhookId(e.target.value)}
                  required={teamsEnabled}
                  style={{ marginTop: 4 }}
                >
                  <option value="">— Select a webhook —</option>
                  {savedWebhooks.map(w => (
                    <option key={w._id} value={w._id}>{w.name}</option>
                  ))}
                </select>
              )
            )}
          </div>

          {error && <span className={modalStyles.error}>{error}</span>}

          <div className={modalStyles.footer}>
            <button type="button" className={modalStyles.cancelBtn} onClick={onClose}>Cancel</button>
            <button type="submit" className={modalStyles.saveBtn} disabled={!canSave}>
              {saving ? 'Saving…' : initial ? 'Save Changes' : 'Add Rule'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

export default SevA
