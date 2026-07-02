import { useState, useEffect, useRef } from 'react'
import styles from './Sidebar.module.css'

// ─── Icons ────────────────────────────────────────────────────────────────────

function DashboardIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1"/>
      <rect x="14" y="3" width="7" height="7" rx="1"/>
      <rect x="3" y="14" width="7" height="7" rx="1"/>
      <rect x="14" y="14" width="7" height="7" rx="1"/>
    </svg>
  )
}

function TenantIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="7" width="9" height="14" rx="1"/>
      <rect x="13" y="3" width="9" height="18" rx="1"/>
    </svg>
  )
}

function IntegrationsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="18" cy="5" r="3"/>
      <circle cx="6" cy="12" r="3"/>
      <circle cx="18" cy="19" r="3"/>
      <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/>
      <line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
    </svg>
  )
}

function AlertsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/>
      <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
    </svg>
  )
}

function SevAIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
      <line x1="12" y1="9" x2="12" y2="13"/>
      <line x1="12" y1="17" x2="12.01" y2="17"/>
    </svg>
  )
}

function ClockIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/>
      <polyline points="12 6 12 12 16 14"/>
    </svg>
  )
}

function SettingsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3"/>
      <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09a1.65 1.65 0 00-1-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09a1.65 1.65 0 001.51-1 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>
    </svg>
  )
}

function InfoIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/>
      <line x1="12" y1="16" x2="12" y2="12"/>
      <line x1="12" y1="8" x2="12.01" y2="8"/>
    </svg>
  )
}

// ─── Nav items ────────────────────────────────────────────────────────────────

const LEFT_ITEMS = [
  { id: 'dashboard',    icon: <DashboardIcon />,     label: 'Dashboard'    },
  { id: 'tenant-apps',  icon: <TenantIcon />,        label: 'Tenant & Apps'},
  { id: 'integrations', icon: <IntegrationsIcon />,  label: 'Integrations' },
  { id: 'alerts',       icon: <AlertsIcon />,        label: 'Alerts'       },
  { id: 'sev-a',        icon: <SevAIcon />,          label: 'Sev A'        },
  { id: 'crons',        icon: <ClockIcon />,         label: 'Crons'        },
]

const RIGHT_ITEMS = [
  { id: 'settings',     icon: <SettingsIcon />,      label: 'Settings'     },
]

// ─── Sliding pill nav ─────────────────────────────────────────────────────────

function PillNav({ items, activePage, onNavigate }) {
  const containerRef = useRef(null)
  const btnRefs = useRef({})
  const [pill, setPill] = useState({ left: 0, width: 0 })
  const [animated, setAnimated] = useState(false)

  useEffect(() => {
    const btn = btnRefs.current[activePage]
    const container = containerRef.current
    if (!btn || !container) return
    const cRect = container.getBoundingClientRect()
    const bRect = btn.getBoundingClientRect()
    setPill({ left: bRect.left - cRect.left, width: bRect.width })
  }, [activePage])

  // Enable CSS transition after initial placement so the first render doesn't animate
  useEffect(() => {
    const raf = requestAnimationFrame(() => setAnimated(true))
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <div ref={containerRef} className={styles.pillGroup}>
      <div
        className={styles.pillIndicator}
        style={{
          left: pill.left,
          width: pill.width,
          transition: animated
            ? 'left 0.22s cubic-bezier(0.4,0,0.2,1), width 0.22s cubic-bezier(0.4,0,0.2,1)'
            : 'none',
        }}
      />
      {items.map(item => (
        <button
          key={item.id}
          ref={el => { btnRefs.current[item.id] = el }}
          className={`${styles.navBtn} ${activePage === item.id ? styles.active : ''}`}
          onClick={() => onNavigate(item.id)}
        >
          <span className={styles.navLabel}>{item.label}</span>
        </button>
      ))}
    </div>
  )
}

// ─── Top navbar ───────────────────────────────────────────────────────────────

function Sidebar({ activePage, onNavigate, onOpenGuide }) {
  const renderItem = (item) => (
    <button
      key={item.id}
      className={`${styles.navBtn} ${activePage === item.id ? styles.active : ''}`}
      onClick={() => onNavigate(item.id)}
    >
      <span className={styles.navLabel}>{item.label}</span>
    </button>
  )

  return (
    <header className={styles.navbar}>
      {/* Left: placeholder to keep grid balance */}
      <div className={styles.navLeft} />

      {/* Center: pill nav — truly centered in the header */}
      <div className={styles.navCenter}>
        <PillNav items={LEFT_ITEMS} activePage={activePage} onNavigate={onNavigate} />
      </div>

      {/* Right: settings + info */}
      <div className={styles.navRight}>
        {RIGHT_ITEMS.map(renderItem)}
        <button
          type="button"
          aria-label="Open user guide"
          title="User guide"
          onClick={() => onOpenGuide?.()}
          className={styles.infoBtn}
        >
          <InfoIcon />
        </button>
      </div>
    </header>
  )
}

export default Sidebar
