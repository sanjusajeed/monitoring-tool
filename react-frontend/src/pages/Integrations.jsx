import { useState, useEffect } from 'react'
import IntegrationCard from '../components/IntegrationCard'
import JiffyModal from '../components/JiffyModal'
import styles from './Integrations.module.css'

const BASE_URL = `${import.meta.env.VITE_API_BASE_URL || ''}/api/integrations/jiffy`

// Registry of available integration types — add more here later
const INTEGRATION_TYPES = [
  {
    id: 'jiffy',
    name: 'Workflow Platform',
    description: 'Connect your workflow automation environment to enable automated workflows and monitoring.',
    logo: '⚡',
    color: '#f97316',
    colorBg: '#fff7ed',
  },
]

function Integrations() {
  const [records, setRecords] = useState([])
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState(null)   // record being edited
  const [error, setError] = useState(null)

  async function loadRecords() {
    try {
      const res = await fetch(BASE_URL)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setRecords(await res.json())
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadRecords() }, [])

  async function handleSave(payload) {
    const url    = editing ? `${BASE_URL}/${editing.id}` : BASE_URL
    const method = editing ? 'PUT' : 'POST'
    await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    setModalOpen(false)
    setEditing(null)
    loadRecords()
  }

  async function handleDelete(id) {
    if (!confirm('Delete this integration?')) return
    await fetch(`${BASE_URL}/${id}`, { method: 'DELETE' })
    loadRecords()
  }

  function openEdit(record) {
    setEditing(record)
    setModalOpen(true)
  }

  function openCreate() {
    setEditing(null)
    setModalOpen(true)
  }

  const jiffyType = INTEGRATION_TYPES.find(t => t.id === 'jiffy')

  return (
    <div style={{ background: '#f1f5f9', minHeight: '100vh', fontFamily: "'Inter', -apple-system, system-ui, sans-serif" }}>

      {/* ── Sticky skyline header ── */}
      <div style={{ background: '#fff', borderBottom: '1px solid #e2e8f0', position: 'sticky', top: 0, zIndex: 20, overflow: 'hidden' }}>
        <div aria-hidden style={{ position: 'absolute', top: 0, bottom: -50, left: 0, right: '50%', backgroundImage: 'url(/skyline.png)', backgroundRepeat: 'no-repeat', backgroundPosition: 'right bottom', backgroundSize: 'auto 200%', opacity: 0.45, pointerEvents: 'none', zIndex: 0 }} />
        <div aria-hidden style={{ position: 'absolute', top: 0, bottom: -50, left: '50%', right: 0, backgroundImage: 'url(/skyline.png)', backgroundRepeat: 'no-repeat', backgroundPosition: 'left bottom', backgroundSize: 'auto 200%', opacity: 0.45, pointerEvents: 'none', zIndex: 0, transform: 'scaleX(-1)' }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 24px', position: 'relative', zIndex: 1 }}>
          <div style={{ width: 38, height: 38, borderRadius: 10, background: 'linear-gradient(135deg,#6366f1,#4f46e5)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', flexShrink: 0 }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="7" width="9" height="14" rx="1"/><rect x="13" y="3" width="9" height="18" rx="1"/>
            </svg>
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 800, fontSize: 16, color: '#0f172a', letterSpacing: '-0.3px' }}>Integrations</div>
            <div style={{ fontSize: 11.5, color: '#94a3b8', marginTop: 1 }}>Connect third-party services to your monitoring app</div>
          </div>
        </div>
      </div>

      {/* ── Content ── */}
      <div style={{ padding: '24px 36px', display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* Available integrations catalogue */}
      <section>
        <h2 className={styles.sectionTitle}>Available</h2>
        <div className={styles.catalogue}>
          {INTEGRATION_TYPES.map(type => (
            <div key={type.id} className={styles.catalogueCard}>
              <div className={styles.catalogueLogo} style={{ background: type.colorBg, color: type.color }}>
                {type.logo}
              </div>
              <div className={styles.catalogueInfo}>
                <span className={styles.catalogueName}>{type.name}</span>
                <span className={styles.catalogueDesc}>{type.description}</span>
              </div>
              <button className={styles.addBtn} onClick={openCreate}>
                + Add
              </button>
            </div>
          ))}
        </div>
      </section>

      {/* Connected integrations */}
      <section>
        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>
            Connected
            {records.length > 0 && <span className={styles.badge}>{records.length}</span>}
          </h2>
        </div>

        {loading && (
          <div className={styles.loadingWrap}>
            <div className={styles.spinner} />
            <span>Loading integrations...</span>
          </div>
        )}

        {error && (
          <div className={styles.errorBox}>
            Failed to load integrations: {error}
          </div>
        )}

        {!loading && !error && records.length === 0 && (
          <div className={styles.empty}>
            <span className={styles.emptyIcon}>🔌</span>
            <p>No integrations connected yet.</p>
            <p className={styles.emptyHint}>Click <strong>+ Add</strong> above to connect your first environment.</p>
          </div>
        )}

        {!loading && records.length > 0 && (
          <div className={styles.cardGrid}>
            {records.map(record => (
              <IntegrationCard
                key={record.id}
                record={record}
                type={jiffyType}
                onEdit={() => openEdit(record)}
                onDelete={() => handleDelete(record.id)}
              />
            ))}
          </div>
        )}
      </section>

      </div>{/* end content */}

      {modalOpen && (
        <JiffyModal
          initial={editing}
          onSave={handleSave}
          onClose={() => { setModalOpen(false); setEditing(null) }}
        />
      )}
    </div>
  )
}

export default Integrations
