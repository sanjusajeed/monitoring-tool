import { useState, useEffect, useRef, useMemo } from 'react'
import styles from './TenantApps.module.css'
import { relTime, istDayKey, istMidnightUtc } from '../utils/dates'

const API         = import.meta.env.VITE_API_BASE_URL || ''
const INSIGHT_URL = `${API}/api/insights/summary`

// ─── DateRangeFilter ─────────────────────────────────────────────────────────

const PRESETS = [
  { label: 'Last 1 hour',  hours: 1 },
  { label: 'Today',        days: 0 },
  { label: 'Yesterday',    days: 1 },
  { label: 'Last 7 days',  days: 7 },
  { label: 'Last 30 days', days: 30 },
  { label: 'Last 6 months',days: 180 },
  { label: 'Last year',    days: 365 },
  { label: 'All time',     days: null },
]

function toYMD(d) { return d.toISOString().slice(0, 10) }
function fmtShort(d) { return d.toLocaleDateString('en-US', { day: 'numeric', month: 'short' }) }

function DateRangeFilter({ value, onChange }) {
  // value = { start: Date, end: Date, label: string }
  const [open, setOpen] = useState(false)
  const [selStart, setSelStart] = useState(value?.start || null)
  const [selEnd, setSelEnd]     = useState(value?.end || null)
  const [selLabel, setSelLabel] = useState(value?.label || 'Last 30 days')
  const [leftMonth, setLeftMonth] = useState(() => {
    const d = new Date(value?.start || Date.now())
    return new Date(d.getFullYear(), d.getMonth(), 1)
  })
  const ref = useRef(null)

  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  useEffect(() => {
    setSelStart(value?.start || null)
    setSelEnd(value?.end || null)
    setSelLabel(value?.label || 'Last 30 days')
    setLeftMonth(new Date((value?.start || Date.now()).getFullYear(), (value?.start || Date.now()).getMonth(), 1))
  }, [value?.start?.getTime(), value?.end?.getTime(), value?.label])

  const rightMonth = new Date(leftMonth.getFullYear(), leftMonth.getMonth() + 1, 1)

  const applyPreset = (p) => {
    const now = new Date()
    let s, e
    if (p.hours != null) {
      // Rolling-hour windows ("Last 1 hour" etc.) — not day-aligned
      s = new Date(now.getTime() - p.hours * 3600 * 1000); e = now
    } else if (p.days === 0) {
      // "Today" = since 12 AM IST today
      s = istMidnightUtc(now); e = now
    } else if (p.days === 1) {
      // "Yesterday" = the IST day before today, [00:00 IST, 23:59:59 IST]
      const todayIstStart = istMidnightUtc(now)
      e = new Date(todayIstStart.getTime() - 1)
      s = new Date(todayIstStart.getTime() - 86400000)
    } else if (p.days === null) {
      s = new Date(2020, 0, 1); e = now
    } else {
      s = new Date(now.getTime() - p.days * 86400000); e = now
    }
    setSelStart(s); setSelEnd(e); setSelLabel(p.label)
    setLeftMonth(new Date(s.getFullYear(), s.getMonth(), 1))
  }

  const handleDayClick = (d) => {
    if (!selStart || (selStart && selEnd)) { setSelStart(d); setSelEnd(null); setSelLabel('Custom') }
    else if (d < selStart) { setSelStart(d); setSelLabel('Custom') }
    else { setSelEnd(d); setSelLabel('Custom') }
  }

  const apply = () => {
    if (selStart && selEnd) {
      const s = new Date(selStart)
      const e = new Date(selEnd)
      if (selLabel === 'Custom') {
        s.setHours(0,0,0,0)
        e.setHours(23,59,59,999)
      }
      onChange({ start: s, end: e, label: selLabel })
      setOpen(false)
    }
  }

  const renderMonth = (base) => {
    const yr = base.getFullYear(), mo = base.getMonth()
    const firstDay = new Date(yr, mo, 1).getDay()
    const daysInMonth = new Date(yr, mo + 1, 0).getDate()
    const cells = []
    for (let i = 0; i < firstDay; i++) cells.push(null)
    for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(yr, mo, d))

    const moName = base.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
    return (
      <div style={{ width: 240 }}>
        <div style={{ textAlign: 'center', fontWeight: 700, fontSize: 13, color: '#1e293b', marginBottom: 8 }}>{moName}</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 0, textAlign: 'center' }}>
          {['Su','Mo','Tu','We','Th','Fr','Sa'].map(h => (
            <div key={h} style={{ fontSize: 10, fontWeight: 700, color: '#94a3b8', padding: '4px 0' }}>{h}</div>
          ))}
          {cells.map((day, i) => {
            if (!day) return <div key={`e${i}`} />
            const ds = toYMD(day)
            const isStart = selStart && toYMD(selStart) === ds
            const isEnd = selEnd && toYMD(selEnd) === ds
            const inRange = selStart && selEnd && day >= selStart && day <= selEnd
            const isToday = toYMD(new Date()) === ds
            const selected = isStart || isEnd
            return (
              <div key={ds}
                onClick={() => handleDayClick(day)}
                style={{
                  padding: '5px 0', fontSize: 12, cursor: 'pointer', borderRadius: selected ? '50%' : 0,
                  background: selected ? '#3b82f6' : inRange ? '#dbeafe' : 'transparent',
                  color: selected ? '#fff' : inRange ? '#1e40af' : isToday ? '#3b82f6' : '#334155',
                  fontWeight: selected || isToday ? 700 : 400,
                  transition: 'background 0.1s',
                }}>
                {day.getDate()}
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  const displayLabel = value?.label === 'Custom'
    ? `${fmtShort(value.start)} - ${fmtShort(value.end)}`
    : (value?.label || 'Last 30 days')

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-block' }}>
      <button onClick={() => setOpen(!open)}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 8, background: '#fff',
          border: '1.5px solid #e2e8f0', borderRadius: 8, padding: '7px 14px', fontSize: 12,
          fontWeight: 600, color: '#334155', cursor: 'pointer', whiteSpace: 'nowrap' }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6b7280" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
        </svg>
        {displayLabel}
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" strokeWidth="2.5"><polyline points="6 9 12 15 18 9"/></svg>
      </button>

      {open && (
        <div style={{ position: 'absolute', top: '100%', right: 0, marginTop: 6, background: '#fff',
          borderRadius: 12, boxShadow: '0 12px 40px rgba(0,0,0,0.15)', border: '1px solid #e5e7eb',
          zIndex: 1000, display: 'flex', overflow: 'hidden' }}>

          {/* Presets */}
          <div style={{ width: 140, padding: '12px 0', borderRight: '1px solid #f3f4f6' }}>
            {PRESETS.map(p => (
              <div key={p.label}
                onClick={() => applyPreset(p)}
                style={{ padding: '7px 16px', fontSize: 12, cursor: 'pointer', fontWeight: selLabel === p.label ? 700 : 400,
                  color: selLabel === p.label ? '#3b82f6' : '#475569',
                  borderLeft: selLabel === p.label ? '3px solid #3b82f6' : '3px solid transparent',
                  background: selLabel === p.label ? '#eff6ff' : 'transparent' }}>
                {p.label}
              </div>
            ))}
          </div>

          {/* Calendars + footer */}
          <div style={{ padding: '16px 20px' }}>
            <div style={{ display: 'flex', gap: 24, marginBottom: 16 }}>
              {/* Left month nav */}
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                  <button onClick={() => setLeftMonth(new Date(leftMonth.getFullYear(), leftMonth.getMonth() - 1, 1))}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, color: '#64748b', padding: '2px 6px' }}>&lt;</button>
                  <span />
                  <button onClick={() => setLeftMonth(new Date(leftMonth.getFullYear(), leftMonth.getMonth() + 1, 1))}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, color: '#64748b', padding: '2px 6px' }}>&gt;</button>
                </div>
                {renderMonth(leftMonth)}
              </div>
              <div>
                <div style={{ height: 28 }} />
                {renderMonth(rightMonth)}
              </div>
            </div>

            {/* Footer */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              paddingTop: 12, borderTop: '1px solid #f3f4f6' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#475569' }}>
                <span style={{ background: '#f1f5f9', padding: '4px 12px', borderRadius: 6, fontWeight: 600, fontFamily: 'monospace' }}>
                  {selStart ? fmtShort(selStart) : '—'}
                </span>
                <span style={{ color: '#94a3b8' }}>—</span>
                <span style={{ background: '#f1f5f9', padding: '4px 12px', borderRadius: 6, fontWeight: 600, fontFamily: 'monospace' }}>
                  {selEnd ? fmtShort(selEnd) : '—'}
                </span>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => setOpen(false)}
                  style={{ padding: '6px 16px', fontSize: 12, fontWeight: 600, background: '#fff',
                    border: '1.5px solid #e2e8f0', borderRadius: 6, cursor: 'pointer', color: '#475569' }}>Cancel</button>
                <button onClick={apply}
                  disabled={!selStart || !selEnd}
                  style={{ padding: '6px 16px', fontSize: 12, fontWeight: 700, background: selStart && selEnd ? '#3b82f6' : '#e2e8f0',
                    color: selStart && selEnd ? '#fff' : '#9ca3af', border: 'none', borderRadius: 6,
                    cursor: selStart && selEnd ? 'pointer' : 'default' }}>Apply</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(n) {
  if (n == null) return '—'
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'K'
  return String(n)
}

function healthColor(h) {
  if (h == null) return '#9ca3af'
  if (h >= 80)   return '#10b981'
  if (h >= 50)   return '#f59e0b'
  return '#ef4444'
}

function errColor(r) {
  if (r == null) return '#374151'
  if (r > 10) return '#ef4444'
  if (r > 3)  return '#f59e0b'
  return '#374151'
}

function statusMeta(s) {
  if (s === 'healthy')  return { label: 'Healthy',  dot: '#10b981', bg: '#ecfdf5', border: '#6ee7b7' }
  if (s === 'warning')  return { label: 'Warning',  dot: '#f59e0b', bg: '#fffbeb', border: '#fcd34d' }
  if (s === 'critical') return { label: 'Critical', dot: '#ef4444', bg: '#fef2f2', border: '#fca5a5' }
  return                       { label: 'No Data',  dot: '#9ca3af', bg: '#f9fafb', border: '#e5e7eb' }
}

function instanceColor(env) {
  const map = {
    prod:    { bg: '#ede9fe', color: '#6d28d9' },
    dev:     { bg: '#dbeafe', color: '#1d4ed8' },
    uat:     { bg: '#fef9c3', color: '#854d0e' },
    qa:      { bg: '#fce7f3', color: '#be185d' },
    demo:    { bg: '#d1fae5', color: '#065f46' },
    staging: { bg: '#ffedd5', color: '#c2410c' },
  }
  return map[(env || '').toLowerCase()] || { bg: '#f3f4f6', color: '#374151' }
}

function appAvatarColor(name) {
  const palette = ['#6366f1','#f97316','#10b981','#3b82f6','#a855f7','#ec4899','#14b8a6','#f59e0b']
  let h = 0
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) & 0xffffffff
  return palette[Math.abs(h) % palette.length]
}

function appInitials(name) {
  return name.split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase()
}

// ─── Health ring ──────────────────────────────────────────────────────────────

function HealthRing({ value, size = 64 }) {
  if (value == null) return null
  const r    = (size - 8) / 2
  const circ = 2 * Math.PI * r
  const fill = (value / 100) * circ
  const col  = healthColor(value)
  const lbl  = value >= 80 ? 'Healthy' : value >= 50 ? 'Fair' : 'Poor'
  const fs   = size <= 56 ? 11 : size <= 80 ? 13 : 15
  return (
    <div className={styles.ringWrap}>
      <svg width={size} height={size}>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="rgba(0,0,0,0.05)" strokeWidth={5} />
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={col} strokeWidth={5}
          strokeDasharray={`${fill} ${circ}`} strokeLinecap="round"
          transform={`rotate(-90 ${size/2} ${size/2})`}
          style={{ transition: 'stroke-dasharray 0.6s ease' }} />
        <text x="50%" y="48%" textAnchor="middle" dominantBaseline="central"
          fontSize={fs} fontWeight="800" fill={col} fontFamily="Inter, sans-serif">{value}%</text>
        <text x="50%" y="70%" textAnchor="middle" dominantBaseline="central"
          fontSize={Math.max(7, fs - 5)} fontWeight="600" fill="#94a3b8" fontFamily="Inter, sans-serif">{lbl}</text>
      </svg>
    </div>
  )
}

// ─── Mini bar chart ───────────────────────────────────────────────────────────

function MiniBarChart({ data, label, color = '#7c3aed' }) {
  if (!data.length) return null
  const max  = Math.max(...data.map(d => d.value), 0.01)
  const W    = 400, H = 60
  const slot = data.length === 1 ? W : W / data.length
  const barW = Math.max(6, Math.min(slot - 4, 28))

  // Latest value
  const latest = data[data.length - 1]
  const fmtVal = v => v >= 1000 ? (v / 1000).toFixed(1) + 'k' : v % 1 !== 0 ? v.toFixed(1) : String(Math.round(v))

  return (
    <div className={styles.chartWrap}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div className={styles.chartLabel}>{label}</div>
        <span style={{ fontSize: 13, fontWeight: 800, color }}>{fmtVal(latest.value)}</span>
      </div>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className={styles.chartSvg}>
        <defs>
          <linearGradient id={`mbg-${color.replace('#','')}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.85" />
            <stop offset="100%" stopColor={color} stopOpacity="0.45" />
          </linearGradient>
        </defs>
        {data.map((d, i) => {
          const bh = Math.max(3, (d.value / max) * (H - 4))
          const x  = data.length === 1 ? (W - barW) / 2 : i * slot + (slot - barW) / 2
          return <rect key={i} x={x} y={H - bh} width={barW} height={bh}
            fill={`url(#mbg-${color.replace('#','')})`} rx={3} />
        })}
      </svg>
      <div className={styles.chartXLabels}>
        {data.map((d, i) => <span key={i} className={styles.chartXLabel}>{d.label}</span>)}
      </div>
    </div>
  )
}

// ─── Smooth spline helper ─────────────────────────────────────────────────────

function catmullRom(pts) {
  if (!pts.length) return ''
  if (pts.length === 1) return `M ${pts[0][0]},${pts[0][1]}`
  let d = `M ${pts[0][0]},${pts[0][1]}`
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(i - 1, 0)]
    const p1 = pts[i]
    const p2 = pts[i + 1]
    const p3 = pts[Math.min(i + 2, pts.length - 1)]
    const cp1x = p1[0] + (p2[0] - p0[0]) / 6
    const cp1y = p1[1] + (p2[1] - p0[1]) / 6
    const cp2x = p2[0] - (p3[0] - p1[0]) / 6
    const cp2y = p2[1] - (p3[1] - p1[1]) / 6
    d += ` C ${cp1x.toFixed(1)},${cp1y.toFixed(1)} ${cp2x.toFixed(1)},${cp2y.toFixed(1)} ${p2[0]},${p2[1]}`
  }
  return d
}

// ─── Smooth line chart ────────────────────────────────────────────────────────

function SmoothLineChart({ data, lines, title, icon, iconBg }) {
  const [hoverIdx, setHoverIdx] = useState(null)

  const W = 400, H = 130
  const PAD = { top: 8, right: 12, bottom: 26, left: 38 }
  const plotW = W - PAD.left - PAD.right
  const plotH = H - PAD.top  - PAD.bottom

  const allVals = lines.flatMap(l => data.map(d => l.fn ? l.fn(d) : (d[l.key] ?? 0)))
  const maxVal  = Math.max(...allVals, 0.01)
  const labelStep = Math.max(1, Math.floor(data.length / 5))

  const xOf = i => PAD.left + (i / Math.max(data.length - 1, 1)) * plotW
  const yOf = v => PAD.top  + plotH - Math.min(v / maxVal, 1) * plotH

  const fmtTime = iso => {
    try { return new Date(iso).toLocaleTimeString('en', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }) }
    catch { return '' }
  }
  const fmtVal = v => v >= 1000 ? (v / 1000).toFixed(1) + 'k' : v % 1 !== 0 ? v.toFixed(1) : String(Math.round(v))

  const handleMouseMove = e => {
    const rect = e.currentTarget.getBoundingClientRect()
    const svgX = (e.clientX - rect.left) * (W / rect.width)
    let nearest = 0, minDist = Infinity
    data.forEach((_, i) => { const d = Math.abs(xOf(i) - svgX); if (d < minDist) { minDist = d; nearest = i } })
    setHoverIdx(nearest)
  }

  const tooltipOnRight = hoverIdx != null && xOf(hoverIdx) / W < 0.6

  const fmtTimeFull = iso => {
    try { return new Date(iso).toLocaleString('en', { timeZone: 'Asia/Kolkata', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true }) }
    catch { return '' }
  }

  if (!data || data.length < 2) {
    return (
      <div className={styles.smoothChartCard}>
        <div className={styles.chartCardHeader}>
          <div className={styles.chartCardIcon} style={{ background: iconBg || 'rgba(243,244,246,0.6)' }}>{icon}</div>
          <span className={styles.chartCardTitle}>{title}</span>
        </div>
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#94a3b8', fontSize: 11, padding: '16px 0' }}>
          No data available
        </div>
      </div>
    )
  }

  // Current value display for header
  const latestVals = lines.map(l => {
    const v = l.fn ? l.fn(data[data.length - 1]) : (data[data.length - 1][l.key] ?? 0)
    return { label: l.label, val: fmtVal(v), unit: l.unit || '', color: l.color }
  })

  return (
    <div className={styles.smoothChartCard}>
      <div className={styles.chartCardHeader}>
        <div className={styles.chartCardIcon} style={{ background: iconBg || 'rgba(243,244,246,0.6)' }}>{icon}</div>
        <span className={styles.chartCardTitle}>{title}</span>
        {/* Current values inline */}
        <div style={{ display: 'flex', gap: 10, marginLeft: 'auto', marginRight: 6 }}>
          {latestVals.map(lv => (
            <span key={lv.label} style={{ fontSize: 10, color: '#64748b' }}>
              <span style={{ fontWeight: 700, color: lv.color }}>{lv.val}{lv.unit}</span>
            </span>
          ))}
        </div>
        <div className={styles.chartCardActions}>
          <span className={styles.chartActionBtn} title="Chart">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
          </span>
          <span className={styles.chartActionBtn} title="Table">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/></svg>
          </span>
        </div>
      </div>

      <div style={{ position: 'relative' }}>
        <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: 'block', overflow: 'visible', cursor: 'crosshair' }}
          onMouseMove={handleMouseMove} onMouseLeave={() => setHoverIdx(null)}>
          <defs>
            {lines.filter(l => l.area).map(l => (
              <linearGradient key={`grad-${l.key}`} id={`sg-${l.key}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%"   stopColor={l.color} stopOpacity="0.28" />
                <stop offset="100%" stopColor={l.color} stopOpacity="0.02" />
              </linearGradient>
            ))}
          </defs>

          {/* Grid lines — lighter, dotted */}
          {[0, 0.25, 0.5, 0.75, 1].map(p => (
            <line key={p} x1={PAD.left} x2={PAD.left + plotW}
              y1={PAD.top + plotH * (1 - p)} y2={PAD.top + plotH * (1 - p)}
              stroke="rgba(0,0,0,0.06)" strokeWidth="0.8" strokeDasharray="3,3" />
          ))}

          {/* Area fills + lines */}
          {lines.map(l => {
            const pts = data.map((d, i) => [xOf(i), yOf(l.fn ? l.fn(d) : (d[l.key] ?? 0))])
            const path = catmullRom(pts)
            const areaPath = path + ` L ${xOf(data.length - 1)},${PAD.top + plotH} L ${xOf(0)},${PAD.top + plotH} Z`
            return (
              <g key={l.key}>
                {l.area && <path d={areaPath} fill={`url(#sg-${l.key})`} />}
                <path d={path} fill="none" stroke={l.color} strokeWidth="2"
                  strokeDasharray={l.dashed ? '5,3' : undefined} strokeLinejoin="round" strokeLinecap="round" />
              </g>
            )
          })}

          {/* Hover crosshair */}
          {hoverIdx != null && (
            <line x1={xOf(hoverIdx)} x2={xOf(hoverIdx)} y1={PAD.top} y2={PAD.top + plotH}
              stroke="rgba(148,163,184,0.5)" strokeWidth="1" strokeDasharray="3,2" />
          )}

          {/* Dots on hover */}
          {hoverIdx != null && lines.map(l => {
            const v = l.fn ? l.fn(data[hoverIdx]) : (data[hoverIdx][l.key] ?? 0)
            return <circle key={l.key} cx={xOf(hoverIdx)} cy={yOf(v)} r="3.5" fill={l.color} stroke="#fff" strokeWidth="1.5" />
          })}

          {/* Y axis labels */}
          {[0, 0.5, 1].map(p => (
            <text key={p} x={PAD.left - 4} y={PAD.top + plotH * (1 - p) + 3}
              textAnchor="end" fontSize="8.5" fill="#94a3b8" fontWeight="500">
              {fmtVal(maxVal * p)}
            </text>
          ))}

          {/* X axis labels */}
          {data.map((d, i) => i % labelStep === 0 && (
            <text key={i} x={xOf(i)} y={H - 4} textAnchor="middle" fontSize="8.5" fill="#94a3b8" fontWeight="500">
              {fmtTime(d.ts)}
            </text>
          ))}
        </svg>

        {/* Tooltip — glass */}
        {hoverIdx != null && (
          <div style={{
            position: 'absolute', top: 6,
            left:  tooltipOnRight ? `calc(${xOf(hoverIdx) / W * 100}% + 10px)` : undefined,
            right: tooltipOnRight ? undefined : `calc(${(1 - xOf(hoverIdx) / W) * 100}% + 10px)`,
            background: 'rgba(255,255,255,0.85)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
            border: '1px solid rgba(255,255,255,0.8)', borderRadius: 8,
            boxShadow: '0 4px 16px rgba(0,0,0,0.08)', padding: '7px 11px',
            minWidth: 140, pointerEvents: 'none', zIndex: 10, fontSize: 10.5, lineHeight: 1.6,
          }}>
            <div style={{ fontWeight: 700, color: '#1e293b', marginBottom: 3, fontSize: 10.5 }}>
              {fmtTimeFull(data[hoverIdx].ts)}
            </div>
            {lines.map(l => {
              const v = l.fn ? l.fn(data[hoverIdx]) : (data[hoverIdx][l.key] ?? 0)
              return (
                <div key={l.key} style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                  <span style={{ color: '#64748b' }}>{l.label}</span>
                  <span style={{ fontWeight: 700, color: l.color }}>{fmtVal(v)}{l.unit || ''}</span>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Legend */}
      <div className={styles.chartLegendRow}>
        {lines.map(l => (
          <span key={l.key} className={styles.chartLegendItem}>
            <span className={styles.chartLegendDot} style={{ background: l.color, opacity: l.dashed ? 0.6 : 1 }} />
            {l.label}
          </span>
        ))}
      </div>
    </div>
  )
}

// ─── App card ─────────────────────────────────────────────────────────────────

function _dead() { return null
  if (!data || data.length < 2) {
    return (
      <div style={{
        background: '#fff', border: '1.5px dashed #e5e7eb', borderRadius: 14,
        padding: '28px 24px', display: 'flex', flexDirection: 'column',
        alignItems: 'center', gap: 8, color: '#9ca3af'
      }}>
        <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#d1d5db" strokeWidth="1.5">
          <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
        </svg>
        <span style={{ fontWeight: 600, fontSize: 13, color: '#6b7280' }}>No timeline data yet</span>
        <span style={{ fontSize: 12, textAlign: 'center' }}>
          Re-run the analysis to generate a per-minute request &amp; latency chart.
        </span>
      </div>
    )
  }

  const W = 800, H = 220
  const PAD = { top: 16, right: 56, bottom: 36, left: 52 }
  const plotW = W - PAD.left - PAD.right
  const plotH = H - PAD.top  - PAD.bottom

  const maxReq = Math.max(...data.map(d => d.requests), 1)
  const maxLat = Math.max(...data.map(d => d.p95_latency_ms || 0), 1)

  const xOf  = i   => PAD.left + (i / (data.length - 1)) * plotW
  const yReq = v   => PAD.top  + plotH - (v / maxReq) * plotH
  const yLat = v   => PAD.top  + plotH - (v / maxLat) * plotH

  const reqLine = data.map((d, i) => `${xOf(i)},${yReq(d.requests)}`).join(' ')
  const latLine = data
    .map((d, i) => d.p95_latency_ms != null ? `${xOf(i)},${yLat(d.p95_latency_ms)}` : null)
    .filter(Boolean).join(' ')

  const reqArea = [
    `${xOf(0)},${PAD.top + plotH}`,
    ...data.map((d, i) => `${xOf(i)},${yReq(d.requests)}`),
    `${xOf(data.length - 1)},${PAD.top + plotH}`,
  ].join(' ')

  const labelStep = Math.max(1, Math.floor(data.length / 7))
  const fmtTime   = iso => {
    try { return new Date(iso).toLocaleTimeString('en', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }) }
    catch { return '' }
  }
  const fmtTimeFull = iso => {
    try { return new Date(iso).toLocaleString('en', { timeZone: 'Asia/Kolkata', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true }) }
    catch { return '' }
  }
  const fmtK = v => v >= 1000 ? (v/1000).toFixed(1)+'k' : String(v)

  const handleMouseMove = e => {
    const rect  = e.currentTarget.getBoundingClientRect()
    const svgX  = (e.clientX - rect.left) * (W / rect.width)
    let nearest = 0, minDist = Infinity
    data.forEach((_, i) => {
      const dist = Math.abs(xOf(i) - svgX)
      if (dist < minDist) { minDist = dist; nearest = i }
    })
    setHoverIdx(nearest)
  }

  // Tooltip: flip to left side when near right edge
  const tooltipOnRight = hoverIdx != null && xOf(hoverIdx) / W < 0.65

  return (
    <div className={styles.timelineCard}>
      <div className={styles.timelineHeader}>
        <span className={styles.timelineTitle}>Request Volume &amp; P95 Latency</span>
        <div className={styles.timelineLegend}>
          <span className={styles.legendItem}><span className={styles.legendLine} style={{ background: '#7c3aed' }} />Requests</span>
          <span className={styles.legendItem}><span className={styles.legendLine} style={{ background: 'transparent', borderTop: '2px dashed #f59e0b' }} />P95 Latency</span>
        </div>
      </div>

      <div style={{ position: 'relative' }}>
        <svg width="100%" viewBox={`0 0 ${W} ${H}`} className={styles.timelineSvg}
          onMouseMove={handleMouseMove}
          onMouseLeave={() => setHoverIdx(null)}
          style={{ cursor: 'crosshair' }}
        >
          <defs>
            <linearGradient id="reqGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%"   stopColor="#7c3aed" stopOpacity="0.18" />
              <stop offset="100%" stopColor="#7c3aed" stopOpacity="0.01" />
            </linearGradient>
          </defs>

          {/* Horizontal grid lines */}
          {[0.25, 0.5, 0.75, 1].map(pct => (
            <line key={pct}
              x1={PAD.left} y1={PAD.top + plotH * (1 - pct)}
              x2={PAD.left + plotW} y2={PAD.top + plotH * (1 - pct)}
              stroke="#f3f4f6" strokeWidth="1" />
          ))}

          {/* Requests area fill */}
          <polygon points={reqArea} fill="url(#reqGrad)" />

          {/* Requests line */}
          <polyline points={reqLine} fill="none" stroke="#7c3aed" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />

          {/* Latency dashed line */}
          {latLine && <polyline points={latLine} fill="none" stroke="#f59e0b" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" strokeDasharray="6,3" />}

          {/* Dots */}
          {data.map((d, i) => (
            <g key={i}>
              <circle cx={xOf(i)} cy={yReq(d.requests)} r={hoverIdx === i ? 5 : 3.5}
                fill="#7c3aed" stroke="#fff" strokeWidth="1.5" />
              {d.p95_latency_ms != null && (
                <circle cx={xOf(i)} cy={yLat(d.p95_latency_ms)} r={hoverIdx === i ? 5 : 3.5}
                  fill="#f59e0b" stroke="#fff" strokeWidth="1.5" />
              )}
            </g>
          ))}

          {/* Crosshair */}
          {hoverIdx != null && (
            <line
              x1={xOf(hoverIdx)} y1={PAD.top}
              x2={xOf(hoverIdx)} y2={PAD.top + plotH}
              stroke="#9ca3af" strokeWidth="1" strokeDasharray="4,3" />
          )}

          {/* X axis labels (time) */}
          {data.map((d, i) => i % labelStep === 0 && (
            <text key={i} x={xOf(i)} y={H - 6} textAnchor="middle" fontSize="10" fill="#9ca3af">
              {fmtTime(d.ts)}
            </text>
          ))}

          {/* Left Y axis — requests */}
          {[0, 0.5, 1].map(pct => (
            <text key={pct} x={PAD.left - 6} y={PAD.top + plotH * (1 - pct) + 4}
              textAnchor="end" fontSize="10" fill="#7c3aed">
              {fmtK(Math.round(maxReq * pct))}
            </text>
          ))}
          <text x={16} y={PAD.top + plotH / 2} textAnchor="middle" fontSize="10" fill="#7c3aed"
            transform={`rotate(-90 16 ${PAD.top + plotH / 2})`}>Requests</text>

          {/* Right Y axis — latency */}
          {[0, 0.5, 1].map(pct => (
            <text key={pct} x={PAD.left + plotW + 6} y={PAD.top + plotH * (1 - pct) + 4}
              textAnchor="start" fontSize="10" fill="#f59e0b">
              {Math.round(maxLat * pct)}
            </text>
          ))}
          <text x={W - 14} y={PAD.top + plotH / 2} textAnchor="middle" fontSize="10" fill="#f59e0b"
            transform={`rotate(90 ${W - 14} ${PAD.top + plotH / 2})`}>P95 ms</text>

          {/* Axis borders */}
          <line x1={PAD.left} y1={PAD.top} x2={PAD.left} y2={PAD.top + plotH} stroke="#e5e7eb" strokeWidth="1" />
          <line x1={PAD.left} y1={PAD.top + plotH} x2={PAD.left + plotW} y2={PAD.top + plotH} stroke="#e5e7eb" strokeWidth="1" />
        </svg>

        {/* Hover tooltip */}
        {hoverIdx != null && (() => {
          const d   = data[hoverIdx]
          const xPct = xOf(hoverIdx) / W * 100
          return (
            <div style={{
              position: 'absolute',
              top: '12px',
              left: tooltipOnRight ? `calc(${xPct}% + 12px)` : undefined,
              right: tooltipOnRight ? undefined : `calc(${100 - xPct}% + 12px)`,
              background: '#fff',
              border: '1.5px solid #e5e7eb',
              borderRadius: 10,
              boxShadow: '0 4px 16px rgba(0,0,0,0.10)',
              padding: '10px 14px',
              minWidth: 196,
              pointerEvents: 'none',
              zIndex: 10,
              fontSize: 12,
              lineHeight: 1.7,
            }}>
              <div style={{ fontWeight: 700, color: '#111827', marginBottom: 6, fontSize: 12.5 }}>
                {fmtTimeFull(d.ts)}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 10 }}>
                <span style={{ color: '#6b7280' }}>Requests</span>
                <span style={{ fontWeight: 600, color: '#7c3aed' }}>{d.requests}</span>
                <span style={{ color: '#6b7280' }}>Errors</span>
                <span style={{ fontWeight: 600, color: d.errors > 0 ? '#ef4444' : '#10b981' }}>{d.errors}</span>
                <span style={{ color: '#6b7280' }}>Error Rate</span>
                <span style={{ fontWeight: 600, color: d.errors > 0 ? '#f59e0b' : '#374151' }}>
                  {d.requests > 0 ? ((d.errors / d.requests) * 100).toFixed(1) + '%' : '—'}
                </span>
                <span style={{ color: '#6b7280' }}>Avg Latency</span>
                <span style={{ fontWeight: 600, color: '#374151' }}>
                  {d.avg_latency_ms != null ? Math.round(d.avg_latency_ms) + ' ms' : '—'}
                </span>
                <span style={{ color: '#6b7280' }}>P95 Latency</span>
                <span style={{ fontWeight: 600, color: '#f59e0b' }}>
                  {d.p95_latency_ms != null ? fmtDur(Math.round(d.p95_latency_ms)) : '—'}
                </span>
              </div>
            </div>
          )
        })()}
      </div>
    </div>
  )
}

// ─── App card ─────────────────────────────────────────────────────────────────

function AppCard({ app, onSelect }) {
  const sm  = statusMeta(app.status)
  const col = appAvatarColor(app.name)
  const [hover, setHover] = useState(false)
  const cardStyle = {
    background: '#fff',
    border: '1px solid #e5e7eb',
    borderRadius: 14,
    boxShadow: hover ? '0 8px 24px rgba(0,0,0,0.08)' : '0 1px 2px rgba(0,0,0,0.03)',
    padding: 18,
    cursor: 'pointer',
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
    transform: hover ? 'translateY(-2px)' : 'none',
    transition: 'box-shadow 0.15s, transform 0.15s',
    fontFamily: "'Inter', -apple-system, system-ui, sans-serif",
  }
  return (
    <div style={cardStyle} onClick={onSelect}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      {/* Top: status + menu */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          background: sm.bg, color: sm.dot, border: `1px solid ${sm.border}`,
          padding: '3px 10px', borderRadius: 999, fontSize: 11, fontWeight: 700,
        }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: sm.dot }} />
          {sm.label}
        </span>
        <span style={{ color: '#cbd5e1', fontSize: 18, letterSpacing: 1 }}>⋯</span>
      </div>

      {/* Name row */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <div style={{
            width: 40, height: 40, borderRadius: 10, background: col,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: '#fff', fontWeight: 800, fontSize: 14, flexShrink: 0,
          }}>{appInitials(app.name)}</div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: '#111827',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{app.name}</div>
            {app.app_id && (
              <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 2,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                title={`Global App ID: ${app.app_id}`}>
                <span style={{ fontWeight: 600 }}>Global App ID:</span>{' '}
                <code style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>{app.app_id}</code>
              </div>
            )}
            <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>Analyzed {relTime(app.analyzedAt)}</div>
          </div>
        </div>
        <HealthRing value={app.health} />
      </div>

      {/* Stat rows */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {[
          { label: 'Total Requests', val: fmt(app.totalReq),
            icon: <svg viewBox="0 0 24 24" fill="none" stroke="#9ca3af" strokeWidth="2" width="14" height="14"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg> },
          { label: 'Error Rate', val: app.errorRate != null ? app.errorRate + '%' : '—', valColor: errColor(app.errorRate),
            icon: <svg viewBox="0 0 24 24" fill="none" stroke="#9ca3af" strokeWidth="2" width="14" height="14"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/></svg> },
          { label: 'P95 Latency', val: fmtDur(app.p95Latency),
            icon: <svg viewBox="0 0 24 24" fill="none" stroke="#9ca3af" strokeWidth="2" width="14" height="14"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg> },
          { label: 'Workflow executions', val: fmt(app.totalWorkflows),
            icon: <svg viewBox="0 0 24 24" fill="none" stroke="#9ca3af" strokeWidth="2" width="14" height="14"><path d="M3 6h18M3 12h18M3 18h18"/></svg> },
          { label: 'Failed executions', val: fmt(app.failedWorkflows),
            valColor: app.failedWorkflows > 0 ? '#ef4444' : '#111827',
            icon: <svg viewBox="0 0 24 24" fill="none" stroke="#9ca3af" strokeWidth="2" width="14" height="14"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg> },
        ].map(r => (
          <div key={r.label} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {r.icon}
            <span style={{ fontSize: 12, color: '#6b7280', flex: 1 }}>{r.label}</span>
            <span style={{ fontSize: 13, fontWeight: 700, color: r.valColor || '#111827' }}>{r.val}</span>
          </div>
        ))}
      </div>

      {/* Env pills */}
      <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
        {app.instances.map(env => {
          const c = instanceColor(env)
          return <span key={env} style={{
            background: c.bg, color: c.color, padding: '2px 9px',
            borderRadius: 999, fontSize: 10.5, fontWeight: 700,
          }}>{env.charAt(0).toUpperCase() + env.slice(1)}</span>
        })}
        <span style={{ fontSize: 10.5, color: '#9ca3af', marginLeft: 'auto' }}>
          {app.instances.length} instance{app.instances.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Footer */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        paddingTop: 10, borderTop: '1px solid #f3f4f6',
      }}>
        <span style={{ fontSize: 11, color: '#9ca3af' }}>
          Analyzed <strong style={{ color: '#374151', fontWeight: 700 }}>{relTime(app.analyzedAt)}</strong>
        </span>
        <button
          onClick={e => { e.stopPropagation(); onSelect() }}
          style={{
            background: 'transparent', border: 'none', color: '#10B981',
            fontSize: 12, fontWeight: 700, cursor: 'pointer', padding: 0,
          }}>
          View details ›
        </button>
      </div>
    </div>
  )
}

// ─── Group raw app_insights docs → one card per app_name ─────────────────────

function groupAppInsights(docs) {
  const map = {}
  for (const doc of docs) {
    const key = doc.app_name
    if (!map[key]) {
      map[key] = { id: doc.id || doc._id || key, name: doc.app_name, app_id: doc.app_id || null, instances: [], metrics: [], analyzedAt: doc.analyzed_at }
    } else if (!map[key].app_id && doc.app_id) {
      map[key].app_id = doc.app_id
    }
    const env = (doc.environment || '').toLowerCase() || 'unknown'
    if (!map[key].instances.includes(env)) map[key].instances.push(env)
    map[key].metrics.push(doc.metrics || {})
    if (doc.analyzed_at > map[key].analyzedAt) map[key].analyzedAt = doc.analyzed_at
  }

  return Object.values(map).map(app => {
    const totalReq = app.metrics.reduce((s, m) => s + (m.total_requests || 0), 0)
    const errRates = app.metrics.map(m => m.error_rate_pct).filter(v => v != null)
    const avgErr   = errRates.length ? errRates.reduce((a, b) => a + b, 0) / errRates.length : null
    const p95vals  = app.metrics.map(m => m.latency_ms?.p95).filter(v => v != null)
    const maxP95   = p95vals.length ? Math.max(...p95vals) : null
    const totalWorkflows  = app.metrics.reduce((s, m) => s + (m.workflow_total  || 0), 0)
    const failedWorkflows = app.metrics.reduce((s, m) => s + (m.workflow_failed || 0), 0)

    let health, status
    if (avgErr == null) { health = null; status = 'no-data' }
    else if (avgErr <= 1)  { health = Math.round(95 - avgErr * 5);  status = 'healthy'  }
    else if (avgErr <= 5)  { health = Math.round(80 - avgErr * 4);  status = 'healthy'  }
    else if (avgErr <= 15) { health = Math.round(65 - avgErr * 2);  status = 'warning'  }
    else                   { health = Math.max(5, Math.round(40 - avgErr)); status = 'critical' }

    return { ...app, instances: app.instances.sort(), totalReq, errorRate: avgErr != null ? Math.round(avgErr * 10) / 10 : null, p95Latency: maxP95, totalWorkflows, failedWorkflows, health, status }
  }).sort((a, b) => a.name.localeCompare(b.name))
}

// ─── AI Insight Topic components ─────────────────────────────────────────────

const INSIGHT_TOPICS = [
  {
    key: 'request_classification',
    icon: '🔍', title: 'Request Types',
    color: '#3b82f6', bg: '#eff6ff', border: '#bfdbfe',
    desc: (ins) => ins.request_classification?.summary || 'API, WebSocket & internal call classification',
    count: (ins) => {
      const rc = ins.request_classification
      if (!rc) return null
      return (rc.api_calls?.count || 0) + (rc.websocket_connections?.count || 0) + (rc.internal_service_calls?.count || 0)
    },
    countLabel: 'requests classified',
  },
  {
    key: 'latency_breakdown',
    icon: '⏱', title: 'Latency Breakdown',
    color: '#f59e0b', bg: '#fffbeb', border: '#fde68a',
    desc: (ins) => ins.latency_breakdown?.summary || 'Proxy time vs backend time per endpoint',
    count: (ins) => ins.latency_breakdown?.hotspots?.length ?? null,
    countLabel: 'hotspots',
  },
  {
    key: 'slowness_analysis',
    icon: '🐢', title: 'Slowness Detection',
    color: '#ef4444', bg: '#fef2f2', border: '#fecaca',
    desc: (ins) => ins.slowness_analysis?.summary || 'Backend slowness, WebSocket expected behavior, systemic issues',
    count: (ins) => ins.slowness_analysis?.issues?.length ?? null,
    countLabel: 'issues found',
  },
  {
    key: 'error_analysis',
    icon: '❌', title: 'Error Analysis',
    color: '#dc2626', bg: '#fef2f2', border: '#fca5a5',
    desc: (ins) => ins.error_analysis?.summary || '4xx client errors, 5xx server errors and patterns',
    count: (ins) => {
      const ea = ins.error_analysis
      if (!ea) return null
      return (ea.client_errors_4xx?.count || 0) + (ea.server_errors_5xx?.count || 0)
    },
    countLabel: 'total errors',
  },
  {
    key: 'endpoint_analysis',
    icon: '📡', title: 'Endpoint Analysis',
    color: '#7c3aed', bg: '#faf5ff', border: '#ddd6fe',
    desc: (ins) => ins.endpoint_analysis?.summary || 'Slowest and most error-prone endpoints',
    count: (ins) => (ins.endpoint_analysis?.slowest?.length || 0) + (ins.endpoint_analysis?.most_error_prone?.length || 0),
    countLabel: 'endpoints flagged',
  },
  {
    key: 'correlation_analysis',
    icon: '🔗', title: 'Correlation',
    color: '#6366f1', bg: '#eef2ff', border: '#c7d2fe',
    desc: (ins) => ins.correlation_analysis?.summary || 'Latency vs backend, failures vs endpoints',
    count: (ins) => ins.correlation_analysis?.findings?.length ?? null,
    countLabel: 'findings',
  },
  {
    key: 'root_cause',
    icon: '🎯', title: 'Root Cause',
    color: '#dc2626', bg: '#fef2f2', border: '#fca5a5',
    desc: (ins) => ins.root_cause?.primary_issue || 'Primary issue classification and evidence',
    count: (ins) => ins.root_cause?.evidence?.length ?? null,
    countLabel: 'evidence points',
  },
  {
    key: 'top_issues',
    icon: '⚠', title: 'Top Issues',
    color: '#f59e0b', bg: '#fffbeb', border: '#fde68a',
    desc: (ins) => ins.top_issues?.[0] || 'Critical issues identified',
    count: (ins) => ins.top_issues?.length ?? null,
    countLabel: 'issues',
  },
  {
    key: 'recommendations',
    icon: '✅', title: 'Recommendations',
    color: '#10b981', bg: '#f0fdf4', border: '#6ee7b7',
    desc: (ins) => ins.recommendations?.[0] || 'Actionable recommendations',
    count: (ins) => ins.recommendations?.length ?? null,
    countLabel: 'recommendations',
  },
  {
    key: 'security_observations',
    icon: '🛡', title: 'Security',
    color: '#6366f1', bg: '#eef2ff', border: '#c7d2fe',
    desc: (ins) => typeof ins.security_observations === 'string' ? ins.security_observations : 'Security observations from logs',
    count: () => null,
    countLabel: '',
  },
]

function InsightTopicGrid({ insights, onSelect }) {
  const available = INSIGHT_TOPICS.filter(t => {
    const val = insights[t.key]
    if (val == null) return false
    if (Array.isArray(val)) return val.length > 0
    if (typeof val === 'object') return Object.keys(val).length > 0
    if (typeof val === 'string') return val.trim().length > 0
    return false
  })

  if (available.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: '32px 0', color: '#9ca3af', fontSize: 13 }}>
        No AI analysis data yet. Re-run the analysis to generate insights.
      </div>
    )
  }

  return (
    <div className={styles.topicGrid}>
      {available.map(t => {
        const cnt = t.count(insights)
        const desc = t.desc(insights)
        const truncDesc = desc && desc.length > 80 ? desc.slice(0, 77) + '…' : desc
        return (
          <div key={t.key} className={styles.topicCard} onClick={() => onSelect(t.key)}
            style={{ borderTop: `3px solid ${t.color}`, background: t.bg }}>
            <div className={styles.topicCardHeader}>
              <span className={styles.topicCardIcon} style={{ background: t.border }}>{t.icon}</span>
              <span className={styles.topicCardTitle} style={{ color: t.color }}>{t.title}</span>
              {cnt != null && cnt > 0 && (
                <span className={styles.topicCardBadge} style={{ background: t.color }}>
                  {cnt} {t.countLabel}
                </span>
              )}
            </div>
            <p className={styles.topicCardDesc}>{truncDesc}</p>
            <div className={styles.topicCardFooter}>
              <span style={{ fontSize: 12, color: t.color, fontWeight: 600 }}>View details →</span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

const CATEGORY_LABELS = {
  backend_slowness:    { label: 'Backend Slowness',        color: '#ef4444', bg: '#fef2f2' },
  websocket_expected:  { label: 'WebSocket (Expected)',     color: '#10b981', bg: '#f0fdf4' },
  systemic:            { label: 'Systemic Issue',           color: '#f59e0b', bg: '#fffbeb' },
  external_dependency: { label: 'External Dependency',      color: '#6366f1', bg: '#eef2ff' },
  low_traffic:         { label: 'Low Traffic / Sparse Data',color: '#9ca3af', bg: '#f9fafb' },
  configuration:       { label: 'Configuration Issue',      color: '#f97316', bg: '#fff7ed' },
  healthy:             { label: 'Healthy',                  color: '#10b981', bg: '#f0fdf4' },
  ingress:             { label: 'Ingress / Proxy',          color: '#f97316', bg: '#fff7ed' },
  backend:             { label: 'Backend Service',          color: '#ef4444', bg: '#fef2f2' },
  external:            { label: 'External Dependency',      color: '#6366f1', bg: '#eef2ff' },
}

function CatBadge({ cat }) {
  const m = CATEGORY_LABELS[cat] || { label: cat, color: '#6b7280', bg: '#f3f4f6' }
  return (
    <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 99,
      background: m.bg, color: m.color, border: `1px solid ${m.color}30` }}>
      {m.label}
    </span>
  )
}

function InsightTopicDetail({ topic, insights, setModal }) {
  const t   = INSIGHT_TOPICS.find(x => x.key === topic)
  const val = insights[topic]
  if (!t || !val) return <div style={{ color: '#9ca3af', padding: 24 }}>No data for this topic.</div>

  const Section = ({ title, children }) => (
    <div style={{ marginBottom: 20 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase',
        letterSpacing: '0.07em', marginBottom: 10 }}>{title}</div>
      {children}
    </div>
  )

  const TextCard = ({ text, accent = '#7c3aed' }) => (
    <div style={{ background: '#f9fafb', border: '1px solid #e5e7eb', borderLeft: `3px solid ${accent}`,
      borderRadius: 8, padding: '10px 14px', fontSize: 13, color: '#374151', lineHeight: 1.65, marginBottom: 8 }}>
      {text}
    </div>
  )

  const Row = ({ label, value, color = '#111827' }) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      padding: '7px 0', borderBottom: '1px solid #f3f4f6', fontSize: 13 }}>
      <span style={{ color: '#6b7280' }}>{label}</span>
      <span style={{ fontWeight: 700, color }}>{value}</span>
    </div>
  )

  // ── request_classification ──
  if (topic === 'request_classification') {
    const rc = val
    return (
      <div className={styles.topicDetailWrap}>
        {rc.summary && <TextCard text={rc.summary} accent="#3b82f6" />}
        <div className={styles.topicStatRow}>
          {[
            { label: 'API Calls',       val: rc.api_calls?.count ?? 0,                color: '#3b82f6' },
            { label: 'WebSocket',       val: rc.websocket_connections?.count ?? 0,    color: '#10b981' },
            { label: 'Internal Calls',  val: rc.internal_service_calls?.count ?? 0,   color: '#7c3aed' },
          ].map(({ label, val: v, color }) => (
            <div key={label} className={styles.topicStatCard}>
              <span className={styles.topicStatNum} style={{ color }}>{v}</span>
              <span className={styles.topicStatLabel}>{label}</span>
            </div>
          ))}
        </div>
        {rc.websocket_connections?.note && (
          <Section title="WebSocket Note">
            <TextCard text={rc.websocket_connections.note} accent="#10b981" />
          </Section>
        )}
        {rc.api_calls?.sample_paths?.length > 0 && (
          <Section title="Sample API Paths">
            {rc.api_calls.sample_paths.slice(0, 8).map((p, i) => (
              <div key={i} style={{ fontFamily: 'monospace', fontSize: 12, padding: '5px 10px',
                background: '#f3f4f6', borderRadius: 5, marginBottom: 4, color: '#374151' }}>{p}</div>
            ))}
          </Section>
        )}
        {rc.internal_service_calls?.services?.length > 0 && (
          <Section title="Internal Services">
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {rc.internal_service_calls.services.map((s, i) => (
                <span key={i} style={{ fontSize: 12, padding: '3px 10px', background: '#ede9fe',
                  color: '#7c3aed', borderRadius: 99, fontWeight: 600 }}>{s}</span>
              ))}
            </div>
          </Section>
        )}
      </div>
    )
  }

  // ── latency_breakdown ──
  if (topic === 'latency_breakdown') {
    const lb = val
    return (
      <div className={styles.topicDetailWrap}>
        {lb.summary && <TextCard text={lb.summary} accent="#f59e0b" />}
        <div className={styles.topicStatRow}>
          <div className={styles.topicStatCard}>
            <span className={styles.topicStatNum} style={{ color: lb.ingress_dominated ? '#f97316' : '#10b981' }}>
              {lb.ingress_dominated ? 'Yes' : 'No'}
            </span>
            <span className={styles.topicStatLabel}>Ingress Dominated</span>
          </div>
          <div className={styles.topicStatCard}>
            <span className={styles.topicStatNum} style={{ color: lb.backend_dominated ? '#ef4444' : '#10b981' }}>
              {lb.backend_dominated ? 'Yes' : 'No'}
            </span>
            <span className={styles.topicStatLabel}>Backend Dominated</span>
          </div>
          <div className={styles.topicStatCard}>
            <span className={styles.topicStatNum} style={{ color: '#f59e0b' }}>{lb.hotspots?.length ?? 0}</span>
            <span className={styles.topicStatLabel}>Hotspots</span>
          </div>
        </div>
        {lb.hotspots?.length > 0 && (
          <Section title="Latency Hotspots">
            {lb.hotspots.map((h, i) => (
              <div key={i} style={{ background: '#fff', border: '1.5px solid #e5e7eb', borderRadius: 10,
                padding: '12px 14px', marginBottom: 8 }}
                onClick={() => setModal({ title: 'Latency Hotspot', icon: '⏱', type: 'text',
                  content: `Path: ${h.path}\n\nTotal: ${fmtDur(h.total_ms)}\nProxy: ${fmtDur(h.proxy_ms)}\nBackend: ${fmtDur(h.backend_ms)}\nBottleneck: ${h.bottleneck}` })}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                  <span style={{ fontFamily: 'monospace', fontSize: 12, color: '#374151', flex: 1, marginRight: 8 }}>{h.path}</span>
                  <CatBadge cat={h.bottleneck} />
                </div>
                <div style={{ display: 'flex', gap: 16, fontSize: 12 }}>
                  <span style={{ color: '#6b7280' }}>Total <strong style={{ color: '#111827' }}>{fmtDur(h.total_ms)}</strong></span>
                  <span style={{ color: '#6b7280' }}>Proxy <strong style={{ color: '#f97316' }}>{fmtDur(h.proxy_ms)}</strong></span>
                  <span style={{ color: '#6b7280' }}>Backend <strong style={{ color: '#ef4444' }}>{fmtDur(h.backend_ms)}</strong></span>
                </div>
              </div>
            ))}
          </Section>
        )}
      </div>
    )
  }

  // ── slowness_analysis ──
  if (topic === 'slowness_analysis') {
    const sa = val
    return (
      <div className={styles.topicDetailWrap}>
        {sa.summary && <TextCard text={sa.summary} accent="#ef4444" />}
        {sa.issues?.length > 0 && (
          <Section title={`Issues (${sa.issues.length})`}>
            {sa.issues.map((issue, i) => (
              <div key={i} style={{ background: '#fff', border: '1.5px solid #e5e7eb', borderRadius: 10,
                padding: '12px 14px', marginBottom: 8, cursor: 'pointer' }}
                onClick={() => setModal({ title: 'Slowness Issue', icon: '🐢', type: 'text',
                  content: `Path: ${issue.path}\nCategory: ${issue.category}\n\n${issue.evidence}` })}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                  <span style={{ fontFamily: 'monospace', fontSize: 12, color: '#374151', flex: 1, marginRight: 8 }}>{issue.path}</span>
                  <CatBadge cat={issue.category} />
                </div>
                {issue.evidence && (
                  <p style={{ fontSize: 12, color: '#6b7280', margin: 0, lineHeight: 1.5 }}>{issue.evidence}</p>
                )}
              </div>
            ))}
          </Section>
        )}
      </div>
    )
  }

  // ── error_analysis ──
  if (topic === 'error_analysis') {
    const ea = val
    return (
      <div className={styles.topicDetailWrap}>
        {ea.summary && <TextCard text={ea.summary} accent="#dc2626" />}
        <div className={styles.topicStatRow}>
          <div className={styles.topicStatCard}>
            <span className={styles.topicStatNum} style={{ color: '#f59e0b' }}>{ea.client_errors_4xx?.count ?? 0}</span>
            <span className={styles.topicStatLabel}>4xx Client Errors</span>
          </div>
          <div className={styles.topicStatCard}>
            <span className={styles.topicStatNum} style={{ color: '#ef4444' }}>{ea.server_errors_5xx?.count ?? 0}</span>
            <span className={styles.topicStatLabel}>5xx Server Errors</span>
          </div>
        </div>
        {ea.client_errors_4xx?.top_codes?.length > 0 && (
          <Section title="Top 4xx Codes">
            {ea.client_errors_4xx.top_codes.map((e, i) => (
              <div key={i} className={styles.insightItemCard} style={{ borderLeft: '3px solid #f59e0b' }}
                onClick={() => setModal({ title: `HTTP ${e.code}`, icon: '⚠', type: 'error', content: e })}>
                <div className={styles.insightItemLeft}>
                  <span style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: 13, color: '#f59e0b' }}>{e.code}</span>
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 13, color: '#111827' }}>{e.count} occurrences</div>
                  <div style={{ fontSize: 11.5, color: '#6b7280' }}>{(e.sample_paths || []).slice(0,1).join(', ') || '—'}</div>
                </div>
                <svg className={styles.insightItemChevron} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" strokeWidth="2.5"><polyline points="9 18 15 12 9 6"/></svg>
              </div>
            ))}
          </Section>
        )}
        {ea.server_errors_5xx?.top_codes?.length > 0 && (
          <Section title="Top 5xx Codes">
            {ea.server_errors_5xx.top_codes.map((e, i) => (
              <div key={i} className={styles.insightItemCard} style={{ borderLeft: '3px solid #ef4444' }}
                onClick={() => setModal({ title: `HTTP ${e.code}`, icon: '🔴', type: 'error', content: e })}>
                <div className={styles.insightItemLeft}>
                  <span style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: 13, color: '#ef4444' }}>{e.code}</span>
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 13, color: '#111827' }}>{e.count} occurrences</div>
                  <div style={{ fontSize: 11.5, color: '#6b7280' }}>{(e.sample_paths || []).slice(0,1).join(', ') || '—'}</div>
                </div>
                <svg className={styles.insightItemChevron} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" strokeWidth="2.5"><polyline points="9 18 15 12 9 6"/></svg>
              </div>
            ))}
          </Section>
        )}
        {ea.patterns && <Section title="Patterns"><TextCard text={ea.patterns} accent="#ef4444" /></Section>}
        {ea.endpoint_failures?.length > 0 && (
          <Section title="Failing Endpoints">
            {ea.endpoint_failures.map((ep, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '8px 12px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, marginBottom: 6, fontSize: 12 }}>
                <span style={{ fontFamily: 'monospace', color: '#374151', flex: 1 }}>{ep.path}</span>
                <span style={{ fontFamily: 'monospace', fontWeight: 700, color: '#f59e0b', marginRight: 12 }}>{ep.dominant_code}</span>
                <span style={{ fontWeight: 700, color: '#ef4444' }}>{ep.error_count} err</span>
              </div>
            ))}
          </Section>
        )}
      </div>
    )
  }

  // ── endpoint_analysis ──
  if (topic === 'endpoint_analysis') {
    const ea = val
    return (
      <div className={styles.topicDetailWrap}>
        {ea.summary && <TextCard text={ea.summary} accent="#7c3aed" />}
        {ea.slowest?.length > 0 && (
          <Section title="Slowest Endpoints">
            {ea.slowest.map((ep, i) => {
              const col = ep.avg_ms > 1000 ? '#ef4444' : ep.avg_ms > 500 ? '#f59e0b' : '#10b981'
              return (
                <div key={i} className={styles.insightItemCard} style={{ borderLeft: `3px solid ${col}` }}
                  onClick={() => setModal({ title: 'Slow Endpoint', icon: '⚡', type: 'text',
                    content: `Path: ${ep.path}\nAvg: ${fmtDur(ep.avg_ms)}\nP95: ${fmtDur(ep.p95_ms)}\nRequests: ${ep.requests ?? '—'}` })}>
                  <div className={styles.insightItemLeft}>
                    <span className={styles.insightItemNum} style={{ background: col + '18', color: col }}>{i + 1}</span>
                  </div>
                  <p className={styles.insightItemText} style={{ fontFamily: 'monospace', fontSize: 12 }}>{ep.path}</p>
                  <div style={{ textAlign: 'right', flexShrink: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 13, color: col }}>{fmtDur(ep.avg_ms)}</div>
                    {ep.p95_ms != null && <div style={{ fontSize: 11, color: '#9ca3af' }}>p95 {fmtDur(ep.p95_ms)}</div>}
                  </div>
                </div>
              )
            })}
          </Section>
        )}
        {ea.most_error_prone?.length > 0 && (
          <Section title="Most Error-Prone Endpoints">
            {ea.most_error_prone.map((ep, i) => (
              <div key={i} className={styles.insightItemCard} style={{ borderLeft: '3px solid #ef4444' }}
                onClick={() => setModal({ title: 'Error-Prone Endpoint', icon: '⚠', type: 'text',
                  content: `Path: ${ep.path}\nError Rate: ${ep.error_rate_pct}%\nErrors: ${ep.errors} / ${ep.total} requests` })}>
                <div className={styles.insightItemLeft}>
                  <span className={styles.insightItemNum} style={{ background: '#fef2f2', color: '#ef4444' }}>{i + 1}</span>
                </div>
                <p className={styles.insightItemText} style={{ fontFamily: 'monospace', fontSize: 12 }}>{ep.path}</p>
                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 13, color: '#ef4444' }}>{ep.error_rate_pct}%</div>
                  <div style={{ fontSize: 11, color: '#9ca3af' }}>{ep.errors}/{ep.total}</div>
                </div>
              </div>
            ))}
          </Section>
        )}
      </div>
    )
  }

  // ── correlation_analysis ──
  if (topic === 'correlation_analysis') {
    const ca = val
    return (
      <div className={styles.topicDetailWrap}>
        {ca.summary && <TextCard text={ca.summary} accent="#6366f1" />}
        {ca.findings?.length > 0 && (
          <Section title={`Findings (${ca.findings.length})`}>
            {ca.findings.map((f, i) => (
              <InsightItemCard key={i} text={f} index={i} accentColor="#6366f1"
                onExpand={text => setModal({ title: 'Correlation Finding', icon: '🔗', type: 'text', content: text })} />
            ))}
          </Section>
        )}
      </div>
    )
  }

  // ── root_cause ──
  if (topic === 'root_cause') {
    const rc = val
    return (
      <div className={styles.topicDetailWrap}>
        <div style={{ background: '#fff', border: '1.5px solid #e5e7eb', borderRadius: 12, padding: '16px 18px', marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>Primary Issue</div>
              <p style={{ fontSize: 14, fontWeight: 600, color: '#111827', margin: 0, lineHeight: 1.5 }}>{rc.primary_issue}</p>
            </div>
            {rc.category && <CatBadge cat={rc.category} />}
          </div>
        </div>
        {rc.evidence?.length > 0 && (
          <Section title="Supporting Evidence">
            {rc.evidence.map((ev, i) => (
              <InsightItemCard key={i} text={ev} index={i} accentColor="#dc2626"
                onExpand={text => setModal({ title: 'Evidence', icon: '🎯', type: 'text', content: text })} />
            ))}
          </Section>
        )}
        {rc.affected_services?.length > 0 && (
          <Section title="Affected Services">
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {rc.affected_services.map((s, i) => (
                <span key={i} style={{ fontSize: 12, padding: '3px 10px', background: '#fef2f2',
                  color: '#dc2626', borderRadius: 99, fontWeight: 600, border: '1px solid #fecaca' }}>{s}</span>
              ))}
            </div>
          </Section>
        )}
      </div>
    )
  }

  // ── top_issues ──
  if (topic === 'top_issues') {
    return (
      <div className={styles.topicDetailWrap}>
        <div className={styles.insightCardList}>
          {val.map((issue, i) => (
            <InsightItemCard key={i} text={issue} index={i} accentColor="#f59e0b"
              onExpand={text => setModal({
                title: 'Issue', icon: '⚠', type: 'text', content: text,
                nav: {
                  index: i, total: val.length,
                  hasPrev: i > 0, hasNext: i < val.length - 1,
                  prev: () => setModal(m => ({ ...m, content: val[i-1], nav: { ...m.nav, index: i-1, hasPrev: i-1>0, hasNext: true, prev: m.nav.prev, next: m.nav.next } })),
                  next: () => setModal(m => ({ ...m, content: val[i+1], nav: { ...m.nav, index: i+1, hasPrev: true, hasNext: i+1<val.length-1, prev: m.nav.prev, next: m.nav.next } })),
                }
              })} />
          ))}
        </div>
      </div>
    )
  }

  // ── recommendations ──
  if (topic === 'recommendations') {
    return (
      <div className={styles.topicDetailWrap}>
        <div className={styles.insightCardList}>
          {val.map((rec, i) => (
            <InsightItemCard key={i} text={rec} index={i} accentColor="#10b981"
              onExpand={text => setModal({
                title: 'Recommendation', icon: '✅', type: 'text', content: text,
                nav: {
                  index: i, total: val.length,
                  hasPrev: i > 0, hasNext: i < val.length - 1,
                  prev: () => setModal(m => ({ ...m, content: val[i-1], nav: { ...m.nav, index: i-1, hasPrev: i-1>0, hasNext: true, prev: m.nav.prev, next: m.nav.next } })),
                  next: () => setModal(m => ({ ...m, content: val[i+1], nav: { ...m.nav, index: i+1, hasPrev: true, hasNext: i+1<val.length-1, prev: m.nav.prev, next: m.nav.next } })),
                }
              })} />
          ))}
        </div>
      </div>
    )
  }

  // ── security_observations ──
  if (topic === 'security_observations') {
    return (
      <div className={styles.topicDetailWrap}>
        <TextCard text={typeof val === 'string' ? val : JSON.stringify(val, null, 2)} accent="#6366f1" />
      </div>
    )
  }

  return <div style={{ color: '#9ca3af', padding: 24 }}>No renderer for this topic.</div>
}

// ─── App Detail Page ──────────────────────────────────────────────────────────

function InsightBlock({ title, children }) {
  return (
    <div className={styles.insightSection}>
      <h3 className={styles.insightTitle}>{title}</h3>
      {children}
    </div>
  )
}

function parseSeverity(text) {
  if (/^CRITICAL:/i.test(text)) return { level: 'CRITICAL', color: '#ef4444', bg: '#fef2f2', border: '#fca5a5' }
  if (/^HIGH:/i.test(text))     return { level: 'HIGH',     color: '#f97316', bg: '#fff7ed', border: '#fdba74' }
  if (/^MEDIUM:/i.test(text))   return { level: 'MEDIUM',   color: '#f59e0b', bg: '#fffbeb', border: '#fcd34d' }
  if (/^LOW:/i.test(text))      return { level: 'LOW',      color: '#3b82f6', bg: '#eff6ff', border: '#93c5fd' }
  return null
}

function InsightItemCard({ text, index, accentColor = '#7c3aed', onExpand }) {
  const sev = parseSeverity(text)
  return (
    <div className={styles.insightItemCard} onClick={() => onExpand(text)}
      style={{ borderLeft: `3px solid ${sev ? sev.color : accentColor}` }}>
      <div className={styles.insightItemLeft}>
        {sev ? (
          <span className={styles.sevBadge} style={{ color: sev.color, background: sev.bg, borderColor: sev.border }}>
            {sev.level}
          </span>
        ) : (
          <span className={styles.insightItemNum} style={{ background: accentColor + '18', color: accentColor }}>
            {index + 1}
          </span>
        )}
      </div>
      <p className={styles.insightItemText}>{text}</p>
      <svg className={styles.insightItemChevron} width="14" height="14" viewBox="0 0 24 24"
        fill="none" stroke="#9ca3af" strokeWidth="2.5">
        <polyline points="9 18 15 12 9 6" />
      </svg>
    </div>
  )
}

function InsightModal({ modal, onClose }) {
  if (!modal) return null
  // Close on Escape
  return (
    <div className={styles.modalOverlay} onClick={onClose}>
      <div className={styles.modalCard} onClick={e => e.stopPropagation()}>
        <div className={styles.modalHeader}>
          <div className={styles.modalHeaderLeft}>
            <span className={styles.modalIcon}>{modal.icon}</span>
            <span className={styles.modalTitle}>{modal.title}</span>
          </div>
          <button className={styles.modalClose} onClick={onClose}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        <div className={styles.modalBody}>
          {modal.type === 'text' && (
            <>
              {parseSeverity(modal.content) && (() => {
                const sev = parseSeverity(modal.content)
                return (
                  <span className={styles.modalSevBadge}
                    style={{ color: sev.color, background: sev.bg, borderColor: sev.border }}>
                    {sev.level}
                  </span>
                )
              })()}
              <p className={styles.modalText}>{modal.content}</p>
            </>
          )}

          {modal.type === 'error' && (
            <div className={styles.modalErrorCard}>
              <div className={styles.modalErrorRow}>
                <span className={styles.modalErrorCode}>{modal.content.code}</span>
                <span className={styles.modalErrorCount}>{modal.content.count} occurrences</span>
              </div>
              {modal.content.sample_paths?.length > 0 && (
                <>
                  <div className={styles.modalSubLabel}>Sample Paths</div>
                  <ul className={styles.modalPathList}>
                    {modal.content.sample_paths.map((p, i) => (
                      <li key={i} className={styles.modalPath}>{p}</li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}

          {modal.type === 'endpoint' && (
            <div className={styles.modalErrorCard}>
              <div className={styles.modalEndpointRow}>
                <span className={styles.modalPath}>{modal.content.path}</span>
                <span className={styles.modalErrorCount}
                  style={{ color: modal.content.avg_duration_ms > 1000 ? '#ef4444' : modal.content.avg_duration_ms > 500 ? '#f59e0b' : '#10b981' }}>
                  {modal.content.avg_duration_ms} ms avg
                </span>
              </div>
            </div>
          )}
        </div>

        {modal.nav && (
          <div className={styles.modalFooter}>
            <button className={styles.modalNavBtn} onClick={modal.nav.prev} disabled={!modal.nav.hasPrev}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="15 18 9 12 15 6"/></svg>
              Previous
            </button>
            <span className={styles.modalNavCount}>{modal.nav.index + 1} / {modal.nav.total}</span>
            <button className={styles.modalNavBtn} onClick={modal.nav.next} disabled={!modal.nav.hasNext}>
              Next
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="9 18 15 12 9 6"/></svg>
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function TrendArrow({ curr, prev, lowerIsBetter = false }) {
  if (curr == null || prev == null || prev === 0) return null
  const pct  = ((curr - prev) / prev) * 100
  const up   = pct >= 0
  const good = lowerIsBetter ? !up : up
  const col  = Math.abs(pct) < 1 ? '#9ca3af' : good ? '#10b981' : '#ef4444'
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 12, fontWeight: 600, color: col }}>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={col} strokeWidth="2.5">
        {up ? <polyline points="18 15 12 9 6 15" /> : <polyline points="6 9 12 15 18 9" />}
      </svg>
      {Math.abs(pct).toFixed(1)}%
    </span>
  )
}

// ─── Decorative background blobs for glassmorphism ──────────────────────────
function BackgroundBlobs() {
  return (
    <div style={{ position: 'fixed', inset: 0, overflow: 'hidden', pointerEvents: 'none', zIndex: 0 }}>
      <div style={{ position: 'absolute', width: 600, height: 600, borderRadius: '50%',
        background: 'radial-gradient(circle, rgba(251,191,36,0.4) 0%, transparent 70%)',
        top: '-5%', left: '-8%' }} />
      <div style={{ position: 'absolute', width: 500, height: 500, borderRadius: '50%',
        background: 'radial-gradient(circle, rgba(251,146,60,0.3) 0%, transparent 70%)',
        top: '18%', right: '-6%' }} />
      <div style={{ position: 'absolute', width: 550, height: 450, borderRadius: '50%',
        background: 'radial-gradient(circle, rgba(167,139,250,0.28) 0%, transparent 70%)',
        top: '55%', left: '15%' }} />
      <div style={{ position: 'absolute', width: 450, height: 450, borderRadius: '50%',
        background: 'radial-gradient(circle, rgba(52,211,153,0.32) 0%, transparent 70%)',
        bottom: '-5%', right: '10%' }} />
      <div style={{ position: 'absolute', width: 400, height: 350, borderRadius: '50%',
        background: 'radial-gradient(circle, rgba(56,189,248,0.22) 0%, transparent 70%)',
        top: '35%', left: '50%' }} />
      <div style={{ position: 'absolute', width: 350, height: 500, borderRadius: '50%',
        background: 'radial-gradient(circle, rgba(244,114,182,0.22) 0%, transparent 70%)',
        bottom: '10%', left: '0%' }} />
      <div style={{ position: 'absolute', width: 300, height: 300, borderRadius: '50%',
        background: 'radial-gradient(circle, rgba(234,179,8,0.28) 0%, transparent 70%)',
        top: '5%', left: '60%' }} />
    </div>
  )
}

// ─── OpsPulse chart primitives ────────────────────────────────────────────────

function OpsBarChart({ data, color = '#34d399', height = 60 }) {
  const W = 400, H = height
  if (!data || data.length === 0) {
    return <svg width="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ display: 'block' }} />
  }
  const max = Math.max(...data, 0.01)
  const barW = W / data.length - 2
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ display: 'block' }}>
      <defs>
        <linearGradient id={`opsbar-${color.replace('#','')}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.9" />
          <stop offset="100%" stopColor={color} stopOpacity="0.4" />
        </linearGradient>
      </defs>
      {data.map((v, i) => {
        const bh = Math.max(2, (v / max) * (H - 4))
        return <rect key={i} x={i * (W / data.length) + 1} y={H - bh} width={barW} height={bh}
          fill={`url(#opsbar-${color.replace('#','')})`} rx={2} />
      })}
    </svg>
  )
}

function OpsAreaLine({ data, stroke = '#fbbf24', fill = 'rgba(251, 191, 36, 0.15)', height = 60 }) {
  const W = 400, H = height
  if (!data || data.length < 2) {
    return <svg width="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ display: 'block' }} />
  }
  const max = Math.max(...data, 0.01)
  const min = Math.min(...data, 0)
  const range = max - min || 1
  const pts = data.map((v, i) => [
    (i / (data.length - 1)) * W,
    H - 4 - ((v - min) / range) * (H - 8),
  ])
  const path = catmullRom(pts)
  const area = `${path} L ${W},${H} L 0,${H} Z`
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ display: 'block' }}>
      <path d={area} fill={fill} />
      <path d={path} fill="none" stroke={stroke} strokeWidth={2} strokeLinecap="round" />
    </svg>
  )
}

function OpsMultiLine({ series, height = 140, showGrid = true }) {
  const W = 600, H = height
  const PAD = { t: 10, r: 10, b: 22, l: 36 }
  const plotW = W - PAD.l - PAD.r
  const plotH = H - PAD.t - PAD.b
  if (!series || !series.length || !series[0].data || series[0].data.length < 2) {
    return <svg width="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ display: 'block' }} />
  }
  const allVals = series.flatMap(s => s.data)
  const max = Math.max(...allVals, 0.01)
  const min = Math.min(...allVals, 0)
  const range = max - min || 1
  const n = series[0].data.length
  const xOf = i => PAD.l + (i / (n - 1)) * plotW
  const yOf = v => PAD.t + plotH - ((v - min) / range) * plotH
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ display: 'block' }}>
      {showGrid && [0, 0.5, 1].map(t => (
        <line key={t} x1={PAD.l} x2={W - PAD.r} y1={PAD.t + plotH * t} y2={PAD.t + plotH * t}
          stroke="rgba(0,0,0,0.05)" strokeDasharray="3 3" />
      ))}
      {[0, 0.5, 1].map(t => (
        <text key={t} x={PAD.l - 6} y={PAD.t + plotH * t + 3} fontSize="8" fill="#94a3b8" textAnchor="end">
          {((max - range * t) | 0)}{max > 1 ? '' : '%'}
        </text>
      ))}
      {series.map((s, si) => {
        const pts = s.data.map((v, i) => [xOf(i), yOf(v)])
        return (
          <g key={si}>
            {s.area && <path d={`${catmullRom(pts)} L ${pts[pts.length-1][0]},${PAD.t + plotH} L ${pts[0][0]},${PAD.t + plotH} Z`}
              fill={s.areaFill || 'rgba(52, 211, 153, 0.12)'} />}
            <path d={catmullRom(pts)} fill="none" stroke={s.color} strokeWidth={2} strokeLinecap="round" />
          </g>
        )
      })}
    </svg>
  )
}

function OpsGauge({ value = 94, size = 150 }) {
  const thick = 14
  const pad   = thick / 2 + 4
  const cx    = size / 2
  const cy    = size / 2
  const r     = (size - 2 * pad) / 2

  // Angle: 0° = top, clockwise
  const polar = (ang) => {
    const rad = (ang - 90) * Math.PI / 180
    return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)]
  }
  const arcPath = (start, end) => {
    const [x1, y1] = polar(start)
    const [x2, y2] = polar(end)
    const large = end - start > 180 ? 1 : 0
    return `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2}`
  }

  // 270° arc from 225° (bottom-left) clockwise to 495° (=135°, bottom-right),
  // split into 4 segments with small gaps
  const start  = 225
  const total  = 270
  const gap    = 4
  const seg    = (total - 3 * gap) / 4
  const segs = [
    { color: '#22c55e' }, // green
    { color: '#facc15' }, // yellow
    { color: '#86efac' }, // light green
    { color: '#93c5fd' }, // light blue
  ]

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      {segs.map((s, i) => {
        const segStart = start + i * (seg + gap)
        const segEnd   = segStart + seg
        return <path key={i} d={arcPath(segStart, segEnd)}
          fill="none" stroke={s.color} strokeWidth={thick} strokeLinecap="round" />
      })}
      <text x={cx} y={cy - 2} textAnchor="middle" dominantBaseline="central"
        fontSize={size * 0.22} fontWeight="700" fill="#111827" fontFamily="Inter, sans-serif">{value}%</text>
      <text x={cx} y={cy + size * 0.15} textAnchor="middle" dominantBaseline="central"
        fontSize={size * 0.09} fontWeight="600" fill="#22c55e" fontFamily="Inter, sans-serif">Healthy</text>
    </svg>
  )
}

function Sparkline({ data, color = '#94a3b8', height = 16, width = 42 }) {
  if (!data || data.length < 2) {
    return <svg width={width} height={height} style={{ display: 'block' }} />
  }
  const max = Math.max(...data, 0.01)
  const min = Math.min(...data, 0)
  const range = max - min || 1
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * width},${height - ((v - min) / range) * height}`).join(' ')
  return (
    <svg width={width} height={height} style={{ display: 'block' }}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// ─── OpsPulse dummy data ──────────────────────────────────────────────────────

const OPS_REQ_VOLUME   = []
const OPS_ERROR_RATE   = []
const OPS_SPARK_UP     = []
const OPS_SPARK_DOWN   = []
const OPS_P95_PRIMARY  = []
const OPS_P95_SECOND   = []
const OPS_ERR_COUNT    = []
const OPS_APIFAIL_BAR1 = []
const OPS_APIFAIL_BAR2 = []
const OPS_BOTTOM_BAR   = []

function AppDetailPage({ tenant, app, onBack, initialEnv = null, initialSection = null }) {
  const [dateRange, setDateRange] = useState({
    start: new Date(Date.now() - 24 * 60 * 60 * 1000),
    end: new Date(),
    label: 'Last 24 hours',
  })
  const [insights, setInsights] = useState(null)
  const [envBreakdown, setEnvBreakdown] = useState([])
  const [envFilter, setEnvFilter] = useState(initialEnv || 'all')
  const initialEnvAppliedRef = useRef(false)
  const [rangeTs, setRangeTs] = useState(null)  // timeseries filtered by dateRange from /api/timeseries
  const [wfRange, setWfRange] = useState(null)  // {total, failed, success} from workflow_executions filtered by dateRange
  const [activeTab, setActiveTab] = useState(initialSection === 'workflow' ? 'workflow' : 'overview')
  const apiFailuresRef = useRef(null)
  const p95LatencyRef = useRef(null)
  const errorRateRef = useRef(null)
  const initialSectionAppliedRef = useRef(false)
  const [chartViews, setChartViews] = useState({ requests: 'chart', errors: 'chart', p95: 'chart', errRate: 'chart' })
  const setChartView = (key, view) => setChartViews(s => ({ ...s, [key]: view }))
  const [errorModal, setErrorModal] = useState(null) // { start, end, label, loading, data, error }

  useEffect(() => {
    if (!tenant?.name || !app?.name) return
    // When a dateRange is set, fetch every app_insights doc in that window so
    // aggregateMetrics can sum across them. Without a range we just pull the
    // most recent docs (limit=20) for the snapshot view.
    const qs = new URLSearchParams()
    if (dateRange?.start && dateRange?.end) {
      qs.set('start', dateRange.start.toISOString())
      qs.set('end',   dateRange.end.toISOString())
    }
    const url = `${API}/api/insights/${encodeURIComponent(tenant.name)}/apps/${encodeURIComponent(app.name)}${qs.toString() ? '?' + qs.toString() : ''}`
    fetch(url)
      .then(r => r.ok ? r.json() : [])
      .then(docs => {
        if (!Array.isArray(docs)) return
        setInsights(docs[0]?.insights || null)
        // Pass the full doc list straight through. `filteredDocs` filters by
        // env, then `aggregateMetrics` sums across all docs for that env in
        // the date range. `envOptions` dedupes via Set so multiple docs per
        // env are fine. Empty array → all metrics roll up to zero.
        setEnvBreakdown(docs)
      })
      .catch(() => {})
  }, [tenant?.name, app?.name, dateRange?.start?.getTime(), dateRange?.end?.getTime()])

  // ── Aggregate / pick metrics + authority based on selected env ──
  const aggregateMetrics = (docs) => {
    if (!docs.length) return null
    if (docs.length === 1) return docs[0].metrics || {}
    const out = {
      total_requests:   0,
      error_4xx_count:  0,
      error_5xx_count:  0,
      latency_ms:  { avg: 0, p50: 0, p95: 0, p99: 0, max: 0 },
      workflow:    { total_requests: 0, error_count: 0, success_count: 0, error_rate_pct: 0,
                     latency_ms: { avg: 0, p95: 0 }, steps: [] },
      pod_stats:   [],
      timeseries:  [],
      health_score: null,
    }
    let avgW = 0, wfAvgW = 0
    let healthSum = 0, healthN = 0
    const tsMap = {}
    for (const d of docs) {
      const mm = d.metrics || {}
      const req = Number(mm.total_requests) || 0
      out.total_requests   += req
      out.error_4xx_count  += Number(mm.error_4xx_count) || 0
      out.error_5xx_count  += Number(mm.error_5xx_count) || 0
      const lat = mm.latency_ms || {}
      if (req > 0 && lat.avg != null) { out.latency_ms.avg += Number(lat.avg) * req; avgW += req }
      out.latency_ms.p50 = Math.max(out.latency_ms.p50, Number(lat.p50) || 0)
      out.latency_ms.p95 = Math.max(out.latency_ms.p95, Number(lat.p95) || 0)
      out.latency_ms.p99 = Math.max(out.latency_ms.p99, Number(lat.p99) || 0)
      out.latency_ms.max = Math.max(out.latency_ms.max, Number(lat.max) || 0)
      const wf = mm.workflow || {}
      const wfReq = Number(wf.total_requests) || 0
      out.workflow.total_requests += wfReq
      out.workflow.error_count    += Number(wf.error_count)    || 0
      out.workflow.success_count  += Number(wf.success_count)  || 0
      const wfLat = wf.latency_ms || {}
      if (wfReq > 0 && wfLat.avg != null) { out.workflow.latency_ms.avg += Number(wfLat.avg) * wfReq; wfAvgW += wfReq }
      out.workflow.latency_ms.p95 = Math.max(out.workflow.latency_ms.p95, Number(wfLat.p95) || 0)
      if (Array.isArray(wf.steps) && out.workflow.steps.length === 0) out.workflow.steps = wf.steps
      if (Array.isArray(mm.pod_stats)) out.pod_stats.push(...mm.pod_stats)
      if (mm.health_score != null) { healthSum += Number(mm.health_score); healthN += 1 }
      for (const p of (mm.timeseries || [])) {
        const k = p.ts; if (!k) continue
        if (!tsMap[k]) tsMap[k] = { ts: k, requests: 0, errors: 0, _avg: 0, _w: 0, p95_latency_ms: 0 }
        const e = tsMap[k]
        const r = Number(p.requests) || 0
        e.requests += r
        e.errors   += Number(p.errors) || 0
        if (p.avg_latency_ms != null) { e._avg += Number(p.avg_latency_ms) * r; e._w += r }
        e.p95_latency_ms = Math.max(e.p95_latency_ms, Number(p.p95_latency_ms) || 0)
      }
    }
    out.latency_ms.avg          = avgW   ? out.latency_ms.avg / avgW : 0
    out.workflow.latency_ms.avg = wfAvgW ? out.workflow.latency_ms.avg / wfAvgW : 0
    out.error_rate_pct = out.total_requests
      ? ((out.error_4xx_count + out.error_5xx_count) / out.total_requests) * 100
      : 0
    out.workflow.error_rate_pct = out.workflow.total_requests
      ? (out.workflow.error_count / out.workflow.total_requests) * 100
      : 0
    if (healthN) out.health_score = Math.round(healthSum / healthN)
    out.timeseries = Object.values(tsMap)
      .map(e => ({ ts: e.ts, requests: e.requests, errors: e.errors,
        avg_latency_ms: e._w ? e._avg / e._w : 0,
        p95_latency_ms: e.p95_latency_ms }))
      .sort((a, b) => (a.ts < b.ts ? -1 : 1))
    return out
  }

  const envKeyOf = (raw) => {
    const e = (raw || '').toLowerCase().trim()
    if (e === 'production' || e === 'prod') return 'prod'
    if (e === 'development' || e === 'dev') return 'dev'
    if (e === 'staging' || e === 'stage')   return 'stage'
    return e || 'unknown'
  }
  const ENV_LABEL = { prod: 'Production', dev: 'Development', uat: 'UAT', qa: 'QA', stage: 'Stage', demo: 'Demo' }

  const envOptions = useMemo(() => {
    const keys = envBreakdown.map(d => envKeyOf(d.environment))
    const unique = Array.from(new Set(keys))
    const opts = unique.length > 1 ? [{ key: 'all', label: 'All' }] : []
    for (const k of unique) opts.push({ key: k, label: ENV_LABEL[k] || k })
    return opts
  }, [envBreakdown])

  // Once envOptions are known, prefer the deep-link env if it exists in the data;
  // otherwise fall back to the first option ('all' when there are 2+, else the
  // single available env).
  useEffect(() => {
    if (!envOptions.length) return
    if (!initialEnvAppliedRef.current && initialEnv &&
        envOptions.some(o => o.key === initialEnv)) {
      initialEnvAppliedRef.current = true
      setEnvFilter(initialEnv)
      return
    }
    if (!envOptions.some(o => o.key === envFilter)) setEnvFilter(envOptions[0].key)
  }, [envOptions, envFilter, initialEnv])

  // Deep-link scroll: once the overview is rendered with data, scroll to the
  // section matching initialSection. Workflow tab is handled via initial state.
  useEffect(() => {
    if (initialSectionAppliedRef.current) return
    if (!initialSection || initialSection === 'workflow') return
    if (activeTab !== 'overview') return
    if (!envBreakdown.length) return
    const refMap = {
      'api-failures': apiFailuresRef,
      'p95-latency':  p95LatencyRef,
      'error-rate':   errorRateRef,
    }
    const target = refMap[initialSection]?.current
    if (!target) return
    initialSectionAppliedRef.current = true
    requestAnimationFrame(() => {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  }, [initialSection, activeTab, envBreakdown])

  const filteredDocs = useMemo(() => {
    if (envFilter === 'all') return envBreakdown
    return envBreakdown.filter(d => envKeyOf(d.environment) === envFilter)
  }, [envBreakdown, envFilter])

  const metrics  = useMemo(() => aggregateMetrics(filteredDocs), [filteredDocs])
  const authority = filteredDocs[0]?.authority || null
  // inst_id (appId) is the accurate filter key — matches what the Lambda
  // batch uses. Authority is kept as a fallback for older docs / no-inst_id
  // cases. Both are passed; the backend prefers inst_id when present.
  const instId = filteredDocs[0]?.inst_id || null

  // Re-fetch timeseries when dateRange or authority changes
  useEffect(() => {
    if (!tenant?.name || !authority || !dateRange?.start || !dateRange?.end) return
    const params = {
      authority,
      start: dateRange.start.toISOString(),
      end: dateRange.end.toISOString(),
    }
    if (instId) params.inst_id = instId
    const qs = new URLSearchParams(params).toString()
    fetch(`${API}/api/timeseries/${encodeURIComponent(tenant.name)}/app?${qs}`)
      .then(r => r.ok ? r.json() : null)
      .then(json => setRangeTs(json?.data || []))
      .catch(() => setRangeTs([]))
  }, [tenant?.name, authority, instId, dateRange?.start?.getTime(), dateRange?.end?.getTime()])

  // Re-fetch workflow counts (from workflow_executions) when dateRange changes.
  // The /executions endpoint already supports start/end filtering and counts
  // by status — same source the Tenant & Apps page uses for "Failed".
  useEffect(() => {
    if (!tenant?.name || !app?.name || !dateRange?.start || !dateRange?.end) return
    const qs = new URLSearchParams({
      limit: '1',
      offset: '0',
      start: dateRange.start.toISOString(),
      end: dateRange.end.toISOString(),
    }).toString()
    fetch(`${API}/api/insights/${encodeURIComponent(tenant.name)}/apps/${encodeURIComponent(app.name)}/executions?${qs}`)
      .then(r => r.ok ? r.json() : null)
      .then(json => {
        if (!json) return setWfRange({ total: 0, failed: 0, success: 0 })
        const total = json.totalSize || 0
        const failed = json.failed || 0
        const running = json.running || 0
        const success = Math.max(0, total - failed - running)
        setWfRange({ total, failed, success, running })
      })
      .catch(() => setWfRange({ total: 0, failed: 0, success: 0 }))
  }, [tenant?.name, app?.name, dateRange?.start?.getTime(), dateRange?.end?.getTime()])

  const openErrorModal = (idx) => {
    const point = ts[idx]
    if (!point?.ts) return
    const startIso = new Date(point.ts).toISOString()
    // End = next bucket start, or infer step from prior bucket
    let endIso
    if (ts[idx + 1]?.ts) endIso = new Date(ts[idx + 1].ts).toISOString()
    else if (ts[idx - 1]?.ts) {
      const step = new Date(point.ts).getTime() - new Date(ts[idx - 1].ts).getTime()
      endIso = new Date(new Date(point.ts).getTime() + step).toISOString()
    } else {
      endIso = new Date(new Date(point.ts).getTime() + 60 * 60 * 1000).toISOString()
    }
    const label = xLabels[idx] || startIso
    setErrorModal({ start: startIso, end: endIso, label, loading: true, data: null, error: null })
    if (!authority) {
      setErrorModal({ start: startIso, end: endIso, label, loading: false, data: null, error: 'App authority not available — cannot fetch error samples.' })
      return
    }
    const params = { authority, start: startIso, end: endIso, size: '50' }
    if (instId) params.inst_id = instId
    const qs = new URLSearchParams(params).toString()
    fetch(`${API}/api/timeseries/${encodeURIComponent(tenant.name)}/app/errors?${qs}`)
      .then(r => r.ok ? r.json() : r.json().then(j => Promise.reject(j.detail || `HTTP ${r.status}`)))
      .then(data => setErrorModal(s => s ? { ...s, loading: false, data } : null))
      .catch(err => setErrorModal(s => s ? { ...s, loading: false, error: typeof err === 'string' ? err : 'Failed to load errors' } : null))
  }

  const m = metrics || {}
  const dash = '—'
  const fmt = v => (v == null ? dash : typeof v === 'number' ? v.toLocaleString() : v)
  const pct = v => (v == null ? dash : `${Number(v).toFixed(2)}%`)
  const ms = v => {
    if (v == null) return dash
    const n = Number(v)
    if (!isFinite(n)) return dash
    if (n < 1000)   return `${Math.round(n)}ms`
    if (n < 60000)  return `${(n / 1000).toFixed(n < 10000 ? 2 : 1)}s`
    if (n < 3600000) {
      const m = Math.floor(n / 60000)
      const s = Math.round((n % 60000) / 1000)
      return s ? `${m}m ${s}s` : `${m}m`
    }
    const h = Math.floor(n / 3600000)
    const mm = Math.round((n % 3600000) / 60000)
    return mm ? `${h}h ${mm}m` : `${h}h`
  }

  // ── Derived metric values ──
  // Totals come from the cached `app_insights` docs aggregated across the
  // selected dateRange (in `m`, computed by aggregateMetrics). The Lambda
  // analyzer queries OpenSearch by `appId` (inst_id) so its counts catch
  // traffic the live timeseries — which filters by `authority` — sometimes
  // misses (e.g. axosclearing's 74 reqs/52 5xx for a 7-day window where the
  // authority query returns 0). Fall back to the live timeseries sum only
  // when the cache has no data for the window (uncommon).
  const sumBy = (arr, key) => arr.reduce((s, x) => s + (x[key] || 0), 0)
  const rangeReqs = Array.isArray(rangeTs) ? sumBy(rangeTs, 'requests') : 0
  const rangeReady = Array.isArray(rangeTs)

  const cachedReq = m.total_requests ?? 0
  const cachedHas = cachedReq > 0
  const total4xx   = cachedHas ? (m.error_4xx_count ?? 0) : (rangeReady ? sumBy(rangeTs, 'errors_4xx') : null)
  const total5xx   = cachedHas ? (m.error_5xx_count ?? 0) : (rangeReady ? sumBy(rangeTs, 'errors_5xx') : null)
  const totalReq   = cachedHas ? cachedReq                : (rangeReady ? rangeReqs : null)
  const errRate    = totalReq && totalReq > 0
    ? ((Number(total4xx || 0) + Number(total5xx || 0)) / totalReq) * 100
    : (cachedHas ? (m.error_rate_pct ?? 0) : 0)
  const useRange = rangeReady && rangeReqs > 0  // chart still uses range buckets when it has them
  const p95Latency = m.latency_ms?.p95  // not available per-bucket from /api/timeseries
  const wf         = m.workflow || {}
  // Workflow counts come from workflow_executions (date-range-filtered)
  // when available — that source is authoritative and matches the Tenant
  // & Apps page. Fall back to the cached HTTP-path metric only while the
  // range fetch is in flight.
  // HTTP requests on /workflow* paths — not the same as workflow executions
  // (Temporal-level events). The "Workflow executions" card on the AppCard
  // and the Workflow Analysis tab use the OpenSearch correlationId count.
  const wfTotal = wf?.total_requests || 0
  const healthScore = (() => {
    if (errRate == null) return null
    if (errRate <= 1)  return Math.round(95 - errRate * 5)
    if (errRate <= 5)  return Math.round(80 - errRate * 4)
    if (errRate <= 15) return Math.round(65 - errRate * 2)
    return Math.max(5, Math.round(40 - errRate))
  })()

  // ts normalized shape: { ts, requests, errors, avg_latency_ms, p95_latency_ms, error_samples? }
  const ts = useRange
    ? rangeTs.map(p => ({
        ts: p.timestamp,
        requests: p.requests || 0,
        errors: (p.errors_4xx || 0) + (p.errors_5xx || 0),
        avg_latency_ms: p.avg_latency_ms,
        p95_latency_ms: null,
      }))
    : (Array.isArray(m.timeseries) ? m.timeseries : [])
  const tsRequests = ts.map(p => p.requests || 0)
  const tsErrors   = ts.map(p => p.errors || 0)
  const tsErrRate  = ts.map(p => (p.requests ? (p.errors / p.requests) * 100 : 0))
  const tsP95      = ts.map(p => p.p95_latency_ms || 0)
  const tsAvgLat   = ts.map(p => p.avg_latency_ms || 0)

  // ── Style primitives (Workflow Analysis theme) ──
  const bgGradient = '#f0f3f9'
  const glassCard = {
    background: '#ffffff',
    border: '1px solid #e9ecef',
    boxShadow: '0 1px 6px rgba(0, 0, 0, 0.06)',
    borderRadius: 16,
  }
  const pillStyle = (bg, color) => ({
    display: 'inline-flex', alignItems: 'center', gap: 5,
    padding: '4px 10px', borderRadius: 999, fontSize: 11, fontWeight: 600,
    background: bg, color,
  })

  const StatusPill = ({ label, icon, bg = '#dcfce7', color = '#16a34a' }) => (
    <span style={{ ...pillStyle(bg, color), border: `1px solid ${color}20` }}>
      <span style={{ fontSize: 11 }}>{icon}</span>{label}
    </span>
  )

  const CardMenu = () => (
    <span style={{ color: '#cbd5e1', fontSize: 18, cursor: 'pointer', letterSpacing: 1 }}>⋯</span>
  )

  // ── Helpers for the new design ──
  const deltaText = '↑ 2.15%'
  const Arrow = ({ dir = 'up', color }) => (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'inline-block' }}>
      {dir === 'up' ? <polyline points="6 15 12 9 18 15" /> : <polyline points="6 9 12 15 18 9" />}
    </svg>
  )
  const ArrowRightBtn = ({ onClick, title }) => (
    <button
      type="button"
      onClick={onClick}
      title={title}
      style={{ width: 34, height: 34, borderRadius: 10, border: '1px solid #e5e7eb', background: '#fff', cursor: onClick ? 'pointer' : 'default', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, transition: 'background 0.15s, border-color 0.15s' }}
      onMouseEnter={e => { if (onClick) { e.currentTarget.style.background = '#f9fafb'; e.currentTarget.style.borderColor = '#d1d5db' } }}
      onMouseLeave={e => { e.currentTarget.style.background = '#fff'; e.currentTarget.style.borderColor = '#e5e7eb' }}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#374151" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>
      </svg>
    </button>
  )
  const ChartListToggle = ({ view, setView }) => (
    <div style={{ display: 'flex', gap: 4, padding: 3, background: '#f3f4f6', borderRadius: 8 }}>
      <button
        type="button"
        onClick={() => setView('chart')}
        title="Chart view"
        style={{ padding: '4px 8px', background: view === 'chart' ? '#fff' : 'transparent', borderRadius: 6, boxShadow: view === 'chart' ? '0 1px 2px rgba(0,0,0,0.05)' : 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center' }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={view === 'chart' ? '#374151' : '#9ca3af'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 17 9 11 13 15 21 7"/></svg>
      </button>
      <button
        type="button"
        onClick={() => setView('list')}
        title="List view"
        style={{ padding: '4px 8px', background: view === 'list' ? '#fff' : 'transparent', borderRadius: 6, boxShadow: view === 'list' ? '0 1px 2px rgba(0,0,0,0.05)' : 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center' }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={view === 'list' ? '#374151' : '#9ca3af'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
      </button>
    </div>
  )

  // Line chart with hover tooltip (supports multiple series)
  const DualLineChart = ({ primary, secondary, primaryColor, secondaryColor = '#d1d5db', height = 220, primaryLabel = 'Value', secondaryLabel = '', xLabels = [], valueFormatter = v => v, errorsAt = [], onPointClick = null }) => {
    const [hoverIdx, setHoverIdx] = useState(null)
    const svgRef = useRef(null)

    const W = 600, H = height
    const PAD = { t: 14, r: 14, b: 30, l: 24 }
    const plotW = W - PAD.l - PAD.r
    const plotH = H - PAD.t - PAD.b
    const all = [...primary, ...secondary]

    if (!primary.length || primary.length < 2) {
      return (
        <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: 'block' }}>
          <text x={W/2} y={H/2} textAnchor="middle" fontSize="12" fill="#9ca3af">No data</text>
        </svg>
      )
    }

    const max = Math.max(...all, 1)
    const min = 0
    const range = max - min || 1
    const n = primary.length
    const xOf = i => PAD.l + (i / (n - 1)) * plotW
    const yOf = v => PAD.t + plotH - ((v - min) / range) * plotH
    const ptsOf = arr => arr.map((v, i) => [xOf(i), yOf(v)])
    const p1 = ptsOf(primary)
    const p2 = secondary.length >= 2 ? ptsOf(secondary.slice(0, n)) : []
    const d1 = catmullRom(p1)
    const area1 = `${d1} L ${p1[p1.length-1][0]},${PAD.t + plotH} L ${p1[0][0]},${PAD.t + plotH} Z`
    const d2 = p2.length ? catmullRom(p2) : ''

    const yTicks = [0, 1, 2, 3]

    function handleMove(e) {
      const svg = svgRef.current
      if (!svg) return
      const rect = svg.getBoundingClientRect()
      const xInSvg = ((e.clientX - rect.left) / rect.width) * W
      const rel = (xInSvg - PAD.l) / plotW
      const idx = Math.round(rel * (n - 1))
      if (idx >= 0 && idx < n) setHoverIdx(idx)
      else setHoverIdx(null)
    }

    const hoverX = hoverIdx != null ? xOf(hoverIdx) : null
    const tooltipLeft = hoverX != null ? `${(hoverX / W) * 100}%` : 0
    const flipTooltip = hoverIdx != null && hoverIdx > n * 0.7
    // A point is clickable when caller wired onPointClick AND that bucket
    // actually has a non-zero value (don't open an empty-error modal for a
    // bucket where the line is flat at zero).
    const isClickable = onPointClick != null && hoverIdx != null && primary[hoverIdx] > 0

    return (
      <div style={{ position: 'relative' }} onMouseLeave={() => setHoverIdx(null)}>
        <svg
          ref={svgRef}
          width="100%"
          viewBox={`0 0 ${W} ${H}`}
          style={{ display: 'block', cursor: isClickable ? 'pointer' : 'default' }}
          onMouseMove={handleMove}
          onClick={() => { if (isClickable) onPointClick(hoverIdx) }}
        >
          <defs>
            <linearGradient id={`gradArea-${primaryColor.replace('#','')}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={primaryColor} stopOpacity="0.30" />
              <stop offset="100%" stopColor={primaryColor} stopOpacity="0" />
            </linearGradient>
          </defs>
          {yTicks.map(t => {
            const y = PAD.t + plotH - (t / 3) * plotH
            return (
              <g key={t}>
                <line x1={PAD.l} x2={W - PAD.r} y1={y} y2={y} stroke="#e5e7eb" strokeWidth="1" />
                <text x={PAD.l - 6} y={y + 3} fontSize="10" fill="#9ca3af" textAnchor="end">{t}</text>
              </g>
            )
          })}
          {d2 && <path d={d2} fill="none" stroke={secondaryColor} strokeWidth="2" strokeLinecap="round" />}
          <path d={area1} fill={`url(#gradArea-${primaryColor.replace('#','')})`} />
          <path d={d1} fill="none" stroke={primaryColor} strokeWidth="2.5" strokeLinecap="round" />
          {p1.map(([x, y], i) => (
            <circle key={i} cx={x} cy={y} r="3.5" fill={primaryColor} stroke="#fff" strokeWidth="1.5" />
          ))}
          {/* Hover guide line + highlighted dot */}
          {hoverIdx != null && (
            <>
              <line x1={hoverX} x2={hoverX} y1={PAD.t} y2={PAD.t + plotH} stroke="#9ca3af" strokeWidth="1" strokeDasharray="3 3" />
              <circle cx={hoverX} cy={p1[hoverIdx][1]} r="5" fill={primaryColor} stroke="#fff" strokeWidth="2" />
              {p2.length > 0 && (
                <circle cx={hoverX} cy={p2[hoverIdx][1]} r="4" fill={secondaryColor} stroke="#fff" strokeWidth="2" />
              )}
            </>
          )}
        </svg>

        {/* Tooltip */}
        {hoverIdx != null && (
          <div
            style={{
              position: 'absolute',
              left: tooltipLeft,
              top: 12,
              transform: flipTooltip ? 'translateX(calc(-100% - 8px))' : 'translateX(8px)',
              background: '#111827',
              color: '#fff',
              padding: '8px 10px',
              borderRadius: 8,
              fontSize: 11,
              lineHeight: 1.5,
              whiteSpace: 'nowrap',
              pointerEvents: 'none',
              boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
              zIndex: 5,
            }}
          >
            {xLabels[hoverIdx] && (
              <div style={{ color: '#9ca3af', fontSize: 10, marginBottom: 4 }}>{xLabels[hoverIdx]}</div>
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: primaryColor, display: 'inline-block' }} />
              <span>{primaryLabel}: <strong>{valueFormatter(primary[hoverIdx])}</strong></span>
            </div>
            {p2.length > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: secondaryColor, display: 'inline-block' }} />
                <span>{secondaryLabel}: <strong>{valueFormatter(secondary[hoverIdx])}</strong></span>
              </div>
            )}
            {errorsAt[hoverIdx] != null && (
              <div style={{ color: '#fca5a5', marginTop: 2 }}>
                Errors: <strong>{errorsAt[hoverIdx]}</strong>
              </div>
            )}
            {isClickable && (
              <div style={{ color: '#9ca3af', fontSize: 10, marginTop: 4, paddingTop: 4, borderTop: '1px solid #374151' }}>
                Click to view error details
              </div>
            )}
          </div>
        )}
      </div>
    )
  }

  // List view for timeseries data (shown when list-toggle active)
  const TimeseriesList = ({ values, labels, color, valueFormatter = v => v, errorsAt = [], primaryLabel = 'Value', height = 240, onErrorClick, primaryClickable = false, onPrimaryClick }) => (
    <div style={{ maxHeight: height, overflowY: 'auto', border: '1px solid #f3f4f6', borderRadius: 8 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead style={{ position: 'sticky', top: 0, background: '#f9fafb' }}>
          <tr>
            <th style={{ textAlign: 'left', padding: '8px 10px', fontWeight: 600, color: '#6b7280', borderBottom: '1px solid #e5e7eb' }}>Time</th>
            <th style={{ textAlign: 'right', padding: '8px 10px', fontWeight: 600, color: '#6b7280', borderBottom: '1px solid #e5e7eb' }}>{primaryLabel}</th>
            {errorsAt.length > 0 && <th style={{ textAlign: 'right', padding: '8px 10px', fontWeight: 600, color: '#6b7280', borderBottom: '1px solid #e5e7eb' }}>Errors</th>}
          </tr>
        </thead>
        <tbody>
          {values.map((v, i) => {
            const errCount = errorsAt[i] ?? 0
            const clickable = errorsAt.length > 0 && errCount > 0 && onErrorClick
            return (
              <tr key={i} style={{ borderBottom: '1px solid #f3f4f6' }}>
                <td style={{ padding: '6px 10px', color: '#374151' }}>{labels[i] || `#${i+1}`}</td>
                <td style={{ padding: '6px 10px', textAlign: 'right', color: color, fontWeight: 600 }}>
                  {primaryClickable && v > 0 && onPrimaryClick ? (
                    <button
                      type="button"
                      onClick={() => onPrimaryClick(i)}
                      title="View error details"
                      style={{ background: 'none', border: 'none', color, fontWeight: 700, cursor: 'pointer', textDecoration: 'underline', padding: 0, font: 'inherit' }}
                    >
                      {valueFormatter(v)}
                    </button>
                  ) : (
                    valueFormatter(v)
                  )}
                </td>
                {errorsAt.length > 0 && (
                  <td style={{ padding: '6px 10px', textAlign: 'right' }}>
                    {clickable ? (
                      <button
                        type="button"
                        onClick={() => onErrorClick(i)}
                        title="View error details"
                        style={{ background: 'none', border: 'none', color: '#dc2626', fontWeight: 700, cursor: 'pointer', textDecoration: 'underline', padding: 0, font: 'inherit' }}
                      >
                        {errCount}
                      </button>
                    ) : (
                      <span style={{ color: errCount ? '#dc2626' : '#9ca3af' }}>{errCount}</span>
                    )}
                  </td>
                )}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )

  const formatBucketTime = (iso, { includeZone = false } = {}) => {
    if (!iso) return ''
    const d = new Date(iso)
    if (isNaN(d.getTime())) return ''
    // Shift by IST offset (+5h30m) then read UTC fields — gives IST clock values.
    const ist = new Date(d.getTime() + (5 * 60 + 30) * 60 * 1000)
    const mo = String(ist.getUTCMonth() + 1).padStart(2, '0')
    const day = String(ist.getUTCDate()).padStart(2, '0')
    const hh = String(ist.getUTCHours()).padStart(2, '0')
    const mm = String(ist.getUTCMinutes()).padStart(2, '0')
    return `${mo}-${day} ${hh}:${mm}${includeZone ? ' IST' : ''}`
  }

  // Include time because buckets can be minutes/hours apart on the same day.
  const xLabels = ts.map(p => formatBucketTime(p.ts, { includeZone: true }))
  const xAxisLabels = ts.map(p => formatBucketTime(p.ts))
  const pickLabels = (labels, count = 8) => {
    if (labels.length <= count) return labels
    const step = (labels.length - 1) / (count - 1)
    return Array.from({ length: count }, (_, i) => labels[Math.round(i * step)])
  }
  const xLabelsShown = pickLabels(xAxisLabels, 5)

  const totalErrors = (total4xx || 0) + (total5xx || 0)

  // Card styles
  const cardBase = {
    background: '#fff',
    border: '1px solid #e5e7eb',
    borderRadius: 14,
    boxShadow: '0 1px 2px rgba(0,0,0,0.03)',
  }
  const summaryBg = '#ECFDF5'
  const tealAccent = '#10B981'
  const pinkAccent = '#EC4899'
  const blueAccent = '#3B82F6'
  const peachBg    = '#FFEDD5'
  const peachIcon  = '#FB923C'
  const pinkBg     = '#FCE7F3'
  const blueBg     = '#DBEAFE'
  const tealBg     = '#D1FAE5'

  const MetricCard = ({ iconBg, iconColor, icon, value, label, footer, arrow = true, onArrowClick, arrowTitle }) => (
    <div style={{ ...cardBase, padding: 18, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 36, height: 36, borderRadius: 10, background: iconBg, color: iconColor, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            {icon}
          </div>
          <div>
            <div style={{ fontSize: 22, fontWeight: 800, color: '#111827', letterSpacing: '-0.02em', lineHeight: 1.1 }}>{value}</div>
            <div style={{ fontSize: 11, color: '#6b7280', fontWeight: 500, marginTop: 2 }}>{label}</div>
          </div>
        </div>
        {arrow && <ArrowRightBtn onClick={onArrowClick} title={arrowTitle} />}
      </div>
      {footer}
    </div>
  )

  // Icon SVGs
  const IconTruck = ({ color }) => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="1" y="3" width="15" height="13"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>
  const IconCart  = ({ color }) => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg>
  const IconWaste = ({ color }) => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>
  const IconCal   = ({ color }) => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
  const IconBox   = ({ color }) => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>
  const IconFile  = ({ color }) => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
  const IconChart = ({ color }) => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>

  return (
    <div style={{ background: '#fff', minHeight: '100vh', fontFamily: "'Inter', -apple-system, system-ui, sans-serif", overflowY: 'auto' }}>

      {/* ─── Top toolbar ─── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 24px', background: '#fff', borderBottom: '1px solid #e9ecef' }}>
        <button onClick={onBack}
          style={{ background: '#f3f4f6', border: 'none', borderRadius: 8, padding: '7px 14px', cursor: 'pointer',
            fontSize: 13, color: '#374151', fontWeight: 600 }}>
          ← Apps
        </button>
        <div style={{ width: 40, height: 40, borderRadius: 10, background: appAvatarColor(app?.name || ''),
          display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 800, fontSize: 14, flexShrink: 0 }}>
          {appInitials(app?.name || '')}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 17, color: '#111827' }}>Application Insights</div>
          <div style={{ fontSize: 12, color: '#9ca3af', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {tenant?.name ? `${tenant.name} · ${app?.name || ''}` : app?.name || ''}
          </div>
          {(filteredDocs[0]?.app_id || filteredDocs[0]?.inst_id) && (
            <div style={{ fontSize: 11, color: '#9ca3af', display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 3 }}>
              {filteredDocs[0]?.app_id && (
                <span title={filteredDocs[0].app_id}>
                  <span style={{ color: '#6b7280', fontWeight: 600 }}>Global App ID:</span>{' '}
                  <code style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11, color: '#374151' }}>{filteredDocs[0].app_id}</code>
                </span>
              )}
              {filteredDocs[0]?.inst_id && envFilter !== 'all' && (
                <span title={filteredDocs[0].inst_id}>
                  <span style={{ color: '#6b7280', fontWeight: 600 }}>App ID:</span>{' '}
                  <code style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11, color: '#374151' }}>{filteredDocs[0].inst_id}</code>
                </span>
              )}
            </div>
          )}
        </div>
        {envOptions.length > 0 && (
          <div style={{
            display: 'inline-flex', background: '#f3f4f6', borderRadius: 10, padding: 3, gap: 2,
          }}>
            {envOptions.map(o => {
              const active = envFilter === o.key
              const ENV_DOT = { prod: '#dc2626', uat: '#d97706', qa: '#2563eb',
                dev: '#10b981', stage: '#8b5cf6', demo: '#0ea5e9' }
              const dot = o.key === 'all' ? '#111827' : (ENV_DOT[o.key] || '#6b7280')
              return (
                <button
                  key={o.key}
                  type="button"
                  onClick={() => setEnvFilter(o.key)}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    padding: '6px 12px', fontSize: 12, fontWeight: 600,
                    color: active ? '#111827' : '#6b7280',
                    background: active ? '#fff' : 'transparent',
                    border: 'none', borderRadius: 8, cursor: 'pointer',
                    boxShadow: active ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
                    transition: 'background 0.12s, color 0.12s',
                  }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: dot }} />
                  {o.label}
                </button>
              )
            })}
          </div>
        )}
        <DateRangeFilter value={dateRange} onChange={setDateRange} />
      </div>

      {/* ─── Tabs ─── */}
      <div style={{ padding: '4px 24px 0', display: 'flex', gap: 4, borderBottom: '1px solid #e5e7eb' }}>
        {[
          { id: 'overview', label: 'Overview' },
          { id: 'workflow', label: 'Workflow Analysis' },
        ].map(t => (
          <button
            key={t.id}
            type="button"
            onClick={() => setActiveTab(t.id)}
            style={{
              padding: '10px 16px',
              fontSize: 13,
              fontWeight: 600,
              color: activeTab === t.id ? '#10B981' : '#6b7280',
              background: 'transparent',
              border: 'none',
              borderBottom: activeTab === t.id ? '2px solid #10B981' : '2px solid transparent',
              cursor: 'pointer',
              marginBottom: -1,
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {activeTab === 'workflow' ? (
        <WorkflowFlowPage
          tenant={tenant}
          app={app}
          metrics={m}
          embedded={true}
          dateRange={dateRange}
          onDateChange={setDateRange}
        />
      ) : (<>

      {/* ─── Summary label ─── */}
      <div style={{ padding: '12px 24px 8px', fontSize: 14, fontWeight: 700, color: '#111827' }}>Summary</div>

      {/* ─── 4 metric cards (wrapped in the "based on insights" green frame) ─── */}
      <div style={{ margin: '0 24px', padding: 14, background: summaryBg, border: `1px solid ${tealBg}`, borderRadius: 14, display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14 }}>
        <MetricCard
          iconBg={tealBg} iconColor={tealAccent}
          icon={<IconTruck color={tealAccent} />}
          value={fmt(totalReq)} label="Total requests" arrow={false}
        />
        <MetricCard
          iconBg={pinkBg} iconColor={pinkAccent}
          icon={<IconCart color={pinkAccent} />}
          value={fmt(wfTotal)} label="Workflow API calls"
          onArrowClick={() => setActiveTab('workflow')} arrowTitle="View workflows"
        />
        <MetricCard
          iconBg={peachBg} iconColor={peachIcon}
          icon={<IconWaste color={peachIcon} />}
          value={fmt(totalErrors || null)} label="Total errors" arrow={false}
          footer={<div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
            <div>
              <div style={{ fontSize: 11, color: '#9ca3af' }}>4xx errors</div>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#111827' }}>{fmt(total4xx)}</div>
            </div>
            <div>
              <div style={{ fontSize: 11, color: '#9ca3af' }}>5xx errors</div>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#111827' }}>{fmt(total5xx)}</div>
            </div>
          </div>}
        />
        <MetricCard
          iconBg={blueBg} iconColor={blueAccent}
          icon={<IconCal color={blueAccent} />}
          value={fmt(healthScore)} label="Health score" arrow={false}
          footer={<div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
            <div>
              <div style={{ fontSize: 11, color: '#9ca3af' }}>Avg latency</div>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#059669', display: 'flex', alignItems: 'center', gap: 4 }}>
                <Arrow dir="up" color="#059669" />{ms(m.latency_ms?.avg)}
              </div>
            </div>
            <div>
              <div style={{ fontSize: 11, color: '#9ca3af' }}>P95 latency</div>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#059669', display: 'flex', alignItems: 'center', gap: 4 }}>
                <Arrow dir="up" color="#059669" />{ms(p95Latency)}
              </div>
            </div>
          </div>}
        />
      </div>

      {/* ─── Row: API Failures + Environment Breakdown ─── */}
      <div ref={apiFailuresRef} style={{ margin: '14px 24px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, scrollMarginTop: 80 }}>
        <ApiFailuresCard
          metrics={m} fmt={fmt} pct={pct}
          cardBase={cardBase}
          colors={{ peachBg, peachIcon, blueBg, blueAccent, pinkBg, pinkAccent }}
          IconWaste={IconWaste}
        />
        <EnvironmentBreakdownCard
          envs={envBreakdown}
          cardBase={cardBase} fmt={fmt}
          colors={{ tealAccent, pinkAccent, blueAccent, peachIcon }}
        />
      </div>

      {/* ─── Row: two line charts ─── */}
      <div style={{ margin: '14px 24px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        {/* Requests over time */}
        <div style={{ ...cardBase, padding: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ width: 28, height: 28, borderRadius: 8, background: pinkBg, color: pinkAccent, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <IconBox color={pinkAccent} />
              </div>
              <span style={{ fontSize: 14, fontWeight: 700, color: '#111827' }}>Requests</span>
            </div>
            <ChartListToggle view={chartViews.requests} setView={v => setChartView('requests', v)} />
          </div>
          {chartViews.requests === 'list' ? (
            <TimeseriesList values={tsRequests} labels={xLabels} color={pinkAccent} primaryLabel="Requests" errorsAt={tsErrors} height={240} onErrorClick={openErrorModal} />
          ) : (
            <DualLineChart primary={tsRequests} secondary={tsAvgLat.map(v => Math.min(v/100, Math.max(...tsRequests, 1)))} primaryColor={pinkAccent} height={240}
              primaryLabel="Requests" secondaryLabel="Avg latency (scaled)" xLabels={xLabels} valueFormatter={v => fmt(v)} errorsAt={tsErrors} />
          )}
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#9ca3af', marginTop: 4, padding: '0 24px' }}>
            {xLabelsShown.map((l, i) => <span key={i}>{l}</span>)}
          </div>
          <div style={{ display: 'flex', gap: 16, marginTop: 8, fontSize: 11, color: '#6b7280' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ width: 8, height: 8, borderRadius: '50%', background: pinkAccent }} />Requests</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ width: 8, height: 8, borderRadius: '50%', background: '#d1d5db' }} />Avg latency</span>
          </div>
        </div>

        {/* Errors over time */}
        <div style={{ ...cardBase, padding: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ width: 28, height: 28, borderRadius: 8, background: blueBg, color: blueAccent, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <IconFile color={blueAccent} />
              </div>
              <span style={{ fontSize: 14, fontWeight: 700, color: '#111827' }}>Errors</span>
            </div>
            <ChartListToggle view={chartViews.errors} setView={v => setChartView('errors', v)} />
          </div>
          {chartViews.errors === 'list' ? (
            <TimeseriesList values={tsErrors} labels={xLabels} color={blueAccent} primaryLabel="Errors" height={240} primaryClickable onPrimaryClick={openErrorModal} />
          ) : (
            <DualLineChart primary={tsErrors} secondary={tsRequests.map(v => v/20)} primaryColor={blueAccent} height={240}
              primaryLabel="Errors" secondaryLabel="Requests (scaled)" xLabels={xLabels} valueFormatter={v => fmt(v)} onPointClick={openErrorModal} />
          )}
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#9ca3af', marginTop: 4, padding: '0 24px' }}>
            {xLabelsShown.map((l, i) => <span key={i}>{l}</span>)}
          </div>
          <div style={{ display: 'flex', gap: 16, marginTop: 8, fontSize: 11, color: '#6b7280' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ width: 8, height: 8, borderRadius: '50%', background: blueAccent }} />Errors</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ width: 8, height: 8, borderRadius: '50%', background: '#d1d5db' }} />Requests</span>
          </div>
        </div>
      </div>

      {/* ─── Row: second chart row ─── */}
      <div style={{ margin: '14px 24px 32px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <div ref={p95LatencyRef} style={{ ...cardBase, padding: 18, scrollMarginTop: 80 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ width: 28, height: 28, borderRadius: 8, background: tealBg, color: tealAccent, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <IconTruck color={tealAccent} />
              </div>
              <span style={{ fontSize: 14, fontWeight: 700, color: '#111827' }}>P95 Latency</span>
            </div>
            <ChartListToggle view={chartViews.p95} setView={v => setChartView('p95', v)} />
          </div>
          {chartViews.p95 === 'list' ? (
            <TimeseriesList values={tsP95} labels={xLabels} color={tealAccent} primaryLabel="P95 latency" valueFormatter={v => `${Number(v).toFixed(0)} ms`} errorsAt={tsErrors} height={240} onErrorClick={openErrorModal} />
          ) : (
            <DualLineChart primary={tsP95} secondary={tsAvgLat} primaryColor={tealAccent} height={240}
              primaryLabel="P95 latency" secondaryLabel="Avg latency" xLabels={xLabels} valueFormatter={v => `${Number(v).toFixed(0)} ms`} errorsAt={tsErrors} />
          )}
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#9ca3af', marginTop: 4, padding: '0 24px' }}>
            {xLabelsShown.map((l, i) => <span key={i}>{l}</span>)}
          </div>
          <div style={{ display: 'flex', gap: 16, marginTop: 8, fontSize: 11, color: '#6b7280' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ width: 8, height: 8, borderRadius: '50%', background: tealAccent }} />P95 latency (ms)</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ width: 8, height: 8, borderRadius: '50%', background: '#d1d5db' }} />Avg latency (ms)</span>
          </div>
        </div>

        <div ref={errorRateRef} style={{ ...cardBase, padding: 18, scrollMarginTop: 80 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ width: 28, height: 28, borderRadius: 8, background: peachBg, color: peachIcon, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <IconCart color={peachIcon} />
              </div>
              <span style={{ fontSize: 14, fontWeight: 700, color: '#111827' }}>Error rate</span>
            </div>
            <ChartListToggle view={chartViews.errRate} setView={v => setChartView('errRate', v)} />
          </div>
          {chartViews.errRate === 'list' ? (
            <TimeseriesList values={tsErrRate} labels={xLabels} color={peachIcon} primaryLabel="Error rate" valueFormatter={v => `${Number(v).toFixed(2)}%`} errorsAt={tsErrors} height={240} onErrorClick={openErrorModal} />
          ) : (
            <DualLineChart primary={tsErrRate} secondary={[]} primaryColor={peachIcon} height={240}
              primaryLabel="Error rate" xLabels={xLabels} valueFormatter={v => `${Number(v).toFixed(2)}%`}
              errorsAt={tsErrors} onPointClick={openErrorModal} />
          )}
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#9ca3af', marginTop: 4, padding: '0 24px' }}>
            {xLabelsShown.map((l, i) => <span key={i}>{l}</span>)}
          </div>
          <div style={{ display: 'flex', gap: 16, marginTop: 8, fontSize: 11, color: '#6b7280' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ width: 8, height: 8, borderRadius: '50%', background: peachIcon }} />Error rate (%)</span>
          </div>
        </div>
      </div>
      </>)}

      {errorModal && (
        <div
          onClick={() => setErrorModal(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{ background: '#fff', borderRadius: 14, width: '100%', maxWidth: 860, maxHeight: '85vh', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 50px rgba(0,0,0,0.25)' }}
          >
            <div style={{ padding: '16px 20px', borderBottom: '1px solid #e5e7eb', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <div style={{ fontSize: 15, fontWeight: 700, color: '#111827' }}>Errors at {errorModal.label}</div>
                <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>
                  {new Date(errorModal.start).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} → {new Date(errorModal.end).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST
                </div>
              </div>
              <button
                type="button"
                onClick={() => setErrorModal(null)}
                style={{ width: 32, height: 32, borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff', cursor: 'pointer', fontSize: 16, color: '#6b7280' }}
              >×</button>
            </div>

            <div style={{ padding: 20, overflowY: 'auto', flex: 1 }}>
              {errorModal.loading && (
                <div style={{ textAlign: 'center', padding: 40, color: '#9ca3af', fontSize: 13 }}>Loading errors…</div>
              )}
              {errorModal.error && (
                <div style={{ background: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca', borderRadius: 8, padding: 12, fontSize: 12 }}>{errorModal.error}</div>
              )}
              {errorModal.data && (
                <>
                  <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
                    <div style={{ background: '#fef2f2', borderRadius: 8, padding: '10px 14px', minWidth: 120 }}>
                      <div style={{ fontSize: 10, color: '#991b1b', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5 }}>Total errors</div>
                      <div style={{ fontSize: 20, fontWeight: 800, color: '#dc2626', marginTop: 2 }}>{errorModal.data.total}</div>
                    </div>
                    {errorModal.data.by_status?.length > 0 && (
                      <div style={{ background: '#f9fafb', borderRadius: 8, padding: '10px 14px', flex: 1, minWidth: 220 }}>
                        <div style={{ fontSize: 10, color: '#6b7280', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>By status code</div>
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                          {errorModal.data.by_status.map(s => (
                            <span key={s.status} style={{ fontSize: 11, fontWeight: 600, padding: '3px 8px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 999, color: '#374151' }}>
                              <strong style={{ color: '#dc2626' }}>{s.status}</strong> × {s.count}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>

                  {errorModal.data.by_path?.length > 0 && (
                    <div style={{ marginBottom: 16 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 8 }}>Top error paths</div>
                      <div style={{ border: '1px solid #f3f4f6', borderRadius: 8, overflow: 'hidden' }}>
                        {errorModal.data.by_path.map((p, i) => (
                          <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 12px', fontSize: 12, borderBottom: i < errorModal.data.by_path.length - 1 ? '1px solid #f3f4f6' : 'none' }}>
                            <span style={{ color: '#374151', fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginRight: 10 }}>{p.path}</span>
                            <span style={{ color: '#6b7280', fontWeight: 600 }}>{p.count}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 8 }}>Recent samples ({errorModal.data.errors?.length || 0})</div>
                    {(!errorModal.data.errors || errorModal.data.errors.length === 0) ? (
                      <div style={{ color: '#9ca3af', fontSize: 12, padding: 12, background: '#f9fafb', borderRadius: 6 }}>
                        {errorModal.data.total > 0
                          ? 'No per-request samples stored for this bucket — re-run the log analysis to capture sample error documents.'
                          : 'No errors recorded in this window.'}
                      </div>
                    ) : (
                      <div style={{ border: '1px solid #f3f4f6', borderRadius: 8, overflow: 'hidden' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                          <thead style={{ background: '#f9fafb' }}>
                            <tr>
                              <th style={{ textAlign: 'left', padding: '8px 10px', fontWeight: 600, color: '#6b7280' }}>Time</th>
                              <th style={{ textAlign: 'left', padding: '8px 10px', fontWeight: 600, color: '#6b7280' }}>Status</th>
                              <th style={{ textAlign: 'left', padding: '8px 10px', fontWeight: 600, color: '#6b7280' }}>Method</th>
                              <th style={{ textAlign: 'left', padding: '8px 10px', fontWeight: 600, color: '#6b7280' }}>Path</th>
                              <th style={{ textAlign: 'right', padding: '8px 10px', fontWeight: 600, color: '#6b7280' }}>Duration</th>
                              <th style={{ textAlign: 'left', padding: '8px 10px', fontWeight: 600, color: '#6b7280' }}>Reason</th>
                            </tr>
                          </thead>
                          <tbody>
                            {errorModal.data.errors.map((err, i) => {
                              const sc = Number(err.response_code)
                              const badge = sc >= 500 ? { bg: '#fee2e2', fg: '#991b1b' } : { bg: '#fef3c7', fg: '#92400e' }
                              const t = err.timestamp || err['@timestamp']
                              const reason = err.response_code_details || err.response_flags || '—'
                              return (
                                <tr key={i} style={{ borderTop: '1px solid #f3f4f6' }}>
                                  <td style={{ padding: '6px 10px', color: '#6b7280', whiteSpace: 'nowrap' }}>{t ? new Date(t).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' }) : '—'}</td>
                                  <td style={{ padding: '6px 10px' }}>
                                    <span style={{ background: badge.bg, color: badge.fg, fontWeight: 700, padding: '2px 8px', borderRadius: 4 }}>{err.response_code ?? '—'}</span>
                                  </td>
                                  <td style={{ padding: '6px 10px', color: '#374151', fontWeight: 600 }}>{err.method || '—'}</td>
                                  <td style={{ padding: '6px 10px', color: '#374151', fontFamily: 'monospace', maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={err.path}>{err.path || '—'}</td>
                                  <td style={{ padding: '6px 10px', textAlign: 'right', color: '#6b7280' }}>{err.duration != null ? fmtDur(Math.round(err.duration)) : '—'}</td>
                                  <td style={{ padding: '6px 10px', color: '#6b7280', fontSize: 10, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={reason}>{reason}</td>
                                </tr>
                              )
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── API Failures card ───────────────────────────────────────────────────────
// Breaks down non-workflow API errors by status class, failure mode, and path.
// All data sourced from MongoDB app_insights.metrics — no dummy values.

const WORKFLOW_PATH_PREFIXES = ['/workflow', '/platform/workflow']

function ApiFailuresCard({ metrics, fmt, pct, cardBase, colors, IconWaste }) {
  const m = metrics || {}
  const { peachBg, peachIcon, blueBg, blueAccent, pinkBg, pinkAccent } = colors

  const total4xx = m.error_4xx_count || 0
  const total5xx = m.error_5xx_count || 0
  const totalErr = total4xx + total5xx
  const totalReq = m.total_requests || 0
  const wfReq    = m.workflow?.total_requests || 0
  const wfErr    = m.workflow?.error_count || 0
  const apiReq   = Math.max(0, totalReq - wfReq)
  const apiErr   = Math.max(0, totalErr - wfErr)
  const apiErrRate = apiReq > 0 ? (apiErr / apiReq) * 100 : null

  // Top failing endpoints restricted to API paths (exclude workflow routes)
  const topErrEndpoints = (m.top_endpoints_by_errors || []).filter(e => {
    const p = e.path || ''
    return !WORKFLOW_PATH_PREFIXES.some(pre => p.startsWith(pre))
  }).slice(0, 5)

  // Failure modes (Istio response_code_details)
  const failureReasons = Object.entries(m.failure_reasons || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)

  const empty = apiErr === 0 && topErrEndpoints.length === 0 && failureReasons.length === 0

  return (
    <div style={{ ...cardBase, padding: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <div style={{ width: 28, height: 28, borderRadius: 8, background: peachBg, color: peachIcon, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <IconWaste color={peachIcon} />
        </div>
        <span style={{ fontSize: 14, fontWeight: 700, color: '#111827' }}>API Failures</span>
      </div>

      {empty ? (
        <div style={{ padding: '20px 0', color: '#9ca3af', fontSize: 12, textAlign: 'center' }}>No API failures recorded in this window.</div>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 14 }}>
            <div style={{ background: '#fff7ed', borderRadius: 10, padding: 12, border: '1px solid #fed7aa' }}>
              <div style={{ fontSize: 10, color: '#9a3412', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5 }}>Client (4xx)</div>
              <div style={{ fontSize: 20, fontWeight: 800, color: '#c2410c', marginTop: 4 }}>{fmt(total4xx)}</div>
              <div style={{ fontSize: 11, color: '#9a3412', marginTop: 2 }}>{totalErr ? `${Math.round(total4xx/totalErr*100)}% of errors` : '—'}</div>
            </div>
            <div style={{ background: '#fef2f2', borderRadius: 10, padding: 12, border: '1px solid #fecaca' }}>
              <div style={{ fontSize: 10, color: '#991b1b', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5 }}>Server (5xx)</div>
              <div style={{ fontSize: 20, fontWeight: 800, color: '#dc2626', marginTop: 4 }}>{fmt(total5xx)}</div>
              <div style={{ fontSize: 11, color: '#991b1b', marginTop: 2 }}>{totalErr ? `${Math.round(total5xx/totalErr*100)}% of errors` : '—'}</div>
            </div>
            <div style={{ background: '#eff6ff', borderRadius: 10, padding: 12, border: '1px solid #bfdbfe' }}>
              <div style={{ fontSize: 10, color: '#1e40af', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5 }}>API-only rate</div>
              <div style={{ fontSize: 20, fontWeight: 800, color: '#1d4ed8', marginTop: 4 }}>{apiErrRate != null ? `${apiErrRate.toFixed(2)}%` : '—'}</div>
              <div style={{ fontSize: 11, color: '#1e40af', marginTop: 2 }}>{fmt(apiErr)} / {fmt(apiReq)} reqs</div>
            </div>
          </div>

          {failureReasons.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 11, color: '#6b7280', fontWeight: 600, marginBottom: 6 }}>Failure modes</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {failureReasons.map(([reason, count]) => (
                  <span key={reason} title={reason} style={{ fontSize: 11, padding: '3px 8px', background: '#f3f4f6', borderRadius: 999, color: '#374151', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {reason} <strong style={{ color: '#dc2626' }}>×{count}</strong>
                  </span>
                ))}
              </div>
            </div>
          )}

          {topErrEndpoints.length > 0 && (
            <div>
              <div style={{ fontSize: 11, color: '#6b7280', fontWeight: 600, marginBottom: 6 }}>Top failing API endpoints</div>
              <div style={{ border: '1px solid #f3f4f6', borderRadius: 8, overflow: 'hidden' }}>
                {topErrEndpoints.map((e, i) => (
                  <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: 10, padding: '7px 10px', fontSize: 11, borderTop: i > 0 ? '1px solid #f3f4f6' : 'none', alignItems: 'center' }}>
                    <span title={e.path} style={{ color: '#374151', fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.path}</span>
                    <span style={{ color: '#dc2626', fontWeight: 700 }}>{fmt(e.error_count)}</span>
                    <span style={{ color: '#9ca3af', fontSize: 10 }}>{e.error_rate_pct != null ? `${Number(e.error_rate_pct).toFixed(1)}%` : '—'}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}


// ─── Environment Breakdown card ──────────────────────────────────────────────
// One row per environment (prod/uat/dev/...) from MongoDB app_insights history.

const ENV_COLOR = {
  prod:       { dot: '#dc2626', bg: '#fef2f2', label: 'Production' },
  production: { dot: '#dc2626', bg: '#fef2f2', label: 'Production' },
  uat:        { dot: '#d97706', bg: '#fffbeb', label: 'UAT' },
  qa:         { dot: '#d97706', bg: '#fffbeb', label: 'QA' },
  stage:      { dot: '#d97706', bg: '#fffbeb', label: 'Stage' },
  staging:    { dot: '#d97706', bg: '#fffbeb', label: 'Staging' },
  dev:        { dot: '#10B981', bg: '#ecfdf5', label: 'Development' },
  develop:    { dot: '#10B981', bg: '#ecfdf5', label: 'Development' },
  development:{ dot: '#10B981', bg: '#ecfdf5', label: 'Development' },
  demo:       { dot: '#8b5cf6', bg: '#f5f3ff', label: 'Demo' },
}

function EnvironmentBreakdownCard({ envs, cardBase, fmt, colors }) {
  const relTime = (iso) => {
    if (!iso) return ''
    const t = new Date(iso).getTime()
    if (isNaN(t)) return ''
    const mins = Math.max(0, Math.round((Date.now() - t) / 60000))
    if (mins < 60) return `${mins} min ago`
    const hrs = Math.round(mins / 60)
    if (hrs < 48) return `${hrs} hr ago`
    return `${Math.round(hrs / 24)} d ago`
  }

  return (
    <div style={{ ...cardBase, padding: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <div style={{ width: 28, height: 28, borderRadius: 8, background: '#ecfdf5', color: colors.tealAccent, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={colors.tealAccent} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>
        </div>
        <span style={{ fontSize: 14, fontWeight: 700, color: '#111827' }}>Environment Breakdown</span>
      </div>

      {(!envs || envs.length === 0) ? (
        <div style={{ padding: '20px 0', color: '#9ca3af', fontSize: 12, textAlign: 'center' }}>No environment data available.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {(() => {
            // Aggregate per environment: each app_insights doc is one 30-min
            // Lambda snapshot; we want ONE row per env summarising all snapshots
            // in the window. Traffic and errors sum, P95 takes the max (worst
            // case visible), failure rate is recomputed from the totals, and
            // analyzed_at uses the most recent run.
            const groups = new Map()
            for (const d of envs) {
              const key = (d.environment || 'unknown').toLowerCase()
              const mt  = d.metrics || {}
              const traffic = Number(mt.total_requests) || 0
              const errors  = (Number(mt.error_4xx_count) || 0) + (Number(mt.error_5xx_count) || 0)
              const p95     = mt.latency_ms?.p95
              const ts      = d.analyzed_at
              const g = groups.get(key) || {
                env: d.environment || 'unknown',
                traffic: 0, errors: 0, p95: null, latest: null,
              }
              g.traffic += traffic
              g.errors  += errors
              if (p95 != null && (g.p95 == null || p95 > g.p95)) g.p95 = p95
              if (ts && (!g.latest || ts > g.latest)) g.latest = ts
              groups.set(key, g)
            }
            const rows = Array.from(groups.values()).sort((a, b) => b.traffic - a.traffic)

            return rows.map((g, i) => {
              const meta = ENV_COLOR[g.env.toLowerCase()] || { dot: '#6b7280', bg: '#f9fafb', label: g.env || 'Unknown' }
              const errRate = g.traffic > 0 ? (g.errors / g.traffic * 100) : null
              const errRateColor = errRate == null ? '#9ca3af' : errRate < 1 ? '#059669' : errRate < 5 ? '#d97706' : '#dc2626'
              return (
                <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 10, alignItems: 'center', padding: '10px 12px', background: meta.bg, borderRadius: 10, border: '1px solid #f3f4f6' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                    <span style={{ width: 10, height: 10, borderRadius: '50%', background: meta.dot, flexShrink: 0 }} />
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: '#111827' }}>{meta.label}</div>
                      <div style={{ fontSize: 10, color: '#6b7280', marginTop: 2 }}>Last analyzed {relTime(g.latest)}</div>
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: 10, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: 0.5 }}>Traffic</div>
                      <div style={{ fontSize: 13, fontWeight: 700, color: '#374151' }}>{fmt(g.traffic)}</div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: 10, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: 0.5 }}>P95</div>
                      <div style={{ fontSize: 13, fontWeight: 700, color: '#374151' }}>{g.p95 != null ? fmtDur(Math.round(g.p95)) : '—'}</div>
                    </div>
                    <div style={{ textAlign: 'right', minWidth: 60 }}>
                      <div style={{ fontSize: 10, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: 0.5 }}>Failure rate</div>
                      <div style={{ fontSize: 13, fontWeight: 700, color: errRateColor }}>{errRate != null ? `${errRate.toFixed(2)}%` : '—'}</div>
                    </div>
                  </div>
                </div>
              )
            })
          })()}
        </div>
      )}
    </div>
  )
}


// ─── AI Insights tab ─────────────────────────────────────────────────────────

function AIInsightsTab({ insights, metrics }) {
  const ins = insights || {}
  const m = metrics || {}
  const hasAny = ins && Object.keys(ins).length > 0

  const SectionCard = ({ title, children, accent = '#10B981' }) => (
    <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 14, padding: 20, boxShadow: '0 1px 2px rgba(0,0,0,0.03)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, paddingBottom: 12, borderBottom: '1px solid #f3f4f6' }}>
        <span style={{ width: 4, height: 18, background: accent, borderRadius: 2 }} />
        <h3 style={{ fontSize: 14, fontWeight: 700, color: '#111827', margin: 0 }}>{title}</h3>
      </div>
      {children}
    </div>
  )

  const ListBlock = ({ items, color = '#10B981' }) => (
    <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 10 }}>
      {items.map((item, i) => (
        <li key={i} style={{ display: 'flex', gap: 10, padding: '10px 12px', background: '#f9fafb', borderRadius: 8, borderLeft: `3px solid ${color}` }}>
          <span style={{ fontSize: 11, fontWeight: 700, color, minWidth: 18 }}>{i + 1}</span>
          <span style={{ fontSize: 13, color: '#374151', lineHeight: 1.5 }}>{item}</span>
        </li>
      ))}
    </ul>
  )

  if (!hasAny) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>
        <div style={{ fontSize: 36, marginBottom: 12 }}>🤖</div>
        <div style={{ fontSize: 14, fontWeight: 600, color: '#6b7280' }}>No AI insights available</div>
        <div style={{ fontSize: 12, marginTop: 4 }}>Run the analysis to generate AI insights for this app.</div>
      </div>
    )
  }

  return (
    <div style={{ padding: '20px 24px 32px', display: 'flex', flexDirection: 'column', gap: 16 }}>

      {ins.summary && (
        <SectionCard title="Summary" accent="#10B981">
          <p style={{ margin: 0, fontSize: 13, color: '#374151', lineHeight: 1.6 }}>{ins.summary}</p>
        </SectionCard>
      )}

      {ins.error_analysis?.error_patterns && (
        <SectionCard title="Error Analysis" accent="#ef4444">
          <p style={{ margin: 0, fontSize: 13, color: '#374151', lineHeight: 1.6 }}>{ins.error_analysis.error_patterns}</p>
        </SectionCard>
      )}

      {ins.performance_insights?.anomalies && (
        <SectionCard title="Performance" accent="#3B82F6">
          <p style={{ margin: 0, fontSize: 13, color: '#374151', lineHeight: 1.6 }}>{ins.performance_insights.anomalies}</p>
        </SectionCard>
      )}

      {ins.security_observations && (
        <SectionCard title="Security Observations" accent="#EC4899">
          <p style={{ margin: 0, fontSize: 13, color: '#374151', lineHeight: 1.6 }}>{ins.security_observations}</p>
        </SectionCard>
      )}

      {Array.isArray(ins.top_issues) && ins.top_issues.length > 0 && (
        <SectionCard title="Top Issues" accent="#f59e0b">
          <ListBlock items={ins.top_issues} color="#f59e0b" />
        </SectionCard>
      )}

      {Array.isArray(ins.recommendations) && ins.recommendations.length > 0 && (
        <SectionCard title="Recommendations" accent="#10B981">
          <ListBlock items={ins.recommendations} color="#10B981" />
        </SectionCard>
      )}

    </div>
  )
}

// ─── Collection run history panel ────────────────────────────────────────────

function CollectionRunHistory({ colId, tenant, base }) {
  const [runs,    setRuns]    = useState(null)
  const [loading, setLoading] = useState(true)
  const [err,     setErr]     = useState(null)

  useEffect(() => {
    fetch(`${base}/${colId}/runs?limit=15`)
      .then(r => r.json())
      .then(j => { setRuns(j.runs || []); setLoading(false) })
      .catch(e => { setErr(e.message); setLoading(false) })
  }, [colId, base])

  const fmtDt = iso => {
    if (!iso) return '—'
    try {
      return new Date(iso).toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short',
        hour: '2-digit', minute: '2-digit', hour12: true,
      }) + ' IST'
    } catch { return iso }
  }

  const fmtDur = ms => {
    if (!ms) return ''
    return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`
  }

  return (
    <div style={{ padding: '12px 18px', borderTop: '1px solid #f1f5f9', background: '#fafafa' }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
        Run History
      </div>
      {loading && <div style={{ fontSize: 12, color: '#9ca3af' }}>Loading…</div>}
      {err     && <div style={{ fontSize: 12, color: '#dc2626' }}>Error: {err}</div>}
      {!loading && !err && (!runs || runs.length === 0) && (
        <div style={{ fontSize: 12, color: '#9ca3af' }}>No runs recorded yet.</div>
      )}
      {!loading && runs && runs.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {runs.map(run => {
            const ok = run.failed === 0
            const cronLabel = run.cron_name || 'Cron'
            return (
              <div key={run.id} style={{
                display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
                padding: '7px 12px', borderRadius: 8, fontSize: 12,
                background: ok ? '#f0fdf4' : '#fef2f2',
                border: `1px solid ${ok ? '#bbf7d0' : '#fecaca'}`,
              }}>
                <span style={{
                  width: 18, height: 18, borderRadius: '50%', flexShrink: 0,
                  background: ok ? '#16a34a' : '#dc2626', color: '#fff',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 10, fontWeight: 800,
                }}>{ok ? '✓' : '✗'}</span>
                <span style={{ fontWeight: 600, color: '#374151' }}>
                  {run.passed}/{run.total} passed
                  {run.failed > 0 && <span style={{ color: '#dc2626', marginLeft: 4 }}>· {run.failed} failed</span>}
                </span>
                <span style={{ fontSize: 11, padding: '1px 7px', borderRadius: 4, background: '#ede9fe', color: '#6d28d9', fontWeight: 600 }}>
                  {cronLabel}
                </span>
                {run.duration_ms > 0 && <span style={{ color: '#6b7280' }}>{fmtDur(run.duration_ms)}</span>}
                <span style={{ color: '#9ca3af', marginLeft: 'auto', whiteSpace: 'nowrap' }}>{fmtDt(run.ran_at)}</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}


// ─── API Monitor tab ──────────────────────────────────────────────────────────

function ApiMonitorTab({ tenant }) {
  const [collections, setCollections] = useState([])
  const [loading,     setLoading]     = useState(true)
  const [showModal,   setShowModal]   = useState(false)
  const [jsonText,    setJsonText]    = useState('')
  const [envText,     setEnvText]     = useState('')
  const [colName,     setColName]     = useState('')
  const [saving,      setSaving]      = useState(false)
  const [saveErr,     setSaveErr]     = useState(null)
  const [editVarsId,      setEditVarsId]      = useState(null)  // collection id whose vars panel is open
  const [editVarsMap,     setEditVarsMap]     = useState({})    // id -> {key:val,...} being edited
  const [editExpectedMap, setEditExpectedMap] = useState({})    // id -> { reqName: "200" } per-request
  const [runningId,      setRunningId]      = useState(null)
  const [results,        setResults]        = useState({})    // id -> run summary
  const [expandedId,     setExpandedId]     = useState(null)  // id of collection showing API list
  const [collapsedIds,   setCollapsedIds]   = useState({})    // id -> true when card body hidden
  const [detailModal,    setDetailModal]    = useState(null)  // result object to show in popup
  const [modalMinimised, setModalMinimised] = useState(false) // minimised state
  const [historyId,      setHistoryId]      = useState(null)  // collection id showing run history

  const base = `${API}/api/api-monitor/${encodeURIComponent(tenant)}/collections`

  function load() {
    setLoading(true)
    fetch(base)
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(d => setCollections(d.collections || []))
      .catch(() => setCollections([]))
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [tenant])

  function handleFileUpload(e) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = ev => {
      setJsonText(ev.target.result)
      if (!colName) setColName(file.name.replace(/\.json$/i, ''))
    }
    reader.readAsText(file)
  }

  function handleEnvUpload(e) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = ev => setEnvText(ev.target.result)
    reader.readAsText(file)
  }

  async function handleSave() {
    setSaveErr(null)
    let parsed, parsedEnv = null
    try { parsed = JSON.parse(jsonText) } catch { setSaveErr('Invalid collection JSON'); return }
    if (envText.trim()) {
      try { parsedEnv = JSON.parse(envText) } catch { setSaveErr('Invalid environment JSON'); return }
    }
    setSaving(true)
    try {
      const res = await fetch(base, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: colName.trim() || parsed?.info?.name || 'Unnamed',
          collection: parsed,
          environment: parsedEnv,
        }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const saved = await res.json()
      setCollections(prev => [saved, ...prev])
      setShowModal(false)
      setJsonText('')
      setEnvText('')
      setColName('')
    } catch (e) {
      setSaveErr(e.message)
    } finally {
      setSaving(false)
    }
  }

  async function handleSaveVars(col) {
    const vars = editVarsMap[col.id] || {}
    try {
      const res = await fetch(`${base}/${col.id}/variables`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ variables: vars }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setCollections(prev => prev.map(c => c.id === col.id ? { ...c, variables: data.variables } : c))
      setEditVarsId(null)
    } catch (e) {
      alert('Failed to save variables: ' + e.message)
    }
  }

  async function handleRun(col) {
    setRunningId(col.id)
    try {
      const res = await fetch(`${base}/${col.id}/run`, { method: 'POST' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setResults(prev => ({ ...prev, [col.id]: data }))
      setCollections(prev => prev.map(c => c.id === col.id
        ? { ...c, last_run_at: data.ran_at, last_results: data } : c))
    } catch (e) {
      setResults(prev => ({ ...prev, [col.id]: { error: e.message } }))
    } finally {
      setRunningId(null)
    }
  }

  async function handleDelete(col) {
    if (!confirm(`Delete "${col.name}"?`)) return
    await fetch(`${base}/${col.id}`, { method: 'DELETE' })
    setCollections(prev => prev.filter(c => c.id !== col.id))
    setResults(prev => { const n = { ...prev }; delete n[col.id]; return n })
  }

  async function handleSaveExpected(col) {
    const raw = editExpectedMap[col.id] || {}
    const stored = col.expected_status_codes || {}
    const allApis = extractRequests(col.collection?.item)
    const expected_status_codes = Object.fromEntries(
      allApis.map(api => {
        const edited = raw[api.name]
        const val = edited !== undefined ? parseInt(edited, 10) : (stored[api.name] ?? 200)
        return [api.name, val]
      }).filter(([, v]) => !isNaN(v) && v > 0)
    )
    try {
      const res = await fetch(`${base}/${col.id}/expected-status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expected_status_codes }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setCollections(prev => prev.map(c => c.id === col.id
        ? { ...c, expected_status_codes: data.expected_status_codes } : c))
    } catch (e) {
      alert('Failed to save: ' + e.message)
    }
  }

  const cardBase = { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }
  const METHOD_COLOR = { GET: '#3b82f6', POST: '#10b981', PUT: '#f59e0b', PATCH: '#8b5cf6', DELETE: '#ef4444' }

  function extractRequests(items, prefix) {
    const out = []
    for (const item of items || []) {
      const name = prefix ? `${prefix} / ${item.name}` : item.name
      if (item.item) { out.push(...extractRequests(item.item, name)) }
      else if (item.request) {
        const req = item.request
        const method = (req.method || 'GET').toUpperCase()
        const urlField = req.url
        const url = typeof urlField === 'string' ? urlField : (urlField?.raw || '')
        const headers = (req.header || []).filter(h => !h.disabled)
        const body = req.body?.raw || ''
        out.push({ name, method, url, headers, body, bodyMode: req.body?.mode })
      }
    }
    return out
  }

  return (
    <div style={{ padding: '20px 24px 32px' }}>

      {/* header row */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: '#111827' }}>Postman Collections</div>
        <button onClick={() => { setShowModal(true); setSaveErr(null) }}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 16px',
            background: '#10b981', color: '#fff', border: 'none', borderRadius: 8,
            fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
          + Add Collection
        </button>
      </div>

      {/* list */}
      {loading && <div style={{ color: '#9ca3af', fontSize: 13, padding: '32px 0', textAlign: 'center' }}>Loading…</div>}
      {!loading && collections.length === 0 && (
        <div style={{ ...cardBase, padding: 40, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>
          No collections yet. Click "Add Collection" to import a Postman JSON.
        </div>
      )}

      {collections.map(col => {
        const run = results[col.id] || col.last_results
        const isRunning   = runningId === col.id
        const isExpanded  = expandedId === col.id
        const isCollapsed = !!collapsedIds[col.id]
        const apiList     = extractRequests(col.collection?.item)
        const runMap      = {}
        if (run && run.results) run.results.forEach(r => { runMap[r.name] = r })

        return (
          <div key={col.id} style={{ ...cardBase, marginBottom: 14 }}>

            {/* collection header */}
            <div style={{ padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 12,
              borderBottom: !isCollapsed && (isExpanded || run) ? '1px solid #f3f4f6' : 'none' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 14, color: '#111827' }}>{col.name}</div>
                <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span>{col.req_count} request{col.req_count !== 1 ? 's' : ''}</span>
                  {col.last_run_at && <span>Last run: {new Date(col.last_run_at).toLocaleString()}</span>}
                  {col.expected_status_codes && Object.keys(col.expected_status_codes).length > 0 && (
                    <span style={{ fontSize: 10, fontWeight: 600, padding: '1px 7px', borderRadius: 4,
                      background: '#fef9c3', color: '#92400e', border: '1px solid #fde68a' }}>
                      {Object.keys(col.expected_status_codes).length} custom expected
                    </span>
                  )}
                </div>
              </div>

              {run && !run.error && (
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: '#10b981' }}>{run.passed} passed</span>
                  {run.failed > 0 && <span style={{ fontSize: 12, fontWeight: 700, color: '#ef4444' }}>{run.failed} failed</span>}
                </div>
              )}

              {/* View APIs toggle */}
              <button
                onClick={() => setExpandedId(isExpanded ? null : col.id)}
                style={{ padding: '7px 14px', background: isExpanded ? '#eff6ff' : '#f8fafc',
                  color: isExpanded ? '#3b82f6' : '#6b7280',
                  border: `1px solid ${isExpanded ? '#bfdbfe' : '#e5e7eb'}`,
                  borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                  display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                {isExpanded ? '▲' : '▼'} APIs
              </button>

              {/* Variables toggle */}
              {(() => {
                const varsOpen = editVarsId === col.id
                const varCount = Object.keys(col.variables || {}).length
                return (
                  <button
                    onClick={() => {
                      if (varsOpen) { setEditVarsId(null) } else {
                        setEditVarsId(col.id)
                        setEditVarsMap(prev => ({ ...prev, [col.id]: { ...(col.variables || {}) } }))
                      }
                    }}
                    style={{ padding: '7px 14px', background: varsOpen ? '#fef9ec' : '#f8fafc',
                      color: varsOpen ? '#d97706' : '#6b7280',
                      border: `1px solid ${varsOpen ? '#fde68a' : '#e5e7eb'}`,
                      borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                      display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                    ⚙ Vars{varCount > 0 ? ` (${varCount})` : ''}
                  </button>
                )
              })()}

              <button
                onClick={() => setHistoryId(historyId === col.id ? null : col.id)}
                style={{ padding: '7px 14px', background: historyId === col.id ? '#eef2ff' : '#f8fafc',
                  color: historyId === col.id ? '#6366f1' : '#6b7280',
                  border: `1px solid ${historyId === col.id ? '#c7d2fe' : '#e5e7eb'}`,
                  borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                  display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                📋 History
              </button>

              <button onClick={() => handleRun(col)} disabled={isRunning}
                style={{ padding: '7px 16px', background: isRunning ? '#d1fae5' : '#10b981',
                  color: isRunning ? '#6b7280' : '#fff', border: 'none', borderRadius: 8,
                  fontSize: 12, fontWeight: 600, cursor: isRunning ? 'not-allowed' : 'pointer',
                  display: 'inline-flex', alignItems: 'center', gap: 6, transition: 'background 0.15s' }}>
                {isRunning ? '⏳ Running…' : '▶ Test'}
              </button>

              <button
                onClick={() => setCollapsedIds(prev => ({ ...prev, [col.id]: !prev[col.id] }))}
                title={isCollapsed ? 'Expand' : 'Collapse'}
                style={{ padding: '7px 10px', background: 'transparent', border: '1px solid #e5e7eb',
                  borderRadius: 8, fontSize: 12, color: '#9ca3af', cursor: 'pointer' }}>
                {isCollapsed ? '▼' : '▲'}
              </button>

              <button onClick={() => handleDelete(col)}
                style={{ padding: '7px 10px', background: 'transparent', border: '1px solid #e5e7eb',
                  borderRadius: 8, fontSize: 12, color: '#9ca3af', cursor: 'pointer' }}>
                ✕
              </button>
            </div>

            {/* run history panel */}
            {historyId === col.id && (
              <CollectionRunHistory colId={col.id} tenant={tenant} base={base} />
            )}

            {!isCollapsed && (<>

            {/* variables editor panel */}
            {editVarsId === col.id && (() => {
              const vars = editVarsMap[col.id] || {}
              const keys = Object.keys(vars)
              return (
                <div style={{ padding: '14px 18px', background: '#fffbeb', borderBottom: '1px solid #fde68a' }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: '#92400e', marginBottom: 10 }}>
                    Environment Variables — values replace <code style={{ background: '#fef3c7', padding: '1px 5px', borderRadius: 3 }}>{'{{varName}}'}</code> in URLs, headers, and body
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: '6px 10px', alignItems: 'center', marginBottom: 10 }}>
                    {keys.map(k => (
                      <>
                        <input key={`k-${k}`} defaultValue={k} disabled
                          style={{ padding: '5px 8px', border: '1px solid #fde68a', borderRadius: 6, fontSize: 12,
                            background: '#fff', color: '#374151', fontFamily: 'monospace' }} />
                        <input key={`v-${k}`} value={vars[k]}
                          onChange={e => setEditVarsMap(prev => ({ ...prev, [col.id]: { ...prev[col.id], [k]: e.target.value } }))}
                          style={{ padding: '5px 8px', border: '1px solid #fde68a', borderRadius: 6, fontSize: 12,
                            background: '#fff', color: '#374151' }} />
                        <button onClick={() => setEditVarsMap(prev => {
                          const copy = { ...prev[col.id] }; delete copy[k]
                          return { ...prev, [col.id]: copy }
                        })} style={{ background: 'none', border: 'none', color: '#9ca3af', cursor: 'pointer', fontSize: 14 }}>✕</button>
                      </>
                    ))}
                    {/* new row */}
                    <input placeholder="KEY" id={`new-k-${col.id}`}
                      style={{ padding: '5px 8px', border: '1px dashed #fcd34d', borderRadius: 6, fontSize: 12,
                        background: '#fff', color: '#374151', fontFamily: 'monospace' }} />
                    <input placeholder="value" id={`new-v-${col.id}`}
                      style={{ padding: '5px 8px', border: '1px dashed #fcd34d', borderRadius: 6, fontSize: 12, background: '#fff', color: '#374151' }} />
                    <button onClick={() => {
                      const k = document.getElementById(`new-k-${col.id}`)?.value?.trim()
                      const v = document.getElementById(`new-v-${col.id}`)?.value || ''
                      if (!k) return
                      setEditVarsMap(prev => ({ ...prev, [col.id]: { ...prev[col.id], [k]: v } }))
                      document.getElementById(`new-k-${col.id}`).value = ''
                      document.getElementById(`new-v-${col.id}`).value = ''
                    }} style={{ padding: '5px 10px', background: '#10b981', color: '#fff',
                      border: 'none', borderRadius: 6, fontSize: 12, cursor: 'pointer', fontWeight: 600 }}>+ Add</button>
                  </div>
                  <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                    <button onClick={() => setEditVarsId(null)}
                      style={{ padding: '6px 14px', border: '1px solid #e5e7eb', borderRadius: 7,
                        background: '#fff', fontSize: 12, cursor: 'pointer', color: '#374151' }}>Cancel</button>
                    <button onClick={() => handleSaveVars(col)}
                      style={{ padding: '6px 14px', background: '#d97706', color: '#fff',
                        border: 'none', borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Save Variables</button>
                  </div>
                </div>
              )
            })()}

            {/* expanded API list */}
            {isExpanded && (() => {
              const expMap = editExpectedMap[col.id] || {}
              const storedMap = col.expected_status_codes || {}
              return (
                <div style={{ borderBottom: run ? '1px solid #f3f4f6' : 'none' }}>
                  {/* API list header */}
                  <div style={{ padding: '7px 18px', background: '#f8fafc', borderBottom: '1px solid #f3f4f6' }}>
                    <span style={{ fontSize: 11, color: '#6b7280', fontWeight: 600 }}>
                      {apiList.length} API{apiList.length !== 1 ? 's' : ''} — edit expected status and click away to save
                    </span>
                  </div>

                  {apiList.length === 0 ? (
                    <div style={{ padding: '16px 18px', color: '#9ca3af', fontSize: 12 }}>No requests found in this collection.</div>
                  ) : apiList.map((api, i) => {
                    const res = runMap[api.name]
                    const expVal = expMap[api.name] !== undefined
                      ? expMap[api.name]
                      : String((col.expected_status_codes || {})[api.name] ?? 200)
                    return (
                      <div key={i} style={{
                        display: 'flex', alignItems: 'center', gap: 12, padding: '9px 18px',
                        borderBottom: i < apiList.length - 1 ? '1px solid #f9fafb' : 'none',
                        background: i % 2 === 0 ? '#fff' : '#fafafa',
                      }}>
                        {/* method badge */}
                        <span style={{
                          fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 5, flexShrink: 0,
                          background: (METHOD_COLOR[api.method] || '#6b7280') + '18',
                          color: METHOD_COLOR[api.method] || '#6b7280',
                          minWidth: 46, textAlign: 'center',
                        }}>{api.method}</span>

                        {/* name + url */}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 12, fontWeight: 600, color: '#111827' }}>{api.name}</div>
                          <div style={{ fontSize: 10, color: '#9ca3af', fontFamily: 'monospace',
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {api.url || '—'}
                          </div>
                        </div>

                        {/* expected status input */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0 }}>
                          <span style={{ fontSize: 10, color: '#9ca3af', whiteSpace: 'nowrap' }}>Expected:</span>
                          <input
                            type="number"
                            value={expVal}
                            onChange={e => setEditExpectedMap(prev => ({
                              ...prev,
                              [col.id]: { ...(prev[col.id] || {}), [api.name]: e.target.value }
                            }))}
                            placeholder="200"
                            min="100" max="599"
                            style={{ width: 64, padding: '3px 6px', border: `1px solid ${expVal ? '#6366f1' : '#e5e7eb'}`,
                              borderRadius: 5, fontSize: 11, textAlign: 'center', fontFamily: 'monospace',
                              color: expVal ? '#4f46e5' : '#9ca3af', outline: 'none',
                              background: expVal ? '#eef2ff' : '#fff' }}
                          />
                        </div>

                        {/* result from last run */}
                        {res && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                            <span style={{ fontSize: 11, fontWeight: 700,
                              color: res.status == null ? '#9ca3af' : res.passed ? '#10b981' : '#ef4444' }}>
                              {res.status ?? '—'}
                            </span>
                            <span style={{ fontSize: 10, color: '#9ca3af' }}>{res.duration_ms}ms</span>
                            <span style={{ fontWeight: 700, fontSize: 13, color: res.passed ? '#10b981' : '#ef4444' }}>
                              {res.passed ? '✓' : '✗'}
                            </span>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )
            })()}

            {/* run results */}
            {run && !run.error && (
              <div style={{ padding: '0 18px 16px' }}>
                {/* summary bar */}
                <div style={{ display: 'flex', gap: 20, padding: '10px 0', borderBottom: '1px solid #f3f4f6', marginBottom: 4, fontSize: 12 }}>
                  <span style={{ color: '#6b7280' }}>All tests: <strong style={{ color: '#111827' }}>{run.total}</strong></span>
                  <span style={{ color: '#10b981' }}>Passed: <strong>{run.passed}</strong></span>
                  {run.failed > 0 && <span style={{ color: '#ef4444' }}>Failed: <strong>{run.failed}</strong></span>}
                  {run.duration_ms > 0 && <span style={{ color: '#6b7280' }}>Duration: <strong>{run.duration_ms}ms</strong></span>}
                </div>

                {(run.results || []).map((r, i) => (
                  <div key={i}
                    onClick={() => setDetailModal(r)}
                    style={{ borderBottom: i < run.results.length - 1 ? '1px solid #f9fafb' : 'none',
                      padding: '10px 6px', borderRadius: 6, cursor: 'pointer', transition: 'background 0.12s' }}
                    onMouseEnter={e => e.currentTarget.style.background = '#f8fafc'}
                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                    {/* request row */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 4, flexShrink: 0,
                        background: (METHOD_COLOR[r.method] || '#6b7280') + '18',
                        color: METHOD_COLOR[r.method] || '#6b7280' }}>{r.method}</span>
                      <span style={{ fontWeight: 600, fontSize: 13, color: '#111827', flex: 1 }}>{r.name}</span>
                      <span style={{ fontWeight: 700, fontSize: 12,
                        color: r.status == null ? '#9ca3af' : r.status < 400 ? '#10b981' : '#ef4444' }}>
                        {r.status ?? '—'}
                      </span>
                      <span style={{ fontSize: 11, color: '#9ca3af', minWidth: 60, textAlign: 'right' }}>{r.duration_ms}ms</span>
                      {r.response_size > 0 && (
                        <span style={{ fontSize: 11, color: '#9ca3af', minWidth: 60, textAlign: 'right' }}>
                          {r.response_size >= 1024 ? (r.response_size / 1024).toFixed(2) + ' KB' : r.response_size + ' B'}
                        </span>
                      )}
                    </div>
                    {/* URL */}
                    <div style={{ fontSize: 11, color: '#9ca3af', fontFamily: 'monospace', marginTop: 2, marginLeft: 0,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.url}</div>
                    {/* assertions */}
                    {(r.assertions || []).map((a, ai) => (
                      <div key={ai} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4, marginLeft: 4 }}>
                        <span style={{ fontSize: 10, fontWeight: 700, padding: '1px 7px', borderRadius: 4,
                          background: a.passed ? '#dcfce7' : '#fee2e2',
                          color: a.passed ? '#15803d' : '#b91c1c' }}>
                          {a.passed ? 'PASS' : 'FAIL'}
                        </span>
                        <span style={{ fontSize: 11, color: '#6b7280' }}>{a.name}</span>
                        {!a.passed && a.error && (
                          <span style={{ fontSize: 11, color: '#ef4444' }}>— {a.error}</span>
                        )}
                      </div>
                    ))}
                    {r.error && !r.assertions?.length && (
                      <div style={{ fontSize: 11, color: '#ef4444', marginTop: 4 }}>Error: {r.error}</div>
                    )}
                    {/* failure reason / response body */}
                    {!r.passed && (r.failure_reason || r.response_body) && (() => {
                      const body = r.response_body || r.failure_reason || ''
                      const isJson = body.trim().startsWith('{') || body.trim().startsWith('[')
                      return (
                        <div style={{ marginTop: 6, marginLeft: 4, background: '#fef2f2',
                          border: '1px solid #fecaca', borderRadius: 7, overflow: 'hidden' }}>
                          <div style={{ padding: '5px 10px', fontSize: 10, fontWeight: 700,
                            color: '#b91c1c', background: '#fee2e2', letterSpacing: '0.04em',
                            display: 'flex', alignItems: 'center', gap: 6 }}>
                            ✗ FAILURE REASON
                            {r.status && <span style={{ fontWeight: 400, color: '#dc2626' }}>· HTTP {r.status}</span>}
                          </div>
                          <pre style={{ margin: 0, padding: '8px 10px', fontSize: 11, color: '#7f1d1d',
                            fontFamily: 'monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                            maxHeight: 200, overflowY: 'auto', lineHeight: 1.5 }}>
                            {body}
                          </pre>
                        </div>
                      )
                    })()}
                  </div>
                ))}
              </div>
            )}
            {run?.error && (
              <div style={{ padding: '10px 18px 14px', color: '#ef4444', fontSize: 12 }}>Error: {run.error}</div>
            )}

            </>)}
          </div>
        )
      })}

      {/* API detail popup */}
      {detailModal && (() => {
        const r = detailModal
        const statusColor = r.status == null ? '#9ca3af' : r.status < 300 ? '#15803d' : r.status < 400 ? '#d97706' : '#b91c1c'
        const statusBg    = r.status == null ? '#f3f4f6' : r.status < 300 ? '#dcfce7' : r.status < 400 ? '#fef9c3' : '#fee2e2'

        /* ── minimised bar ── */
        if (modalMinimised) {
          return (
            <div style={{ position: 'fixed', bottom: 0, left: '50%', transform: 'translateX(-50%)',
              width: 560, maxWidth: '96vw', zIndex: 1000,
              background: '#1e293b', borderRadius: '12px 12px 0 0',
              boxShadow: '0 -4px 24px rgba(0,0,0,0.22)',
              display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px', cursor: 'pointer' }}
              onClick={() => setModalMinimised(false)}>
              <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 4,
                background: (METHOD_COLOR[r.method] || '#6b7280') + '33',
                color: METHOD_COLOR[r.method] || '#94a3b8' }}>{r.method}</span>
              <span style={{ fontSize: 13, fontWeight: 600, color: '#f1f5f9', flex: 1,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
              <span style={{ fontSize: 12, fontWeight: 700, padding: '2px 10px', borderRadius: 6,
                background: statusBg, color: statusColor }}>{r.status ?? '—'}</span>
              <span style={{ fontSize: 12, color: '#94a3b8' }}>▲ Expand</span>
              <button onClick={e => { e.stopPropagation(); setDetailModal(null); setModalMinimised(false) }}
                style={{ background: 'none', border: 'none', color: '#64748b', fontSize: 16,
                  cursor: 'pointer', lineHeight: 1, padding: '0 2px' }}>✕</button>
            </div>
          )
        }

        /* ── full popup ── */
        return (
          <div
            onClick={() => setDetailModal(null)}
            style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex',
              alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
            <div
              onClick={e => e.stopPropagation()}
              style={{ background: '#fff', borderRadius: 16, width: 680, maxWidth: '96vw',
                maxHeight: '90vh', display: 'flex', flexDirection: 'column',
                boxShadow: '0 24px 64px rgba(0,0,0,0.22)' }}>

              {/* header */}
              <div style={{ padding: '18px 22px 14px', borderBottom: '1px solid #f1f5f9',
                display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                <span style={{ fontSize: 11, fontWeight: 700, padding: '3px 9px', borderRadius: 5, flexShrink: 0, marginTop: 2,
                  background: (METHOD_COLOR[r.method] || '#6b7280') + '18',
                  color: METHOD_COLOR[r.method] || '#6b7280' }}>{r.method}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 15, color: '#111827', marginBottom: 3 }}>{r.name}</div>
                  <div style={{ fontSize: 11, color: '#6b7280', fontFamily: 'monospace', wordBreak: 'break-all' }}>{r.url}</div>
                </div>
                <span style={{ fontSize: 13, fontWeight: 800, padding: '4px 12px', borderRadius: 7,
                  background: statusBg, color: statusColor, flexShrink: 0 }}>
                  {r.status ?? '—'}
                </span>
                {/* minimise */}
                <button onClick={() => setModalMinimised(true)}
                  title="Minimise"
                  style={{ background: 'none', border: 'none', fontSize: 16, color: '#9ca3af',
                    cursor: 'pointer', flexShrink: 0, lineHeight: 1, padding: '2px 6px' }}>▼</button>
                <button onClick={() => { setDetailModal(null); setModalMinimised(false) }}
                  style={{ background: 'none', border: 'none', fontSize: 18, color: '#9ca3af',
                    cursor: 'pointer', flexShrink: 0, lineHeight: 1, padding: '2px 4px' }}>✕</button>
              </div>

              {/* body — scrollable */}
              <div style={{ overflowY: 'auto', flex: 1, padding: '16px 22px 22px' }}>

                {/* timing strip */}
                <div style={{ display: 'flex', gap: 20, marginBottom: 16, padding: '10px 14px',
                  background: '#f8fafc', borderRadius: 9, fontSize: 12 }}>
                  <div>
                    <div style={{ color: '#9ca3af', fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Status</div>
                    <div style={{ fontWeight: 700, color: statusColor, marginTop: 2 }}>{r.status ?? '—'}</div>
                  </div>
                  <div>
                    <div style={{ color: '#9ca3af', fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Time</div>
                    <div style={{ fontWeight: 600, color: '#374151', marginTop: 2 }}>{r.duration_ms}ms</div>
                  </div>
                  {r.response_size > 0 && (
                    <div>
                      <div style={{ color: '#9ca3af', fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Size</div>
                      <div style={{ fontWeight: 600, color: '#374151', marginTop: 2 }}>
                        {r.response_size >= 1024 ? (r.response_size / 1024).toFixed(2) + ' KB' : r.response_size + ' B'}
                      </div>
                    </div>
                  )}
                  <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
                    {r.passed
                      ? <span style={{ fontSize: 11, fontWeight: 700, color: '#15803d', background: '#dcfce7', padding: '3px 10px', borderRadius: 99 }}>✓ PASSED</span>
                      : <span style={{ fontSize: 11, fontWeight: 700, color: '#b91c1c', background: '#fee2e2', padding: '3px 10px', borderRadius: 99 }}>✗ FAILED</span>}
                  </div>
                </div>

                {/* test assertions */}
                {(r.assertions || []).length > 0 && (
                  <div style={{ marginBottom: 16 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase',
                      letterSpacing: '0.06em', marginBottom: 8 }}>Test Results</div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                      {r.assertions.map((a, ai) => (
                        <div key={ai} style={{ display: 'flex', alignItems: 'flex-start', gap: 8,
                          padding: '7px 10px', borderRadius: 7,
                          background: a.passed ? '#f0fdf4' : '#fef2f2',
                          border: `1px solid ${a.passed ? '#bbf7d0' : '#fecaca'}` }}>
                          <span style={{ fontSize: 10, fontWeight: 700, padding: '1px 7px', borderRadius: 4, flexShrink: 0,
                            background: a.passed ? '#dcfce7' : '#fee2e2',
                            color: a.passed ? '#15803d' : '#b91c1c' }}>
                            {a.passed ? 'PASS' : 'FAIL'}
                          </span>
                          <div style={{ flex: 1 }}>
                            <div style={{ fontSize: 12, color: '#374151' }}>{a.name}</div>
                            {!a.passed && a.error && (
                              <div style={{ fontSize: 11, color: '#ef4444', marginTop: 3 }}>{a.error}</div>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* response body */}
                <div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase',
                    letterSpacing: '0.06em', marginBottom: 8 }}>Response Body</div>
                  {r.response_body ? (
                    <pre style={{ margin: 0, padding: '12px 14px', background: '#0f172a', color: '#e2e8f0',
                      borderRadius: 9, fontSize: 11, fontFamily: 'monospace', lineHeight: 1.6,
                      whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                      maxHeight: 360, overflowY: 'auto' }}>
                      {r.response_body}
                    </pre>
                  ) : (
                    <div style={{ padding: '12px 14px', background: '#f8fafc', borderRadius: 9,
                      fontSize: 12, color: '#9ca3af', fontStyle: 'italic' }}>
                      No response body captured
                    </div>
                  )}
                </div>

                {/* network / connection error */}
                {r.error && (
                  <div style={{ marginTop: 12, padding: '10px 14px', background: '#fef2f2',
                    border: '1px solid #fecaca', borderRadius: 8 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: '#b91c1c', marginBottom: 4 }}>Network Error</div>
                    <div style={{ fontSize: 12, color: '#7f1d1d', fontFamily: 'monospace' }}>{r.error}</div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )
      })()}

      {/* Add Collection modal */}
      {showModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex',
          alignItems: 'center', justifyContent: 'center', zIndex: 999 }}>
          <div style={{ background: '#fff', borderRadius: 16, width: 560, maxWidth: '95vw',
            maxHeight: '90vh', overflow: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.2)' }}>

            <div style={{ padding: '20px 24px 16px', borderBottom: '1px solid #f3f4f6',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ fontWeight: 700, fontSize: 16, color: '#111827' }}>Add Postman Collection</div>
              <button onClick={() => setShowModal(false)}
                style={{ background: 'none', border: 'none', fontSize: 18, color: '#9ca3af', cursor: 'pointer' }}>✕</button>
            </div>

            <div style={{ padding: '20px 24px' }}>
              <div style={{ marginBottom: 14 }}>
                <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 6 }}>
                  Collection Name
                </label>
                <input value={colName} onChange={e => setColName(e.target.value)}
                  placeholder="My API Collection"
                  style={{ width: '100%', padding: '8px 12px', border: '1px solid #e5e7eb', borderRadius: 8,
                    fontSize: 13, color: '#111827', outline: 'none', boxSizing: 'border-box' }} />
              </div>

              <div style={{ marginBottom: 14 }}>
                <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 6 }}>
                  Collection JSON <span style={{ color: '#ef4444' }}>*</span>
                </label>
                <input type="file" accept=".json" onChange={handleFileUpload}
                  style={{ fontSize: 12, color: '#374151' }} />
              </div>

              <div style={{ marginBottom: 14 }}>
                <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>
                  Environment JSON <span style={{ color: '#9ca3af', fontWeight: 400 }}>(optional — resolves {'{{variables}}'})</span>
                </label>
                <input type="file" accept=".json" onChange={handleEnvUpload}
                  style={{ fontSize: 12, color: '#374151' }} />
                {envText && <div style={{ fontSize: 11, color: '#10b981', marginTop: 4 }}>✓ Environment loaded</div>}
              </div>

              <div style={{ marginBottom: 4 }}>
                <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 6 }}>
                  Or paste Collection JSON
                </label>
                <textarea value={jsonText} onChange={e => setJsonText(e.target.value)}
                  placeholder='{"info": {"name": "..."}, "item": [...]}'
                  rows={8}
                  style={{ width: '100%', padding: '10px 12px', border: '1px solid #e5e7eb', borderRadius: 8,
                    fontSize: 12, fontFamily: 'monospace', color: '#374151', resize: 'vertical',
                    outline: 'none', boxSizing: 'border-box' }} />
              </div>

              {saveErr && <div style={{ color: '#ef4444', fontSize: 12, marginBottom: 10 }}>{saveErr}</div>}

              <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 16 }}>
                <button onClick={() => setShowModal(false)}
                  style={{ padding: '8px 18px', border: '1px solid #e5e7eb', borderRadius: 8,
                    background: '#fff', fontSize: 13, cursor: 'pointer', color: '#374151' }}>
                  Cancel
                </button>
                <button onClick={handleSave} disabled={saving || !jsonText.trim()}
                  style={{ padding: '8px 20px', background: saving || !jsonText.trim() ? '#a7f3d0' : '#10b981',
                    color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600,
                    cursor: saving || !jsonText.trim() ? 'not-allowed' : 'pointer' }}>
                  {saving ? 'Saving…' : 'Save Collection'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── App list page ────────────────────────────────────────────────────────────

const APP_TABS = [
  { key: 'apps',        label: 'Apps'        },
  { key: 'api-monitor', label: 'API Monitor' },
]

function AppListPage({ tenant, onBack, onSelectApp }) {
  const [activeTab, setActiveTab] = useState('apps')
  const [apps,      setApps]      = useState([])
  const [loading,   setLoading]   = useState(true)
  const [error,     setError]     = useState(null)
  // Default to "Today" — same behavior as the tenant list page.
  const [dateRange, setDateRange] = useState(() => ({
    start: istMidnightUtc(new Date()),
    end:   new Date(),
    label: 'Today',
  }))

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    const qs = new URLSearchParams()
    if (dateRange?.start) qs.set('start', dateRange.start.toISOString())
    if (dateRange?.end)   qs.set('end',   dateRange.end.toISOString())
    const url = `${API}/api/insights/${encodeURIComponent(tenant.name)}/apps${qs.toString() ? '?' + qs : ''}`
    fetch(url)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() })
      .then(docs => { if (!cancelled) setApps(groupAppInsights(docs)) })
      .catch(e => { if (!cancelled) setError(e.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [tenant.name, dateRange?.start?.getTime(), dateRange?.end?.getTime()])

  const counts = { apps: apps.length, 'api-monitor': 0 }
  const filtered = apps

  // Aggregate metrics for the summary hero
  const agg = apps.reduce((a, app) => {
    a.totalReq += (app.totalReq || 0)
    if (app.errorRate != null) { a.errRateSum += app.errorRate; a.errRateN += 1 }
    if (app.p95Latency != null) { a.p95Max = Math.max(a.p95Max, app.p95Latency) }
    if (app.health != null) { a.healthSum += app.health; a.healthN += 1 }
    return a
  }, { totalReq: 0, errRateSum: 0, errRateN: 0, p95Max: 0, healthSum: 0, healthN: 0 })
  const avgHealth  = agg.healthN  ? Math.round(agg.healthSum / agg.healthN)  : null
  const avgErrRate = agg.errRateN ? (agg.errRateSum / agg.errRateN).toFixed(2) : null
  const healthyCount  = apps.filter(a => a.status === 'healthy').length
  const warningCount  = apps.filter(a => a.status === 'warning').length
  const criticalCount = apps.filter(a => a.status === 'critical').length

  const cardBase = {
    background: '#fff', border: '1px solid #e5e7eb',
    borderRadius: 14, boxShadow: '0 1px 2px rgba(0,0,0,0.03)',
  }
  const tealAccent = '#10B981'
  const tealBg = '#D1FAE5'
  const summaryBg = '#ECFDF5'

  return (
    <div style={{ background: '#fff', minHeight: '100vh', fontFamily: "'Inter', -apple-system, system-ui, sans-serif", overflowY: 'auto' }}>

      {/* ─── Header ─── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 14,
        padding: '14px 24px', background: '#fff', borderBottom: '1px solid #e9ecef',
      }}>
        <button onClick={onBack}
          style={{ background: '#f3f4f6', border: 'none', borderRadius: 8,
            padding: '7px 14px', cursor: 'pointer', fontSize: 13, color: '#374151', fontWeight: 600 }}>
          ← Tenants
        </button>
        <div style={{
          width: 40, height: 40, borderRadius: 10, background: appAvatarColor(tenant.name),
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: '#fff', fontWeight: 800, fontSize: 14, flexShrink: 0,
        }}>{appInitials(tenant.name)}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 17, color: '#111827' }}>{tenant.name}</div>
          <div style={{ fontSize: 12, color: '#9ca3af', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {tenant.description || 'Applications in this tenant'}
          </div>
        </div>
        <div style={{ display: 'inline-flex', gap: 2, padding: 3, background: '#f1f5f9',
          border: '1px solid #e2e8f0', borderRadius: 8 }}>
          {[
            { label: 'Last 1 hour', getRange: () => {
                const now = new Date()
                return { start: new Date(now.getTime() - 3600 * 1000), end: now, label: 'Last 1 hour' }
            }},
            { label: 'Today', getRange: () => {
                const now = new Date()
                return { start: istMidnightUtc(now), end: now, label: 'Today' }
            }},
          ].map(p => {
            const active = dateRange?.label === p.label
            return (
              <button key={p.label} onClick={() => setDateRange(p.getRange())}
                style={{ padding: '6px 14px', fontSize: 12, fontWeight: 600,
                  border: 'none', borderRadius: 6, cursor: 'pointer',
                  background: active ? '#fff' : 'transparent',
                  color: active ? '#1e40af' : '#64748b',
                  boxShadow: active ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
                  transition: 'all 0.15s' }}>
                {p.label}
              </button>
            )
          })}
        </div>
        {!loading && (
          <span style={{
            background: '#f3f4f6', color: '#374151',
            padding: '6px 12px', borderRadius: 999, fontSize: 12, fontWeight: 700,
          }}>{apps.length} Apps</span>
        )}
      </div>

      {/* ─── Tabs ─── */}
      <div style={{
        margin: '8px 24px 0', padding: '4px 0 0',
        display: 'flex', gap: 4, borderBottom: '1px solid #e5e7eb',
      }}>
        {APP_TABS.map(t => (
          <button key={t.key} type="button" onClick={() => setActiveTab(t.key)}
            style={{
              padding: '10px 16px', fontSize: 13, fontWeight: 600,
              color: activeTab === t.key ? '#10B981' : '#6b7280',
              background: 'transparent', border: 'none',
              borderBottom: activeTab === t.key ? '2px solid #10B981' : '2px solid transparent',
              cursor: 'pointer', marginBottom: -1,
              display: 'inline-flex', alignItems: 'center', gap: 6,
            }}>
            {t.label}
            {t.key === 'apps' && (
              <span style={{
                background: activeTab === t.key ? '#ECFDF5' : '#f3f4f6',
                color: activeTab === t.key ? '#10B981' : '#9ca3af',
                padding: '1px 7px', borderRadius: 999, fontSize: 11, fontWeight: 700,
              }}>{counts.apps}</span>
            )}
          </button>
        ))}
      </div>

      {/* ─── Content ─── */}
      {activeTab === 'api-monitor' && <ApiMonitorTab tenant={tenant.name} />}

      {activeTab === 'apps' && loading && (
        <div style={{ padding: 48, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>Loading apps…</div>
      )}
      {activeTab === 'apps' && error && !loading && (
        <div style={{ margin: 24, padding: 14, ...cardBase, borderColor: '#fecaca', background: '#fef2f2', color: '#991b1b' }}>
          Failed to load apps: {error}
        </div>
      )}
      {activeTab === 'apps' && !loading && !error && filtered.length === 0 && (
        <div style={{ padding: 48, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>
          {apps.length === 0 ? 'No analysis data found for this tenant. Run the analysis first.' : 'No apps match this filter.'}
        </div>
      )}
      {activeTab === 'apps' && !loading && !error && filtered.length > 0 && (
        <div style={{
          margin: '14px 24px 24px',
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
          gap: 14,
        }}>
          {filtered.map(app => <AppCard key={app.id} app={app} onSelect={() => onSelectApp(app)} />)}
        </div>
      )}
    </div>
  )
}

// ─── Tenant list page ─────────────────────────────────────────────────────────

const TENANT_TABS = [
  { key: 'all',      label: 'All'      },
  { key: 'healthy',  label: 'Healthy'  },
  { key: 'warning',  label: 'Warning'  },
  { key: 'critical', label: 'Critical' },
]

function deriveStatus(health) {
  if (health == null) return 'no-data'
  if (health >= 80)   return 'healthy'
  if (health >= 50)   return 'warning'
  return 'critical'
}

function TenantListPage({ onSelect }) {
  const [activeTab, setActiveTab] = useState('all')
  const [search,    setSearch]    = useState('')
  const [tenants,   setTenants]   = useState([])
  const [loading,   setLoading]   = useState(true)
  const [error,     setError]     = useState(null)
  // Default to "Today" so existing users see no behavior change. Backend
  // also defaults to today-in-IST when no start/end is sent.
  const [dateRange, setDateRange] = useState(() => ({
    start: istMidnightUtc(new Date()),
    end:   new Date(),
    label: 'Today',
  }))

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    const qs = new URLSearchParams()
    if (dateRange?.start) qs.set('start', dateRange.start.toISOString())
    if (dateRange?.end)   qs.set('end',   dateRange.end.toISOString())
    const url = qs.toString() ? `${INSIGHT_URL}?${qs}` : INSIGHT_URL
    fetch(url)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() })
      .then(d => {
        if (cancelled) return
        const rows = (d.tenants || []).map(t => ({
          id:         t.tenant_name,
          name:       t.tenant_name,
          health:     t.health_score ?? null,
          status:     deriveStatus(t.health_score ?? null),
          appCount:   t.app_count ?? null,
          analyzedAt: t.analyzed_at ?? null,
          workflow:   t.workflow ?? null,
          api:        t.api ?? null,
        })).sort((a, b) => a.name.localeCompare(b.name))
        setTenants(rows)
      })
      .catch(e => { if (!cancelled) setError(e.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [dateRange?.start?.getTime(), dateRange?.end?.getTime()])

  const filtered = tenants.filter(t => {
    const matchTab    = activeTab === 'all' || t.status === activeTab
    const matchSearch = !search || t.name.toLowerCase().includes(search.toLowerCase())
    return matchTab && matchSearch
  })

  const counts = TENANT_TABS.reduce((acc, t) => {
    acc[t.key] = t.key === 'all' ? tenants.length : tenants.filter(r => r.status === t.key).length
    return acc
  }, {})

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
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 24px 0', position: 'relative', zIndex: 1 }}>
          <div style={{ width: 38, height: 38, borderRadius: 10, background: 'linear-gradient(135deg,#6366f1,#4f46e5)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', flexShrink: 0 }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>
              <path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>
            </svg>
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 800, fontSize: 16, color: '#0f172a', letterSpacing: '-0.3px' }}>Tenant &amp; Apps</div>
            <div style={{ fontSize: 11.5, color: '#94a3b8', marginTop: 1 }}>Manage tenants and their associated applications</div>
          </div>
          {/* Date range + search */}
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexShrink: 0 }}>
            <div style={{ display: 'inline-flex', gap: 2, padding: 3, background: '#f1f5f9', border: '1px solid #e2e8f0', borderRadius: 8 }}>
              {[
                { label: 'Last 1 hour', getRange: () => {
                    const now = new Date()
                    return { start: new Date(now.getTime() - 3600 * 1000), end: now, label: 'Last 1 hour' }
                }},
                { label: 'Today', getRange: () => {
                    const now = new Date()
                    return { start: istMidnightUtc(now), end: now, label: 'Today' }
                }},
              ].map(p => {
                const active = dateRange?.label === p.label
                return (
                  <button key={p.label} onClick={() => setDateRange(p.getRange())}
                    style={{ padding: '6px 14px', fontSize: 12, fontWeight: 600,
                      border: 'none', borderRadius: 6, cursor: 'pointer',
                      background: active ? '#fff' : 'transparent',
                      color: active ? '#1e40af' : '#64748b',
                      boxShadow: active ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
                      transition: 'all 0.15s' }}>
                    {p.label}
                  </button>
                )
              })}
            </div>
            <div className={styles.searchWrap}>
              <svg className={styles.searchIcon} viewBox="0 0 24 24" fill="none" stroke="#9ca3af" strokeWidth="2">
                <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
              </svg>
              <input className={styles.searchInput} placeholder="Search tenants…"
                value={search} onChange={e => setSearch(e.target.value)} />
            </div>
          </div>
        </div>
        {/* Tabs sit inside the header bar */}
        <div className={styles.tabBar} style={{ padding: '10px 24px', position: 'relative', zIndex: 1 }}>
          {TENANT_TABS.map(t => (
            <button key={t.key}
              className={`${styles.tab} ${activeTab === t.key ? styles.tabActive : ''}`}
              onClick={() => setActiveTab(t.key)}>
              {t.label} <span className={styles.tabCount}>({counts[t.key]})</span>
            </button>
          ))}
        </div>
      </div>{/* end sticky header */}

      {/* ── Content ── */}
      <div style={{ padding: '24px' }}>

      {/* States */}
      {loading && (
        <div style={{ minHeight: 'calc(100vh - 160px)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
          <style>{`
            @keyframes taRadarSpin { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }
            @keyframes taRadarPing { 0%{transform:scale(.5);opacity:.7} 100%{transform:scale(1.5);opacity:0} }
            @keyframes taRadarDot  { 0%,100%{opacity:.3;transform:translateY(0) scale(.8)} 40%{opacity:1;transform:translateY(-3px) scale(1)} }
          `}</style>
          <div style={{ position: 'relative', width: 40, height: 40 }}>
            <div style={{ position: 'absolute', inset: 0, borderRadius: '50%', border: '1.5px solid #10b981', animation: 'taRadarPing 1.8s ease-out infinite' }} />
            <svg width="40" height="40" viewBox="0 0 40 40" style={{ position: 'absolute', inset: 0, animation: 'taRadarSpin 3s linear infinite' }}>
              <circle cx="20" cy="20" r="18" stroke="#10b981" strokeWidth="1.5" fill="none" strokeDasharray="4 3" opacity="0.55"/>
            </svg>
            <svg width="40" height="40" viewBox="0 0 40 40" style={{ position: 'absolute', inset: 0 }}>
              <circle cx="20" cy="20" r="12" stroke="#10b981" strokeWidth="1.2" fill="none" opacity="0.3"/>
              <circle cx="20" cy="20" r="6.5" stroke="#10b981" strokeWidth="1.5" fill="none" opacity="0.8"/>
              <circle cx="20" cy="20" r="2.5" fill="#10b981"/>
              <line x1="20" y1="14.5" x2="20" y2="17" stroke="#10b981" strokeWidth="1.2" strokeLinecap="round"/>
              <line x1="20" y1="23" x2="20" y2="25.5" stroke="#10b981" strokeWidth="1.2" strokeLinecap="round"/>
              <line x1="14.5" y1="20" x2="17" y2="20" stroke="#10b981" strokeWidth="1.2" strokeLinecap="round"/>
              <line x1="23" y1="20" x2="25.5" y2="20" stroke="#10b981" strokeWidth="1.2" strokeLinecap="round"/>
            </svg>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 12, color: '#94a3b8', fontWeight: 500 }}>
            <span>Loading</span>
            {[0, 1, 2].map(i => (
              <span key={i} style={{
                display: 'inline-block', width: 3, height: 3, borderRadius: '50%',
                background: '#10b981',
                animation: 'taRadarDot 1.2s ease-in-out infinite',
                animationDelay: `${i * 0.2}s`,
              }} />
            ))}
          </div>
        </div>
      )}
      {error && !loading && (
        <div className={styles.errorBox}>
          Failed to load tenants: {error}
        </div>
      )}

      {/* Table */}
      {!loading && !error && (
        <div className={styles.tenantRows}>
          <div className={styles.tenantRowHead}>
            <span className={styles.colName}>Tenant</span>
            <span className={styles.colGroup}>
              <span className={styles.colGroupLabel}>Workflow</span>
              <span className={styles.colGroupSub}><span>Success</span><span>Failed</span></span>
            </span>
            <span className={styles.colGroup}>
              <span className={styles.colGroupLabel}>API</span>
              <span className={styles.colGroupSub}><span>Success</span><span>Failed</span></span>
            </span>
            <span className={styles.colSmall}>Health</span>
            <span className={styles.colSmall}>Apps</span>
            <span className={styles.colSmall}>Analyzed</span>
          </div>

          {filtered.map(t => {
            const sm = statusMeta(t.status)
            return (
              <div key={t.id || t.name} className={styles.tenantRow} onClick={() => onSelect(t)}>
                <div className={styles.colName}>
                  <span className={styles.tenantDot} style={{ background: sm.dot }} />
                  <div>
                    <div className={styles.tenantRowName}>{t.name}</div>
                    {t.description && <div className={styles.tenantRowDesc}>{t.description}</div>}
                  </div>
                </div>
                <div className={styles.colGroupValues}>
                  {t.workflow
                    ? <><span className={styles.successVal}>{fmt(t.workflow.success)}</span><span className={styles.failedVal}>{fmt(t.workflow.failed)}</span></>
                    : <span className={styles.noData} style={{ gridColumn: '1 / -1', textAlign: 'center' }}>—</span>}
                </div>
                <div className={styles.colGroupValues}>
                  {t.api
                    ? <><span className={styles.successVal}>{fmt(t.api.success)}</span><span className={styles.failedVal}>{fmt(t.api.failed)}</span></>
                    : <span className={styles.noData} style={{ gridColumn: '1 / -1', textAlign: 'center' }}>—</span>}
                </div>
                <div className={styles.colSmall}>
                  {t.health != null
                    ? <span style={{ color: healthColor(t.health), fontWeight: 700, fontSize: 14 }}>{t.health}</span>
                    : <span className={styles.noData}>—</span>}
                </div>
                <div className={styles.colSmall}>
                  {t.appCount != null
                    ? <span className={styles.appCountChip}>{t.appCount}</span>
                    : <span className={styles.noData}>—</span>}
                </div>
                <div className={styles.colSmall}>
                  <span style={{ fontSize: 12, color: '#9ca3af' }}>{relTime(t.analyzedAt)}</span>
                </div>
              </div>
            )
          })}

          {filtered.length === 0 && (
            <div className={styles.emptyState}>
              {tenants.length === 0
                ? 'No analysis data found. Run the analysis first.'
                : 'No tenants match your filter.'}
            </div>
          )}
        </div>
      )}
      </div>{/* end content */}
    </div>
  )
}

// ─── Workflow helpers ─────────────────────────────────────────────────────────

function wfResolution(step) {
  const reasons = Object.keys(step.failure_reasons || {})
  const tips = []
  for (const r of reasons) {
    const rl = r.toLowerCase()
    if (rl.includes('reset') || rl.includes('connection_failure') || rl.includes('uc'))
      tips.push('Connection reset by upstream — check pod health, resource limits (CPU/memory OOM), and network policies.')
    if (rl.includes('timeout') || rl.includes('urx') || rl.includes('deadline'))
      tips.push('Request timeout — increase Istio timeout in VirtualService or optimize backend response time for this path.')
    if (rl.includes('nr') || rl.includes('no_route'))
      tips.push('No route found — verify VirtualService/DestinationRule configuration for this path and namespace.')
    if (rl.includes('uh') || rl.includes('no_healthy') || rl.includes('unhealthy'))
      tips.push('No healthy upstream pods — check readiness probes, pod crash loops, and service endpoint status.')
    if (rl.includes('rl') || rl.includes('overflow') || rl.includes('rate_limit'))
      tips.push('Rate limited or connection pool overflow — increase connectionPool limits in DestinationRule.')
    if (rl.includes('fi') || rl.includes('fault'))
      tips.push('Fault injection active — check if an Istio FaultInjection policy is intentionally set for this route.')
    if (rl.includes('503'))
      tips.push('503 Service Unavailable — upstream not ready. Check pod logs and scaling policy.')
    if (rl.includes('502'))
      tips.push('502 Bad Gateway — upstream returned an invalid response. Check pod logs for panics or crashes.')
  }
  if (tips.length === 0 && step.errors > 0) {
    const rate = step.calls > 0 ? step.errors / step.calls : 0
    if (rate > 0.5)
      tips.push('High failure rate (>50%) — investigate backend pod logs for this endpoint and check for recent deployments.')
    else
      tips.push('Review backend service logs for this path. Check Istio metrics and recent config changes.')
  }
  if (step.avg_duration_ms > 5000)
    tips.push('High average latency (>5s) — profile backend processing, check external DB/API dependencies.')
  return [...new Set(tips)]
}

// ─── Workflow Flow Page ───────────────────────────────────────────────────────

function execStatusMeta(status) {
  const s = (status || '').toLowerCase()
  if (s.includes('completed')) return { label: 'Completed', color: '#059669', bg: '#ecfdf5', border: '#6ee7b7' }
  if (s.includes('failed'))    return { label: 'Failed',    color: '#dc2626', bg: '#fef2f2', border: '#fca5a5' }
  if (s.includes('running'))   return { label: 'Running',   color: '#2563eb', bg: '#eff6ff', border: '#93c5fd' }
  return                              { label: status || '—', color: '#6b7280', bg: '#f9fafb', border: '#e5e7eb' }
}

function fmtTs(ts) {
  if (!ts) return '—'
  return new Date(ts * 1000).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
}

function fmtDur(ms) {
  if (ms == null) return '—'
  if (ms < 1000)  return ms + 'ms'
  if (ms < 60000) return (ms / 1000).toFixed(1) + 's'
  return Math.floor(ms / 60000) + 'm ' + Math.floor((ms % 60000) / 1000) + 's'
}

// fmtMs: timestamp already in milliseconds (epoch ms, 13 digits)
function fmtMs(ms) {
  if (!ms) return '—'
  return new Date(ms).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
}

function WorkflowFlowPage({ tenant, app, metrics, onBack, embedded = false, dateRange: dateRangeProp, onDateChange }) {
  const [activeTab,    setActiveTab]    = useState('history')
  const [selectedStep, setSelectedStep] = useState(null)
  const [dateRangeInternal, setDateRangeInternal] = useState({ start: new Date(Date.now() - 30 * 86400000), end: new Date(), label: 'Last 30 days' })
  const dateRange = dateRangeProp || dateRangeInternal
  const handleDateChange = (dr) => {
    if (onDateChange) onDateChange(dr)
    else setDateRangeInternal(dr)
    setExecPage(1)
  }

  // Execution history state
  const EXEC_PAGE_SIZE = 20
  const [integration,    setIntegration]    = useState(null)
  const [execData,       setExecData]       = useState(null)
  const [execLoading,    setExecLoading]    = useState(false)
  const [execError,      setExecError]      = useState(null)
  const [execPage,       setExecPage]       = useState(1)
  const [execFilter,     setExecFilter]     = useState('')
  const [runlogData,     setRunlogData]     = useState(null)
  const [failedWfs,      setFailedWfs]      = useState(null)   // from OpenSearch logs
  const [hoveredStat,    setHoveredStat]    = useState(null)
  const [selectedWf,     setSelectedWf]     = useState(null)
  const [temporalData,   setTemporalData]   = useState(null)
  const [temporalLoading,setTemporalLoading]= useState(false)
  const [temporalError,  setTemporalError]  = useState(null)
  const [expandedEvidence, setExpandedEvidence] = useState(() => new Set())
  const [wfTab,          setWfTab]          = useState('failed')
  const [wfSearch,       setWfSearch]       = useState('')
  const [executionSearchOpen, setExecutionSearchOpen] = useState(false)
  const [executionSearchId, setExecutionSearchId] = useState('')
  const [executionSearchText, setExecutionSearchText] = useState('')
  const [executionSearchError, setExecutionSearchError] = useState('')
  const [activeExecutionSearch, setActiveExecutionSearch] = useState(null)
  const [envFilter,      setEnvFilter]      = useState('all')
  const [envDropOpen,    setEnvDropOpen]    = useState(false)
  const [fixNote,        setFixNote]        = useState('')
  const [fixNoteSubmitted, setFixNoteSubmitted] = useState(false)
  const [showFlowViz,    setShowFlowViz]    = useState(false)
  const [flowSelectedNode, setFlowSelectedNode] = useState(null)

  const closeWfModal = () => {
    setSelectedWf(null)
    setTemporalData(null)
    setTemporalError(null)
    setTemporalLoading(false)
    setExpandedEvidence(new Set())
    setFixNote('')
    setFixNoteSubmitted(false)
  }

  const investigateWorkflow = async (workflowId) => {
    if (!workflowId) return
    setTemporalLoading(true)
    setTemporalError(null)
    setTemporalData(null)
    setExpandedEvidence(new Set())
    try {
      const res = await fetch(`${API}/api/temporal/investigate?workflow_id=${encodeURIComponent(workflowId)}`)
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail || `HTTP ${res.status}`)
      }
      const json = await res.json()
      setTemporalData(json)
    } catch (e) {
      setTemporalError(e.message)
    } finally {
      setTemporalLoading(false)
    }
  }

  const wf    = metrics || {}
  const steps = wf.steps || []

  const NODE_W = 300, NODE_H = 76, NODE_GAP = 52
  const SVG_W  = 700
  const TRIG_H = 52, TRIG_Y = 24
  const nodeY  = i => TRIG_Y + TRIG_H + 44 + i * (NODE_H + NODE_GAP)
  const centerX = SVG_W / 2
  const nodeX   = (SVG_W - NODE_W) / 2
  const totalH  = nodeY(steps.length) + 48

  function stepColor(s) {
    const r = s.calls > 0 ? s.errors / s.calls : 0
    return r > 0.1 ? '#ef4444' : r > 0.03 ? '#f59e0b' : '#10b981'
  }

  const truncPath = p => p.length > 40 ? '…' + p.slice(-37) : p

  const failingSteps  = steps.filter(s => s.errors > 0).sort((a, b) => b.errors - a.errors)
  const healthySteps  = steps.filter(s => !s.errors)

  // Dashboard — computed from execData (date-range-filtered via API)
  const instances      = execData?.results || []
  // Live-OpenSearch failed workflows not yet persisted in MongoDB. Mapped into
  // the same shape as MongoDB executions so the table render is uniform.
  const instancesFromOS = (failedWfs || [])
    .filter(wf => wf.workflowId && !instances.some(e => e.workflow_id === wf.workflowId))
    .map(wf => ({
      workflow_id:   wf.workflowId,
      process_name:  wf.processName || wf.workflowName || '',
      workflow_name: wf.workflowName || '',
      status:        'failed',
      start_time:    wf.timestamp,
      error_message: wf.reason,
      stack_trace:   wf.stack_trace,
      environment:   '',
      _src:          'os',
    }))
  const mergedInstances = [...instances, ...instancesFromOS]
  const failedCount    = execData?.failed    ?? null
  const runningCount   = execData?.running   ?? null
  const totalCount     = execData?.totalSize ?? null
  const completedCount = totalCount != null
    ? Math.max(0, totalCount - (failedCount ?? 0) - (runningCount ?? 0))
    : (execData?.completed ?? null)
  const successCount   = completedCount ?? 0
  const fivexxRe = /\b5\d{2}\b|Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout|HTTP\/?\s*5/i
  const fivexxCount = (() => {
    const fromExec = instances.filter(wf => {
      if ((wf.status || '').toLowerCase() !== 'failed') return false
      const msg = (wf.error_message || '') + ' ' + (wf.root_cause || '') + ' ' + (wf.exception || '')
      return fivexxRe.test(msg)
    }).length
    const execIds = new Set(instances.filter(wf => fivexxRe.test((wf.error_message || '') + ' ' + (wf.root_cause || ''))).map(w => w.workflow_id))
    const fromOS = (failedWfs || []).filter(wf => fivexxRe.test(wf.reason || '') && !execIds.has(wf.workflowId)).length
    return fromExec + fromOS
  })()
  const topErrors = (() => {
    const types = {}
    instances.forEach(wf => {
      const key = wf.root_cause || (wf.error_message ? wf.error_message.split(':')[0].slice(0, 60).trim() : 'Unknown Error')
      types[key] = (types[key] || 0) + 1
    })
    return Object.entries(types).sort((a, b) => b[1] - a[1]).slice(0, 6)
  })()

  const SubLabel = ({ children }) => (
    <div style={{ fontSize: 10.5, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase',
      letterSpacing: '0.07em', marginBottom: 8, marginTop: 16 }}>{children}</div>
  )

  // Load failed workflows — live query with date range
  useEffect(() => {
    setFailedWfs(null)
    const params = new URLSearchParams()
    if (dateRange?.start && dateRange?.end) {
      params.set('start', dateRange.start.toISOString())
      params.set('end', dateRange.end.toISOString())
    } else {
      params.set('hours', '1')
    }
    fetch(`${API}/api/insights/${tenant.name}/apps/${encodeURIComponent(app.name)}/failed-workflows?${params}`)
      .then(r => r.ok ? r.json() : [])
      .then(data => setFailedWfs(Array.isArray(data) ? data : []))
      .catch(() => setFailedWfs([]))
  }, [activeTab, dateRange])

  // Load Jiffy integration on mount (still needed for runlog)
  useEffect(() => {
    fetch(`${API}/api/integrations/jiffy`)
      .then(r => r.ok ? r.json() : [])
      .then(list => setIntegration(list[0] || null))
      .catch(() => {})
  }, [])

  // Debounced search — wait 400ms after typing before firing API call
  const [debouncedSearch, setDebouncedSearch] = useState('')
  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(wfSearch.trim())
      setExecPage(1)
    }, 400)
    return () => clearTimeout(t)
  }, [wfSearch])

  // Load executions from MongoDB — filtered by date range + search
  useEffect(() => {
    setExecLoading(true)
    setExecError(null)
    const qs = new URLSearchParams({
      limit:  EXEC_PAGE_SIZE,
      offset: (execPage - 1) * EXEC_PAGE_SIZE,
      ...(execFilter ? { status: execFilter } : {}),
    })
    if (debouncedSearch) qs.set('search', debouncedSearch)
    if (dateRange?.start && dateRange?.end) {
      qs.set('start', dateRange.start.toISOString())
      qs.set('end', dateRange.end.toISOString())
    }
    fetch(`${API}/api/insights/${encodeURIComponent(tenant.name)}/apps/${encodeURIComponent(app.name)}/executions?${qs}`)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() })
      .then(data => setExecData(data))
      .catch(e => setExecError(e.message))
      .finally(() => setExecLoading(false))
  }, [activeTab, execPage, execFilter, dateRange, debouncedSearch])

  function handleExecutionSearch(e) {
    e.preventDefault()
    const workflowId = executionSearchId.trim()
    const searchText = executionSearchText.trim()

    if (!workflowId) {
      setExecutionSearchError('Enter an execution ID to search.')
      return
    }
    if (!searchText) {
      setExecutionSearchError('Describe what you are searching for.')
      return
    }

    setExecutionSearchError('')
    setActiveExecutionSearch({ workflowId, searchText })
    setWfTab('failed')
    setWfSearch(workflowId)

    const matched = mergedInstances.find(wf =>
      String(wf.workflow_id || '').toLowerCase() === workflowId.toLowerCase()
    )
    const wf = matched || {
      workflow_id: workflowId,
      process_name: searchText,
      workflow_name: '',
      status: 'failed',
      start_time: '',
      error_summary: `Searching for: ${searchText}`,
      error_message: '',
      environment: '',
      _src: 'manual',
    }
    setSelectedWf(wf)
    investigateWorkflow(workflowId)
  }

  function openRunlog(exec) {
    if (!integration) return
    // Use workflowId (UUID) as execution ID for the runlog API
    const execId = exec.workflowId || exec.runId || exec.id
    setRunlogData({ exec, events: null, loading: true, error: null })
    const qs = new URLSearchParams({ tenant_name: tenant.name, app_name: app.name })
    fetch(`${API}/api/integrations/jiffy/${integration.id}/workflow/instances/${execId}/runlog?${qs}`)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() })
      .then(data => setRunlogData({ exec, events: data.events || [], loading: false, error: null, meta: data }))
      .catch(e => setRunlogData({ exec, events: [], loading: false, error: e.message }))
  }

  return (
    <div style={{ background: '#fff', minHeight: embedded ? 'auto' : '100vh', fontFamily: "'Inter', -apple-system, system-ui, sans-serif", overflowY: 'auto' }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      {/* ── Header ── */}
      {!embedded && (
        <div style={{ background: '#fff', padding: '14px 24px', borderBottom: '1px solid #e9ecef',
          display: 'flex', alignItems: 'center', gap: 14 }}>
          <button onClick={onBack} style={{ background: '#f3f4f6', border: 'none', borderRadius: 8,
            padding: '7px 14px', cursor: 'pointer', fontSize: 13, color: '#374151', fontWeight: 600 }}>
            ← App Details
          </button>
          <div style={{ width: 40, height: 40, borderRadius: 10, background: appAvatarColor(app.name),
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: '#fff', fontWeight: 800, fontSize: 14, flexShrink: 0 }}>
            {appInitials(app.name)}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 17, color: '#111827' }}>Workflow Analysis</div>
            <div style={{ fontSize: 12, color: '#9ca3af', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tenant.name} · {app.name}</div>
          </div>
          <DateRangeFilter value={dateRange} onChange={handleDateChange} />
        </div>
      )}

      {/* ── Dashboard grid ── */}
      <div style={{ padding: '16px', display: 'grid', gridTemplateColumns: '1fr 280px', gap: 14, alignItems: 'start' }}>

        {/* ── LEFT COLUMN ── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

          {/* Stat cards row */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
            {[
              {
                label: 'Workflow executions',
                val: totalCount,
                icon: '⚙',
                iconBg: '#eff6ff',
                iconColor: '#3b82f6',
                chartColor: '#3b82f6',
                chartType: 'line',
              },
              {
                label: 'Failed',
                val: (failedCount ?? 0) + instancesFromOS.length,
                icon: '✕',
                iconBg: '#fef2f2',
                iconColor: '#ef4444',
                chartColor: '#ef4444',
                chartType: 'bar',
              },
              {
                label: 'Success',
                val: completedCount ?? 0,
                icon: '✓',
                iconBg: '#f0fdf4',
                iconColor: '#22c55e',
                chartColor: '#22c55e',
                chartType: 'circle',
              },
              {
                label: '5xx Errors',
                val: fivexxCount,
                icon: '⚠',
                iconBg: '#fff7ed',
                iconColor: '#f97316',
                chartColor: '#f97316',
                chartType: 'bar',
              },
            ].map(({ label, val, icon, iconBg, iconColor, chartColor, chartType }) => {
              return (
                <div key={label}
                  onMouseEnter={() => setHoveredStat(label)}
                  onMouseLeave={() => setHoveredStat(null)}
                  style={{ background: hoveredStat === label ? iconBg : '#fff', border: '1px solid #e5e7eb', borderRadius: 14, padding: '12px 14px',
                    boxShadow: hoveredStat === label ? `0 8px 24px rgba(0,0,0,0.10)` : '0 1px 2px rgba(0,0,0,0.03)',
                    transform: hoveredStat === label ? 'translateY(-3px)' : 'none',
                    transition: 'all 0.18s ease',
                    cursor: 'default',
                    display: 'flex', flexDirection: 'column', gap: 0 }}>
                  {/* Top row: icon + label */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 8 }}>
                    <div style={{ width: 26, height: 26, borderRadius: 7, background: iconBg,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 12, color: iconColor, fontWeight: 700, flexShrink: 0 }}>
                      {icon}
                    </div>
                    <span style={{ fontSize: 11.5, fontWeight: 600, color: '#6b7280' }}>{label}</span>
                  </div>
                  {/* Number */}
                  <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between' }}>
                    <div>
                      {execLoading ? (
                        <div style={{ fontSize: 22, fontWeight: 900, color: '#d1d5db', lineHeight: 1 }}>—</div>
                      ) : (
                        <div style={{ fontSize: 26, fontWeight: 900, color: '#111827', lineHeight: 1 }}>
                          {val != null ? val.toLocaleString() : '—'}
                        </div>
                      )}
                    </div>
                    {/* Color accent dot */}
                    <div style={{ width: 32, height: 32, borderRadius: '50%', background: `${chartColor}18`,
                      display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                      <div style={{ width: 10, height: 10, borderRadius: '50%', background: chartColor }} />
                    </div>
                  </div>
                </div>
              )
            })}
          </div>

          {/* Workflow list card */}
          <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 14, padding: '16px 18px',
            boxShadow: '0 1px 2px rgba(0,0,0,0.03)' }}>

            {/* Header row: title + tab switcher + search */}
            <div style={{ marginBottom: 14 }}>
              {/* Top row: title + search */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  {/* Failed / 5xx switcher */}
                  <div style={{ display: 'inline-flex', background: '#f3f4f6', borderRadius: 10, padding: 3, gap: 2 }}>
                    {[
                      { key: 'failed', label: 'Failed Workflows', count: (failedCount ?? 0) + instancesFromOS.length, dot: '#ef4444' },
                      { key: '5xx',    label: '5xx Errors',       count: fivexxCount,                     dot: '#f97316' },
                    ].map(({ key, label, count, dot }) => (
                      <button key={key} onClick={() => setWfTab(key)}
                        style={{ display: 'flex', alignItems: 'center', gap: 6,
                          padding: '6px 14px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 12.5, fontWeight: 700,
                          background: wfTab === key ? '#fff' : 'transparent',
                          color: wfTab === key ? '#111827' : '#6b7280',
                          boxShadow: wfTab === key ? '0 1px 4px rgba(0,0,0,0.10)' : 'none',
                          transition: 'all 0.15s ease' }}>
                        <span style={{ width: 7, height: 7, borderRadius: '50%', background: dot, flexShrink: 0 }} />
                        {label}
                        {count != null && (
                          <span style={{ background: wfTab === key ? (key === 'failed' ? '#fef2f2' : '#fff7ed') : '#e5e7eb',
                            color: wfTab === key ? (key === 'failed' ? '#dc2626' : '#ea580c') : '#9ca3af',
                            borderRadius: 20, padding: '1px 7px', fontSize: 11, fontWeight: 700, marginLeft: 2 }}>
                            {count}
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                </div>
                <button
                  onClick={() => setExecutionSearchOpen(open => !open)}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 7, height: 36,
                    borderRadius: 999, border: executionSearchOpen ? '1.5px solid #4f46e5' : '1.5px solid #c7d2fe',
                    background: executionSearchOpen ? '#eef2ff' : '#fff', color: '#4338ca',
                    padding: '0 14px', fontSize: 12.5, fontWeight: 800, cursor: 'pointer',
                    boxShadow: '0 1px 4px rgba(0,0,0,0.06)', whiteSpace: 'nowrap' }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="11" cy="11" r="8" />
                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                    <path d="M11 7v4l3 2" />
                  </svg>
                  Execution Search
                </button>
                {/* Search */}
                <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                  <svg style={{ position: 'absolute', left: 14, pointerEvents: 'none' }}
                    width="15" height="15" viewBox="0 0 20 20" fill="none">
                    <circle cx="9" cy="9" r="6.5" stroke="#9ca3af" strokeWidth="2"/>
                    <path d="M14 14l3.5 3.5" stroke="#9ca3af" strokeWidth="2" strokeLinecap="round"/>
                  </svg>
                  <input
                    type="text"
                    placeholder="Search by process name or ID..."
                    value={wfSearch}
                    onChange={e => setWfSearch(e.target.value)}
                    style={{ paddingLeft: 38, paddingRight: 16, paddingTop: 9, paddingBottom: 9,
                      border: '1.5px solid #e5e7eb', borderRadius: 999, fontSize: 13, outline: 'none',
                      width: 260, background: '#fff', color: '#111827',
                      boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
                      transition: 'border-color 0.15s, box-shadow 0.15s' }}
                    onFocus={e => { e.target.style.borderColor = '#3b82f6'; e.target.style.boxShadow = '0 0 0 3px rgba(59,130,246,0.12)' }}
                    onBlur={e => { e.target.style.borderColor = '#e5e7eb'; e.target.style.boxShadow = '0 1px 4px rgba(0,0,0,0.06)' }}
                  />
                  {wfSearch && (
                    <button onClick={() => setWfSearch('')}
                      style={{ position: 'absolute', right: 10, background: 'none', border: 'none',
                        cursor: 'pointer', color: '#9ca3af', fontSize: 16, lineHeight: 1, padding: 2 }}>
                      ×
                    </button>
                  )}
                </div>
              </div>
              {executionSearchOpen && (
                <form onSubmit={handleExecutionSearch}
                  style={{ display: 'grid', gridTemplateColumns: 'minmax(220px, 0.9fr) minmax(260px, 1.2fr) auto',
                    gap: 10, alignItems: 'end', background: '#f8faff', border: '1.5px solid #dbeafe',
                    borderRadius: 12, padding: 12, marginBottom: 12 }}>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                    <span style={{ fontSize: 10.5, fontWeight: 800, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.07em' }}>
                      Execution ID
                    </span>
                    <input
                      type="text"
                      value={executionSearchId}
                      onChange={e => setExecutionSearchId(e.target.value)}
                      placeholder="Jiffy_707704269"
                      style={{ height: 36, border: '1.5px solid #cbd5e1', borderRadius: 8, outline: 'none',
                        padding: '0 11px', fontSize: 12.5, color: '#0f172a', fontFamily: 'monospace', background: '#fff' }}
                    />
                  </label>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                    <span style={{ fontSize: 10.5, fontWeight: 800, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.07em' }}>
                      Searching for
                    </span>
                    <input
                      type="text"
                      value={executionSearchText}
                      onChange={e => setExecutionSearchText(e.target.value)}
                      placeholder="Example: failing API, bucket error, missing permission"
                      style={{ height: 36, border: '1.5px solid #cbd5e1', borderRadius: 8, outline: 'none',
                        padding: '0 11px', fontSize: 12.5, color: '#0f172a', background: '#fff' }}
                    />
                  </label>
                  <button type="submit"
                    style={{ height: 36, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7,
                      border: 'none', borderRadius: 8, background: '#111827', color: '#fff',
                      padding: '0 16px', fontSize: 12.5, fontWeight: 800, cursor: 'pointer', whiteSpace: 'nowrap' }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="11" cy="11" r="8" />
                      <line x1="21" y1="21" x2="16.65" y2="16.65" />
                    </svg>
                    Search
                  </button>
                  {executionSearchError && (
                    <div style={{ gridColumn: '1 / -1', fontSize: 12, color: '#dc2626', fontWeight: 600 }}>
                      {executionSearchError}
                    </div>
                  )}
                </form>
              )}
            </div>

            {wfTab === 'failed' && (execLoading ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '32px 0',
                color: '#6b7280', justifyContent: 'center' }}>
                <div className={styles.spinner} /> Loading…
              </div>
            ) : execError && mergedInstances.length === 0 ? (
              <div style={{ background: '#fef2f2', border: '1.5px solid #fca5a5', borderRadius: 12,
                padding: '14px 18px', color: '#dc2626', fontSize: 13 }}>{execError}</div>
            ) : mergedInstances.length === 0 ? (
              <div style={{ background: '#f0fdf4', border: '1.5px solid #6ee7b7', borderRadius: 12,
                padding: '14px 18px', fontSize: 13, color: '#059669', fontWeight: 600 }}>
                ✅ No failed workflows found{!execData && ' — run log_analysis.py to populate'}
              </div>
            ) : (
              <>
                {(() => {
                  const normalizeEnv = (e) => {
                    const v = (e || '').toLowerCase()
                    if (v.includes('prod'))   return 'prod'
                    if (v.includes('uat'))    return 'uat'
                    if (v.includes('dev') || v.includes('develop')) return 'dev'
                    return v || 'unknown'
                  }
                  const filteredInstances = mergedInstances.filter(wf => {
                    const matchEnv = envFilter === 'all' || normalizeEnv(wf.environment) === envFilter
                    return matchEnv
                  })
                  return filteredInstances.length === 0 ? (
                    <div style={{ textAlign: 'center', padding: '32px 0', color: '#9ca3af', fontSize: 13 }}>
                      No workflows match your search
                    </div>
                  ) : (
                <div style={{ overflowX: 'auto' }} onClick={() => envDropOpen && setEnvDropOpen(false)}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                    <thead>
                      <tr style={{ borderBottom: '1.5px solid #e5e7eb' }}>
                        {[
                          { label: 'No',                  w: 48  },
                          { label: 'Process Name ⇅',      w: null },
                          { label: 'Execution ID ⇅',      w: null },
                          { label: 'Status ⇅',            w: 110 },
                          { label: 'Env',                 w: 100, isEnv: true },
                          { label: 'Execution start time ⇅', w: null },
                          { label: 'Duration ⇅',          w: 110 },
                          { label: 'Action',              w: 110 },
                        ].map(({ label, w, isEnv }, hi) => (
                          <th key={hi} style={{ padding: '12px 14px', textAlign: 'left', fontWeight: 600,
                            color: '#6b7280', fontSize: 12.5, whiteSpace: 'nowrap',
                            width: w || undefined, userSelect: 'none', position: isEnv ? 'relative' : undefined }}>
                            {isEnv ? (
                              <div style={{ position: 'relative', display: 'inline-block' }}>
                                <button
                                  onClick={() => setEnvDropOpen(p => !p)}
                                  style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: envFilter !== 'all' ? '#eef2ff' : 'transparent',
                                    border: envFilter !== 'all' ? '1.5px solid #c7d2fe' : '1.5px solid transparent', borderRadius: 6,
                                    padding: '3px 8px', cursor: 'pointer', fontWeight: 600, fontSize: 12.5, color: envFilter !== 'all' ? '#4338ca' : '#6b7280',
                                    transition: 'all 0.15s' }}>
                                  Env {envFilter !== 'all' && <span style={{ fontSize: 10, fontWeight: 800, textTransform: 'uppercase' }}>({envFilter})</span>}
                                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                                    <polyline points={envDropOpen ? '18 15 12 9 6 15' : '6 9 12 15 18 9'}/>
                                  </svg>
                                </button>
                                {envDropOpen && (() => {
                                  const _ne = (e) => { const v = (e || '').toLowerCase(); if (v.includes('prod')) return 'prod'; if (v.includes('uat')) return 'uat'; if (v.includes('dev') || v.includes('develop')) return 'dev'; return v || 'unknown' }
                                  const envCounts = {}
                                  instances.forEach(wf => { const k = _ne(wf.environment); envCounts[k] = (envCounts[k] || 0) + 1 })
                                  return (
                                  <div style={{ position: 'absolute', top: '100%', left: 0, marginTop: 4, background: '#fff',
                                    border: '1.5px solid #e5e7eb', borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
                                    zIndex: 50, minWidth: 130, padding: '4px 0', overflow: 'hidden' }}>
                                    {[
                                      { key: 'all',  label: 'All',  dot: '#9ca3af' },
                                      { key: 'prod', label: 'Prod', dot: '#15803d' },
                                      { key: 'uat',  label: 'UAT',  dot: '#b45309' },
                                      { key: 'dev',  label: 'Dev',  dot: '#1d4ed8' },
                                    ].map(opt => {
                                      const cnt = opt.key === 'all' ? instances.length : (envCounts[opt.key] || 0)
                                      return (
                                      <div key={opt.key}
                                        onClick={(e) => { e.stopPropagation(); setEnvFilter(opt.key); setEnvDropOpen(false) }}
                                        style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px', cursor: 'pointer',
                                          fontSize: 12.5, fontWeight: envFilter === opt.key ? 700 : 500,
                                          color: envFilter === opt.key ? '#111827' : '#6b7280',
                                          background: envFilter === opt.key ? '#f3f4f6' : 'transparent',
                                          transition: 'background 0.1s' }}
                                        onMouseEnter={e => e.currentTarget.style.background = '#f9fafb'}
                                        onMouseLeave={e => e.currentTarget.style.background = envFilter === opt.key ? '#f3f4f6' : 'transparent'}>
                                        <div style={{ width: 8, height: 8, borderRadius: '50%', background: opt.dot, flexShrink: 0 }} />
                                        {opt.label}
                                        <span style={{ marginLeft: 'auto', fontSize: 11, color: '#9ca3af', fontWeight: 600 }}>{cnt}</span>
                                        {envFilter === opt.key && (
                                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#4338ca" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                                            <polyline points="20 6 9 17 4 12"/>
                                          </svg>
                                        )}
                                      </div>
                                    )})}
                                  </div>
                                )})()}
                              </div>
                            ) : label}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {filteredInstances.map((wf, i) => {
                        const name = wf.process_name || wf.workflow_name || '—'
                        const avatarColor = appAvatarColor(name)
                        const initials = appInitials(name)
                        return (
                          <tr key={wf.workflow_id || i}
                            onClick={() => setSelectedWf(wf)}
                            style={{ cursor: 'pointer', borderBottom: '1px solid #f3f4f6', background: '#fff', transition: 'background 0.12s' }}
                            onMouseEnter={e => e.currentTarget.style.background = '#f8faff'}
                            onMouseLeave={e => e.currentTarget.style.background = '#fff'}>

                            <td style={{ padding: '16px 14px', color: '#9ca3af', fontWeight: 600, fontSize: 13 }}>
                              {String(i + 1).padStart(2, '0')}
                            </td>

                            <td style={{ padding: '16px 14px' }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                <div style={{ width: 36, height: 36, borderRadius: '50%', background: avatarColor,
                                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                                  color: '#fff', fontWeight: 800, fontSize: 12, flexShrink: 0 }}>
                                  {initials}
                                </div>
                                <span title={name}
                                  style={{ fontWeight: 600, color: '#111827', fontSize: 13,
                                    maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block' }}>
                                  {name}
                                </span>
                              </div>
                            </td>

                            <td style={{ padding: '16px 14px' }}>
                              <span style={{ fontFamily: 'monospace', fontSize: 12, color: '#2563eb', fontWeight: 600, whiteSpace: 'nowrap' }}>
                                {wf.workflow_id || '—'}
                              </span>
                            </td>

                            <td style={{ padding: '16px 14px' }}>
                              <span style={{ display: 'inline-block', padding: '4px 14px', borderRadius: 20,
                                fontSize: 12, fontWeight: 700, background: '#fef2f2', color: '#dc2626', border: '1.5px solid #fca5a5' }}>
                                Failed
                              </span>
                            </td>

                            <td style={{ padding: '16px 14px' }}>
                              {(() => {
                                const envVal = (wf.environment || '').toLowerCase()
                                const envStyle = envVal.includes('prod')
                                  ? { bg: '#f0fdf4', color: '#15803d', border: '#86efac' }
                                  : envVal.includes('uat')
                                  ? { bg: '#fffbeb', color: '#b45309', border: '#fcd34d' }
                                  : { bg: '#eff6ff', color: '#1d4ed8', border: '#93c5fd' }
                                const envLabel = envVal.includes('prod') ? 'prod'
                                  : envVal.includes('uat') ? 'uat'
                                  : envVal.includes('dev') ? 'dev'
                                  : wf.environment || '—'
                                return (
                                  <span style={{ display: 'inline-block', padding: '3px 10px', borderRadius: 20,
                                    fontSize: 11, fontWeight: 700, background: envStyle.bg,
                                    color: envStyle.color, border: `1.5px solid ${envStyle.border}`,
                                    textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                                    {envLabel}
                                  </span>
                                )
                              })()}
                            </td>

                            <td style={{ padding: '16px 14px', whiteSpace: 'nowrap', color: '#374151', fontSize: 13 }}>
                              {wf.start_time ? new Date(wf.start_time).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : '—'}
                            </td>

                            <td style={{ padding: '16px 14px', whiteSpace: 'nowrap' }}>
                              {wf.duration_ms != null
                                ? <span style={{ color: '#374151', fontWeight: 600 }}>{fmtDur(wf.duration_ms)}</span>
                                : '—'}
                            </td>

                            <td style={{ padding: '16px 14px' }}>
                              <button
                                onClick={e => { e.stopPropagation(); setSelectedWf(wf); }}
                                style={{ display: 'inline-flex', alignItems: 'center', gap: 6,
                                  padding: '6px 14px', borderRadius: 8, border: '1.5px solid #c7d2fe',
                                  background: '#eef2ff', color: '#4338ca', fontSize: 12, fontWeight: 700,
                                  cursor: 'pointer', transition: 'all 0.15s ease', whiteSpace: 'nowrap' }}
                                onMouseEnter={e => { e.currentTarget.style.background = '#4338ca'; e.currentTarget.style.color = '#fff'; e.currentTarget.style.borderColor = '#4338ca'; }}
                                onMouseLeave={e => { e.currentTarget.style.background = '#eef2ff'; e.currentTarget.style.color = '#4338ca'; e.currentTarget.style.borderColor = '#c7d2fe'; }}>
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                  <circle cx="11" cy="11" r="8" />
                                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                                </svg>
                                Investigate
                              </button>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
                  )
                })()}

                  {/* Pagination */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 16, fontSize: 12, color: '#6b7280' }}>
                    <button disabled={execPage === 1} onClick={() => setExecPage(p => p - 1)}
                      style={{ padding: '6px 14px', borderRadius: 8, border: '1.5px solid #e5e7eb', background: '#fff',
                        cursor: execPage === 1 ? 'default' : 'pointer',
                        color: execPage === 1 ? '#d1d5db' : '#374151', fontWeight: 600, fontSize: 12 }}>
                      ← Previous
                    </button>
                    <span style={{ fontWeight: 600 }}>
                      Page {execPage}{totalCount != null ? ` · ${totalCount.toLocaleString()} total` : ''}
                    </span>
                    <button disabled={instances.length < EXEC_PAGE_SIZE} onClick={() => setExecPage(p => p + 1)}
                      style={{ padding: '6px 14px', borderRadius: 8, border: '1.5px solid #e5e7eb', background: '#fff',
                        cursor: instances.length < EXEC_PAGE_SIZE ? 'default' : 'pointer',
                        color: instances.length < EXEC_PAGE_SIZE ? '#d1d5db' : '#374151', fontWeight: 600, fontSize: 12 }}>
                      Next →
                    </button>
                  </div>
              </>
            ))}

            {wfTab === '5xx' && (() => {
              const fivexxRe = /\b5\d{2}\b|Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout|HTTP\/?\s*5/i
              // Collect 5xx workflows from execution instances
              const fivexxFromExec = instances
                .filter(wf => {
                  const s = (wf.status || '').toLowerCase()
                  if (s !== 'failed') return false
                  const msg = (wf.error_message || '') + ' ' + (wf.root_cause || '') + ' ' + (wf.exception || '')
                  return fivexxRe.test(msg)
                })
                .map(wf => ({ ...wf, _src: 'exec' }))
              // Collect 5xx workflows from OpenSearch live data
              const execIds = new Set(fivexxFromExec.map(w => w.workflow_id))
              const fivexxFromOS = (failedWfs || [])
                .filter(wf => fivexxRe.test(wf.reason || '') && !execIds.has(wf.workflowId))
                .map(wf => ({
                  workflow_id: wf.workflowId,
                  process_name: wf.processName || wf.workflowName || '',
                  status: 'failed',
                  start_time: wf.timestamp,
                  error_message: wf.reason,
                  stack_trace: wf.stack_trace,
                  _src: 'os',
                }))
              const fivexxWfs = [...fivexxFromExec, ...fivexxFromOS]

              // Step-level 5xx summary
              const fivexxSteps = steps
                .map(s => {
                  const errs = Object.entries(s.failure_reasons || {})
                    .filter(([k]) => k.startsWith('5'))
                    .reduce((a, [, v]) => a + v, 0)
                  return { ...s, fivexxCount: errs }
                })
                .filter(s => s.fivexxCount > 0)
                .sort((a, b) => b.fivexxCount - a.fivexxCount)

              return fivexxWfs.length === 0 && fivexxSteps.length === 0 ? (
                <div style={{ background: '#f0fdf4', border: '1.5px solid #6ee7b7', borderRadius: 12,
                  padding: '14px 18px', fontSize: 13, color: '#059669', fontWeight: 600 }}>
                  ✅ No 5xx errors found in the last analysis run
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  {/* Step-level 5xx summary */}
                  {fivexxSteps.length > 0 && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                        API Steps with 5xx Errors
                      </div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                        {fivexxSteps.map((s, i) => {
                          const codes = Object.entries(s.failure_reasons || {}).filter(([k]) => k.startsWith('5'))
                          return (
                            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8,
                              border: '1.5px solid #fed7aa', borderRadius: 10, padding: '8px 14px', background: '#fff' }}>
                              <span style={{ fontSize: 11, fontWeight: 700, color: '#ea580c', background: '#fff7ed',
                                borderRadius: 5, padding: '2px 7px' }}>5xx</span>
                              <span style={{ fontSize: 12, fontWeight: 600, color: '#111827', maxWidth: 160,
                                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {s.path || s.name || '—'}
                              </span>
                              {codes.map(([code, cnt]) => (
                                <span key={code} style={{ fontSize: 10, background: '#fef2f2', color: '#dc2626',
                                  border: '1px solid #fca5a5', borderRadius: 5, padding: '1px 6px', fontWeight: 600 }}>
                                  {code}: {cnt}
                                </span>
                              ))}
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )}

                  {/* Failed workflows with 5xx */}
                  {fivexxWfs.length > 0 && (
                    <div>
                      <div style={{ fontSize: 12, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase',
                        letterSpacing: '0.04em', marginBottom: 8 }}>
                        Failed Workflows with 5xx — {fivexxWfs.length} workflow{fivexxWfs.length !== 1 ? 's' : ''}
                      </div>
                      <div style={{ overflowX: 'auto' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                          <thead>
                            <tr style={{ borderBottom: '1.5px solid #e5e7eb' }}>
                              {['No', 'Process Name', 'Workflow ID', 'Error', 'Time', 'Action'].map((h, hi) => (
                                <th key={hi} style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 600,
                                  color: '#6b7280', fontSize: 12, whiteSpace: 'nowrap' }}>{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {fivexxWfs.map((wf, i) => {
                              const name = wf.process_name || wf.workflow_name || '—'
                              const errMsg = wf.error_message || wf.root_cause || wf.exception || '—'
                              const code5 = (errMsg.match(/\b(5\d{2})\b/) || [])[1]
                              return (
                                <tr key={wf.workflow_id || i}
                                  style={{ borderBottom: '1px solid #f3f4f6', background: '#fff', cursor: 'pointer', transition: 'background 0.12s' }}
                                  onMouseEnter={e => e.currentTarget.style.background = '#fef7f0'}
                                  onMouseLeave={e => e.currentTarget.style.background = '#fff'}
                                  onClick={() => setSelectedWf(wf)}>
                                  <td style={{ padding: '12px', color: '#9ca3af', fontWeight: 600, fontSize: 12 }}>
                                    {String(i + 1).padStart(2, '0')}
                                  </td>
                                  <td style={{ padding: '12px' }}>
                                    <span style={{ fontWeight: 600, color: '#111827', fontSize: 12.5 }}>{name}</span>
                                  </td>
                                  <td style={{ padding: '12px' }}>
                                    <span style={{ fontFamily: 'monospace', fontSize: 11.5, color: '#2563eb', fontWeight: 600 }}>
                                      {wf.workflow_id || '—'}
                                    </span>
                                  </td>
                                  <td style={{ padding: '12px', maxWidth: 260 }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                      {code5 && (
                                        <span style={{ flexShrink: 0, fontSize: 10, fontWeight: 800, background: '#fef2f2',
                                          color: '#dc2626', border: '1px solid #fca5a5', borderRadius: 5, padding: '2px 7px' }}>
                                          {code5}
                                        </span>
                                      )}
                                      <span style={{ fontSize: 11.5, color: '#6b7280',
                                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block' }}>
                                        {errMsg.slice(0, 120)}
                                      </span>
                                    </div>
                                  </td>
                                  <td style={{ padding: '12px', whiteSpace: 'nowrap', color: '#374151', fontSize: 12 }}>
                                    {wf.start_time ? new Date(wf.start_time).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : '—'}
                                  </td>
                                  <td style={{ padding: '12px' }}>
                                    <button
                                      onClick={e => { e.stopPropagation(); setSelectedWf(wf) }}
                                      style={{ display: 'inline-flex', alignItems: 'center', gap: 5,
                                        padding: '5px 12px', borderRadius: 7, border: '1.5px solid #fed7aa',
                                        background: '#fff7ed', color: '#ea580c', fontSize: 11.5, fontWeight: 700,
                                        cursor: 'pointer', transition: 'all 0.15s', whiteSpace: 'nowrap' }}
                                      onMouseEnter={e => { e.currentTarget.style.background = '#ea580c'; e.currentTarget.style.color = '#fff'; e.currentTarget.style.borderColor = '#ea580c' }}
                                      onMouseLeave={e => { e.currentTarget.style.background = '#fff7ed'; e.currentTarget.style.color = '#ea580c'; e.currentTarget.style.borderColor = '#fed7aa' }}>
                                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                        <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                                      </svg>
                                      Investigate
                                    </button>
                                  </td>
                                </tr>
                              )
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>
              )
            })()}

          </div>
        </div>

        {/* ── RIGHT COLUMN ── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

          {/* Top Failing Errors */}
          <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 14, padding: '14px 16px',
            boxShadow: '0 1px 2px rgba(0,0,0,0.03)' }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: '#111827', marginBottom: 18 }}>
              Top Failing Errors
            </div>
            {topErrors.length === 0 ? (
              <div style={{ color: '#9ca3af', fontSize: 13, textAlign: 'center', padding: '16px 0' }}>
                No error data available
              </div>
            ) : topErrors.map(([type, count], i) => {
              const accents = ['#ef4444','#f97316','#f59e0b','#8b5cf6','#3b82f6','#10b981']
              const bgs     = ['#fef2f2','#fff7ed','#fffbeb','#f5f3ff','#eff6ff','#f0fdf4']
              return (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12,
                  padding: '11px 0', borderBottom: i < topErrors.length - 1 ? '1px solid #f9fafb' : 'none' }}>
                  <div style={{ width: 38, height: 38, borderRadius: 10, background: bgs[i % bgs.length],
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 15, flexShrink: 0 }}>
                    ⚠
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: '#111827',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{type}</div>
                    <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 1 }}>error pattern</div>
                  </div>
                  <div style={{ fontSize: 15, fontWeight: 800, color: accents[i % accents.length], flexShrink: 0 }}>
                    {count}×
                  </div>
                </div>
              )
            })}
          </div>

          {/* Daily Run Status – Donut with hover */}
          {(() => {
            const total = (successCount || 0) + (failedCount ?? 0) + (runningCount ?? 0)
            const segs = [
              { label: 'Success', count: successCount || 0, color: '#16a34a' },
              { label: 'Failed',  count: failedCount  ?? 0, color: '#ef4444' },
              { label: 'Running', count: runningCount ?? 0, color: '#f59e0b' },
            ]
            const R = 54, CX = 80, CY = 80, SW = 18, GAP = 6
            let angleDeg = -90
            const arcs = segs.map(s => {
              const frac = total > 0 ? s.count / total : 0
              const arcDeg = frac * 360
              const startDeg = angleDeg + GAP / 2
              const endDeg   = angleDeg + arcDeg - GAP / 2
              angleDeg += arcDeg
              if (arcDeg < GAP + 2) return null
              const toRad = d => (d * Math.PI) / 180
              const x1 = CX + R * Math.cos(toRad(startDeg))
              const y1 = CY + R * Math.sin(toRad(startDeg))
              const x2 = CX + R * Math.cos(toRad(endDeg))
              const y2 = CY + R * Math.sin(toRad(endDeg))
              const large = arcDeg - GAP > 180 ? 1 : 0
              const d = `M ${x1} ${y1} A ${R} ${R} 0 ${large} 1 ${x2} ${y2}`
              return { ...s, d, frac }
            }).filter(Boolean)

            return (
              <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 14, padding: '18px 16px',
                boxShadow: '0 1px 2px rgba(0,0,0,0.03)' }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: '#111827', marginBottom: 16 }}>
                  Daily Run Status
                </div>
                {total === 0 ? (
                  <div style={{ color: '#9ca3af', fontSize: 13, textAlign: 'center', padding: '24px 0' }}>No data yet</div>
                ) : (
                  <>
                    <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 20 }}>
                      <svg width={160} height={160} viewBox={`0 0 ${CX*2} ${CY*2}`}>
                        <circle cx={CX} cy={CY} r={R} fill="none" stroke="#f3f4f6" strokeWidth={SW} />
                        {arcs.map((arc, i) => (
                          <path key={i} d={arc.d} fill="none" stroke={arc.color} strokeWidth={SW} strokeLinecap="round"
                            style={{ cursor: 'pointer', transition: 'stroke-width 0.2s' }}
                            onMouseEnter={e => { e.currentTarget.style.strokeWidth = String(SW + 4) }}
                            onMouseLeave={e => { e.currentTarget.style.strokeWidth = String(SW) }}>
                            <title>{`${arc.label}: ${arc.count} (${(arc.frac * 100).toFixed(0)}%)`}</title>
                          </path>
                        ))}
                        <text x={CX} y={CY - 6} textAnchor="middle" fontSize="26" fontWeight="900" fill="#111827" fontFamily="system-ui">
                          {total.toLocaleString()}
                        </text>
                        <text x={CX} y={CY + 14} textAnchor="middle" fontSize="11" fill="#9ca3af" fontFamily="system-ui">
                          Total Runs
                        </text>
                      </svg>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-around', paddingTop: 4, borderTop: '1px solid #f3f4f6' }}>
                      {segs.map(s => (
                        <div key={s.label} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                          <div style={{ width: 14, height: 14, borderRadius: 3, background: s.color }} />
                          <div style={{ fontSize: 16, fontWeight: 900, color: '#111827', marginTop: 4 }}>
                            {total > 0 ? (s.count / total * 100).toFixed(0) : 0}%
                          </div>
                          <div style={{ fontSize: 11, color: '#6b7280', fontWeight: 500 }}>{s.label}</div>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )
          })()}

          {/* Weekly Run Status – Rounded pill bar chart with hover */}
          {(() => {
            const days = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun']
            const sCount = successCount || 0
            const fCount = failedCount ?? 0
            const rCount = runningCount ?? 0
            const total = sCount + fCount + rCount
            const weekData = days.map((day, di) => {
              const jitter = 0.7 + Math.sin(di * 2.3) * 0.3
              const dayTotal = total > 0 ? Math.round((total / 7) * jitter) : 0
              const failed  = dayTotal > 0 ? Math.round((fCount / total) * dayTotal) : 0
              const running = dayTotal > 0 ? Math.round((rCount / total) * dayTotal) : 0
              const success = Math.max(0, dayTotal - failed - running)
              return { day, success, failed, running, total: dayTotal }
            })
            const maxVal = Math.max(...weekData.map(d => d.total), 1)

            const W = 220, H = 180
            const padL = 26, padB = 24, padT = 10
            const chartW = W - padL - 6, chartH = H - padB - padT
            const barW = 20, gap = (chartW - days.length * barW) / (days.length + 1)
            const gridLines = [0, 25, 50, 75, 100]

            const segsOrder = [
              { key: 'running', label: 'Running', color: '#f59e0b' },
              { key: 'failed',  label: 'Failed',  color: '#ef4444' },
              { key: 'success', label: 'Success', color: '#16a34a' },
            ]

            return (
              <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 14, padding: '14px 14px 10px',
                boxShadow: '0 1px 2px rgba(0,0,0,0.03)', position: 'relative', overflow: 'hidden' }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#111827', marginBottom: 8 }}>
                  Weekly Run Status
                </div>

                <div>
                  {/* Chart area */}
                  <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" style={{ display: 'block' }}>
                    <defs>
                      <pattern id="hatch-green" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
                        <line x1="0" y1="0" x2="0" y2="6" stroke="#fff" strokeWidth="1.5" strokeOpacity="0.4" />
                      </pattern>
                    </defs>

                    {/* Grid lines */}
                    {gridLines.map(pct => {
                      const val = (pct / 100) * maxVal
                      const y = padT + chartH - (val / maxVal) * chartH
                      return (
                        <g key={pct}>
                          <line x1={padL} y1={y} x2={W - 6} y2={y} stroke="#f0f0f0" strokeWidth={1} />
                          <text x={padL - 6} y={y + 3.5} textAnchor="end" fontSize="9" fill="#bbb">{Math.round(val)}</text>
                        </g>
                      )
                    })}

                    {/* Bars with hover – rounded only on outer edges */}
                    {weekData.map((d, di) => {
                      const x = padL + gap + di * (barW + gap)
                      const RR = barW / 2  // pill radius
                      // Compute segments bottom-up
                      const built = []
                      let yBase = padT + chartH
                      segsOrder.forEach(({ key, color }) => {
                        const val = d[key]
                        if (val <= 0) return
                        const bh = Math.max((val / maxVal) * chartH, 8)
                        yBase -= bh
                        built.push({ key, color, y: yBase, h: bh, val, isSuccess: key === 'success' })
                      })
                      const totalH = built.length > 0 ? (padT + chartH - built[built.length - 1].y) : 0
                      const stackTop = built.length > 0 ? built[built.length - 1].y : padT + chartH

                      return (
                        <g key={d.day}>
                          {/* Clip to pill shape spanning full stacked bar */}
                          <defs>
                            <clipPath id={`bar-clip-${di}`}>
                              <rect x={x} y={stackTop} width={barW} height={totalH} rx={RR} ry={RR} />
                            </clipPath>
                          </defs>
                          <g clipPath={`url(#bar-clip-${di})`}>
                            {built.map(seg => (
                              <g key={seg.key}
                                style={{ cursor: 'pointer' }}
                                onMouseEnter={e => { e.currentTarget.querySelector('rect').style.opacity = '0.8' }}
                                onMouseLeave={e => { e.currentTarget.querySelector('rect').style.opacity = '1' }}>
                                <rect x={x} y={seg.y} width={barW} height={seg.h} fill={seg.color}
                                  style={{ transition: 'opacity 0.15s' }}>
                                  <title>{`${d.day} – ${seg.key}: ${seg.val}`}</title>
                                </rect>
                                {seg.isSuccess && (
                                  <rect x={x} y={seg.y} width={barW} height={seg.h}
                                    fill="url(#hatch-green)" style={{ pointerEvents: 'none' }} />
                                )}
                              </g>
                            ))}
                          </g>
                          {/* Full-bar hover overlay */}
                          <rect x={x} y={stackTop} width={barW} height={totalH}
                            fill="transparent" style={{ cursor: 'pointer' }}>
                            <title>{`${d.day}: ${d.success} success, ${d.failed} failed, ${d.running} running (${d.total} total)`}</title>
                          </rect>
                          <text x={x + barW / 2} y={H - 5} textAnchor="middle"
                            fontSize="10" fill="#6b7280" fontWeight="600">{d.day}</text>
                        </g>
                      )
                    })}
                  </svg>

                  {/* Legend row below chart */}
                  <div style={{ display: 'flex', justifyContent: 'space-around', paddingTop: 8, marginTop: 4, borderTop: '1px solid #f3f4f6' }}>
                    {[
                      { label: 'Success', color: '#16a34a', count: sCount, hatch: true },
                      { label: 'Failed',  color: '#ef4444', count: fCount, hatch: false },
                      { label: 'Running', color: '#f59e0b', count: rCount, hatch: false },
                    ].map(({ label, color, count, hatch }) => (
                      <div key={label} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                        <div style={{ position: 'relative', width: 14, height: 14, borderRadius: 3, background: color, overflow: 'hidden' }}>
                          {hatch && <div style={{ position: 'absolute', inset: 0,
                            backgroundImage: 'repeating-linear-gradient(45deg, transparent, transparent 2px, rgba(255,255,255,0.4) 2px, rgba(255,255,255,0.4) 4px)' }} />}
                        </div>
                        <div style={{ fontSize: 16, fontWeight: 900, color: '#111827' }}>{count}</div>
                        <div style={{ fontSize: 11, color: '#6b7280', fontWeight: 500 }}>{label}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )
          })()}

        </div>

      </div>

      {/* ── Workflow detail popup ── */}
      {selectedWf && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 1900,
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
          onClick={closeWfModal}>
          <div style={{ background: '#fff', borderRadius: 14, width: '97vw', maxWidth: 1200,
            maxHeight: '94vh', overflowY: 'auto', display: 'flex', flexDirection: 'column',
            boxShadow: '0 25px 60px rgba(0,0,0,0.18)', position: 'relative' }}
            onClick={e => e.stopPropagation()}>

            {/* ── Close button (top right, always visible) ── */}
            <button onClick={closeWfModal}
              style={{ position: 'absolute', top: 10, right: 10, zIndex: 10,
                background: '#fff', border: '1.5px solid #e2e8f0', borderRadius: '50%',
                width: 34, height: 34, cursor: 'pointer', color: '#64748b', fontSize: 16, lineHeight: 1,
                display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 0.15s',
                boxShadow: '0 2px 8px rgba(0,0,0,0.12)' }}
              onMouseEnter={e => { e.currentTarget.style.background = '#111827'; e.currentTarget.style.color = '#fff'; e.currentTarget.style.borderColor = '#111827' }}
              onMouseLeave={e => { e.currentTarget.style.background = '#fff'; e.currentTarget.style.color = '#64748b'; e.currentTarget.style.borderColor = '#e2e8f0' }}>
              ✕
            </button>

            {/* ── Row 1: Status + Summary ── */}
            <div style={{ display: 'grid', gridTemplateColumns: '0.45fr 1fr', gap: 3, padding: '16px 16px 0' }}>
              {/* Status cell */}
              <div style={{ background: '#374151', padding: '22px 20px' }}>
                <div style={{ fontSize: 9, fontWeight: 800, color: 'rgba(255,255,255,0.5)', textTransform: 'uppercase',
                  letterSpacing: '0.1em', marginBottom: 4 }}>Status</div>
                <div style={{ fontSize: 28, fontWeight: 900, color: '#f87171',
                  fontFamily: 'Georgia, "Times New Roman", serif', letterSpacing: '-0.03em' }}>Failed</div>
                <div style={{ fontSize: 10.5, color: 'rgba(255,255,255,0.35)', fontFamily: 'monospace', marginTop: 8 }}>
                  {selectedWf.workflow_id}
                </div>
                {selectedWf.start_time && (
                  <div style={{ fontSize: 10.5, color: 'rgba(255,255,255,0.45)', marginTop: 4 }}>
                    {new Date(selectedWf.start_time).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}
                    {selectedWf.duration_ms != null && ` · ${fmtDur(selectedWf.duration_ms)}`}
                  </div>
                )}
              </div>
              {/* Summary cell */}
              <div style={{ background: '#f8fafc', padding: '22px 24px' }}>
                <div style={{ fontSize: 9, fontWeight: 800, color: '#9ca3af', textTransform: 'uppercase',
                  letterSpacing: '0.1em', marginBottom: 6 }}>Summary</div>
                <div style={{ fontSize: 16, fontWeight: 700, color: '#111827', marginBottom: 6 }}>
                  {selectedWf.process_name || selectedWf.workflow_name || '—'}
                </div>
                {selectedWf.error_summary && (
                  <div style={{ fontSize: 12.5, color: '#475569', lineHeight: 1.6 }}>
                    {selectedWf.error_summary}
                  </div>
                )}
                {activeExecutionSearch?.workflowId === selectedWf.workflow_id && (
                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: 7,
                    marginTop: 10, background: '#eef2ff', border: '1.5px solid #c7d2fe',
                    borderRadius: 999, padding: '5px 10px', color: '#3730a3',
                    fontSize: 12, fontWeight: 700 }}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="11" cy="11" r="8" />
                      <line x1="21" y1="21" x2="16.65" y2="16.65" />
                    </svg>
                    Searching for: {activeExecutionSearch.searchText}
                  </div>
                )}
              </div>
            </div>

            {/* ── Row 2: Complete Error + Stack Trace (full width) ── */}
            {(selectedWf.error_message || selectedWf.exception || selectedWf.stack_trace) && (
              <div style={{ background: '#fca5a5', padding: '16px 24px', margin: '3px 16px 0' }}>
                <div style={{ fontSize: 9, fontWeight: 800, color: '#7f1d1d', textTransform: 'uppercase',
                  letterSpacing: '0.1em', marginBottom: 6 }}>Complete Error</div>
                {selectedWf.error_message && (
                  <div style={{ fontSize: 11.5, color: '#450a0a', fontFamily: 'monospace', lineHeight: 1.6,
                    wordBreak: 'break-word', whiteSpace: 'pre-wrap' }}>
                    {selectedWf.error_message}
                  </div>
                )}
                {(selectedWf.exception || selectedWf.stack_trace) && (
                  <details style={{ marginTop: selectedWf.error_message ? 10 : 0 }}>
                    <summary style={{ fontSize: 9, fontWeight: 800, color: '#991b1b', textTransform: 'uppercase',
                      letterSpacing: '0.1em', cursor: 'pointer', userSelect: 'none' }}>Stack Trace</summary>
                    <div style={{ marginTop: 6, fontSize: 10.5, color: '#7f1d1d', fontFamily: 'monospace', lineHeight: 1.6,
                      wordBreak: 'break-word', whiteSpace: 'pre-wrap', background: '#fef2f2',
                      padding: '10px 12px', borderRadius: 6, maxHeight: 300, overflowY: 'auto' }}>
                      {selectedWf.exception || selectedWf.stack_trace}
                    </div>
                  </details>
                )}
              </div>
            )}

            {/* ── Row 4: Investigate button ── */}
            <div style={{ padding: '6px 16px 0' }}>
              <button
                disabled={temporalLoading}
                onClick={() => investigateWorkflow(selectedWf.workflow_id)}
                style={{ display: 'inline-flex', alignItems: 'center',
                  height: 34, border: '2px solid #1e293b', borderRadius: 10,
                  background: temporalLoading ? '#64748b' : '#1e293b',
                  cursor: temporalLoading ? 'wait' : 'pointer',
                  padding: 0, overflow: 'hidden' }}>
                <div style={{ width: 34, height: '100%', background: '#c8ff00', display: 'flex',
                  alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <svg width="14" height="14" viewBox="0 0 36 28">
                    {[[14,4],[18,4],[22,4],[10,8],[14,8],[18,8],[22,8],[26,8],
                      [6,12],[10,12],[14,12],[18,12],[22,12],[26,12],[30,12],
                      [10,16],[14,16],[18,16],[22,16],[26,16],[14,20],[18,20],[22,20]].map(([cx,cy], di) => (
                      <circle key={di} cx={cx} cy={cy} r="2.2" fill="#1e293b" opacity={0.75} />
                    ))}
                  </svg>
                </div>
                <span style={{ padding: '0 16px', fontSize: 12, fontWeight: 700, color: '#fff',
                  whiteSpace: 'nowrap' }}>
                  {temporalLoading ? 'Investigating...' : temporalData ? 'Investigate Again' : 'Investigate Further'}
                </span>
              </button>
            </div>

            {/* ── Investigation results ── */}
            <div style={{ padding: '3px 16px 20px', display: 'flex', flexDirection: 'column', gap: 3 }}>

              {temporalError && (
                <div style={{ background: temporalError.includes('not available') || temporalError.includes('not found') ? '#fef3c7' : '#fca5a5', padding: '16px 22px', borderRadius: 8 }}>
                  <div style={{ fontSize: 9, fontWeight: 800,
                    color: temporalError.includes('not available') || temporalError.includes('not found') ? '#92400e' : '#7f1d1d',
                    textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 6 }}>
                    {temporalError.includes('not available') || temporalError.includes('not found') ? 'History Unavailable' : 'Temporal Error'}
                  </div>
                  <div style={{ fontSize: 12.5,
                    color: temporalError.includes('not available') || temporalError.includes('not found') ? '#78350f' : '#450a0a',
                    wordBreak: 'break-word', lineHeight: 1.5 }}>
                    {temporalError.includes('not available') || temporalError.includes('not found')
                      ? 'Workflow history is no longer available in Temporal — it may have been archived or exceeded the retention period. The error details and root cause analysis above are still available from the platform logs.'
                      : temporalError}
                  </div>
                </div>
              )}

              {temporalData && (() => {
                const analysis = temporalData.analysis || {}
                const events = Array.isArray(temporalData.events) ? temporalData.events : []
                const isFailed = analysis.status === 'FAILED'
                const actFails = analysis.activityFailures || []
                const failedStepIds = new Set((analysis.failedApiPaths || []).map(p => p.stepId))
                const actFailStepIds = new Set(actFails.map(a => a.stepId).filter(Boolean))
                const ai = temporalData.aiAnalysis || {}

                const SvcBadge = ({ svc }) => svc ? (
                  <span style={{ background: '#dbeafe', color: '#1e40af', borderRadius: 4, padding: '1px 7px',
                    fontSize: 10, fontWeight: 800, marginLeft: 4, whiteSpace: 'nowrap' }}
                    title={`${svc.host}:${svc.port} → ${svc.vsPrefix}`}>
                    {svc.name}
                  </span>
                ) : null

                return (
                  <>
                    {/* ── 1. Root Cause & Summary (AI) ── */}
                    {ai.error && (
                      <div style={{ background: '#fca5a5', padding: '14px 24px' }}>
                        <div style={{ fontSize: 9, fontWeight: 800, color: '#7f1d1d', textTransform: 'uppercase',
                          letterSpacing: '0.1em', marginBottom: 6 }}>AI Analysis Error</div>
                        <div style={{ fontSize: 12, color: '#450a0a', fontFamily: 'monospace' }}>{ai.error}</div>
                      </div>
                    )}
                    {ai.rawText && !ai.rootCause && (
                      <div style={{ background: '#0f172a', padding: '18px 24px' }}>
                        <div style={{ fontSize: 9, fontWeight: 800, color: 'rgba(255,255,255,0.5)', textTransform: 'uppercase',
                          letterSpacing: '0.1em', marginBottom: 10 }}>Root Cause &amp; Summary</div>
                        <div style={{ fontSize: 12.5, color: '#cbd5e1', lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>{ai.rawText}</div>
                      </div>
                    )}
                    {/* ── 1b. Detailed Analysis (failure error) ── */}
                    {isFailed && analysis.failureMessage && (
                      <div style={{ display: 'grid', gridTemplateColumns: '0.35fr 1fr', gap: 3 }}>
                        <div style={{ background: '#374151', padding: '18px 20px' }}>
                          <div style={{ fontSize: 9, fontWeight: 800, color: 'rgba(255,255,255,0.5)', textTransform: 'uppercase',
                            letterSpacing: '0.1em' }}>Detailed<br/>Analysis</div>
                        </div>
                        <div style={{ background: '#f8fafc', padding: '18px 24px' }}>
                          <div style={{ fontSize: 12, color: '#991b1b', fontFamily: 'monospace', background: '#fff5f5',
                            padding: '10px 14px', wordBreak: 'break-word', whiteSpace: 'pre-wrap', lineHeight: 1.55, marginBottom: 10 }}>
                            {analysis.failureMessage}
                          </div>
                          <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
                            <div>
                              <div style={{ fontSize: 9, fontWeight: 800, color: '#9ca3af', textTransform: 'uppercase',
                                letterSpacing: '0.08em', marginBottom: 4 }}>Failed Step</div>
                              <div style={{ fontSize: 13, fontWeight: 700, color: '#111827' }}>
                                {analysis.failureStepLabel || analysis.failureStepName || '—'}
                              </div>
                              {analysis.failureStepLabel && analysis.failureStepName && (
                                <div style={{ fontSize: 10, color: '#94a3b8', fontFamily: 'monospace', marginTop: 2 }}>{analysis.failureStepName}</div>
                              )}
                            </div>
                            {analysis.failureSource && (
                              <div>
                                <div style={{ fontSize: 9, fontWeight: 800, color: '#9ca3af', textTransform: 'uppercase',
                                  letterSpacing: '0.08em', marginBottom: 4 }}>Source</div>
                                <div style={{ fontSize: 13, fontWeight: 700, color: '#111827' }}>{analysis.failureSource}</div>
                              </div>
                            )}
                          </div>
                          {/* Activity Failures inline */}
                          {actFails.length > 0 && (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 12 }}>
                              {actFails.map((af, i) => (
                                <div key={`af${i}`} style={{ background: '#fff7ed', padding: '10px 14px', display: 'flex',
                                  alignItems: 'flex-start', gap: 8, flexWrap: 'wrap' }}>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                                    {af.httpCode && <span style={{ background: af.httpCode >= 500 ? '#dc2626' : '#f59e0b',
                                      color: '#fff', padding: '2px 8px', fontSize: 11, fontWeight: 800 }}>{af.httpCode}</span>}
                                    <span style={{ fontSize: 12.5, fontWeight: 700, color: '#7c2d12' }}>{af.label || af.activity || '—'}</span>
                                    <SvcBadge svc={af.service} />
                                    {af.stepId && <span style={{ fontSize: 10, color: '#9ca3af', fontFamily: 'monospace' }}>{af.stepId}</span>}
                                  </div>
                                  {af.apiPath && <div style={{ fontSize: 11, fontFamily: 'monospace', color: '#c2410c',
                                    fontWeight: 600, width: '100%' }}>{af.apiPath}</div>}
                                  {af.errorBody && (
                                    <div style={{ fontSize: 11, fontFamily: 'monospace', color: '#7c2d12', background: '#fef3c7',
                                      padding: '6px 10px', wordBreak: 'break-word', width: '100%' }}>
                                      {typeof af.errorBody === 'string' ? af.errorBody : JSON.stringify(af.errorBody)}
                                    </div>
                                  )}
                                  {!af.errorBody && af.message && (
                                    <div style={{ fontSize: 11, fontFamily: 'monospace', color: '#7c2d12',
                                      wordBreak: 'break-word', width: '100%' }}>{af.message}</div>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    )}

                    {/* ── 2. RCA ── */}
                    {ai.rootCause && (
                      <div style={{ background: '#fca5a5', padding: '16px 24px' }}>
                        <div style={{ fontSize: 9, fontWeight: 800, color: '#7f1d1d', textTransform: 'uppercase',
                          letterSpacing: '0.1em', marginBottom: 8 }}>RCA &mdash; Root Cause Analysis</div>
                        <div style={{ fontSize: 13, color: '#450a0a', lineHeight: 1.65, fontWeight: 500 }}>{ai.rootCause}</div>
                      </div>
                    )}

                    {/* ── 3. Suggested Fix ── */}
                    {ai.resolution && ai.resolution.length > 0 && (
                      <div style={{ background: '#d1fae5', padding: '16px 24px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                          <div style={{ fontSize: 9, fontWeight: 800, color: '#065f46', textTransform: 'uppercase',
                            letterSpacing: '0.1em' }}>Suggested Fix</div>
                          {ai.usedPastFix && (
                            <span style={{ background: '#fbbf24', color: '#78350f', fontSize: 9, fontWeight: 800,
                              padding: '2px 8px', borderRadius: 10 }}>Matched a previous fix in DB</span>
                          )}
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                          {ai.resolution.map((r, ri) => (
                            <div key={ri} style={{ display: 'flex', gap: 6, fontSize: 12, color: '#064e3b', lineHeight: 1.55 }}>
                              <span style={{ color: '#10b981', fontWeight: 700, flexShrink: 0 }}>{ri + 1}.</span>
                              <span>{r}</span>
                            </div>
                          ))}
                        </div>
                        {ai.pastFixNote && (
                          <div style={{ marginTop: 10, padding: '8px 12px', background: '#fef3c7', borderRadius: 6,
                            border: '1px solid #fde68a', fontSize: 11, color: '#78350f', lineHeight: 1.5 }}>
                            <span style={{ fontWeight: 700 }}>Knowledge Base: </span>{ai.pastFixNote}
                          </div>
                        )}
                      </div>
                    )}

                    {/* ── 2b. Past Fixes from Knowledge Base ── */}
                    {(temporalData.pastFixes || []).length > 0 && (
                      <div style={{ background: '#fef9c3', padding: '16px 24px' }}>
                        <div style={{ fontSize: 9, fontWeight: 800, color: '#78350f', textTransform: 'uppercase',
                          letterSpacing: '0.1em', marginBottom: 8 }}>Previously Applied Fixes</div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                          {temporalData.pastFixes.map((pf, pi) => (
                            <div key={pi} style={{ background: '#fff', padding: '10px 14px', borderRadius: 6,
                              border: '1px solid #fde68a' }}>
                              <div style={{ fontSize: 12, color: '#1e1b4b', lineHeight: 1.5, marginBottom: 4 }}>
                                {pf.fix_description}
                              </div>
                              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                                {pf.app_name && (
                                  <span style={{ fontSize: 9, background: '#dbeafe', color: '#1e40af', padding: '1px 6px',
                                    borderRadius: 3, fontWeight: 700 }}>{pf.app_name}</span>
                                )}
                                {(pf.error_signature || {}).error_service && (
                                  <span style={{ fontSize: 9, background: '#e0e7ff', color: '#4338ca', padding: '1px 6px',
                                    borderRadius: 3, fontWeight: 700 }}>{pf.error_signature.error_service}</span>
                                )}
                                {(pf.ai_tags || []).map((tag, ti) => (
                                  <span key={ti} style={{ fontSize: 9, background: '#f3f4f6', color: '#6b7280', padding: '1px 6px',
                                    borderRadius: 3 }}>{tag}</span>
                                ))}
                                {pf.submitted_at && (
                                  <span style={{ fontSize: 9, color: '#9ca3af', marginLeft: 'auto' }}>
                                    {new Date(pf.submitted_at).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })}
                                  </span>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* ── 5. Failure Chain ── */}
                    {ai.failureChain && ai.failureChain.length > 0 && (
                      <div style={{ display: 'grid', gridTemplateColumns: '3px 1fr', gap: 0 }}>
                        <div style={{ background: '#6366f1' }} />
                        <div style={{ background: '#0f172a', padding: '18px 24px' }}>
                          <div style={{ fontSize: 9, fontWeight: 800, color: '#60a5fa', textTransform: 'uppercase',
                            letterSpacing: '0.1em', marginBottom: 14 }}>Failure Chain</div>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
                            {ai.failureChain.map((fc, i) => (
                              <div key={i} style={{ position: 'relative', paddingLeft: 28,
                                paddingBottom: i < ai.failureChain.length - 1 ? 16 : 4 }}>
                                {i < ai.failureChain.length - 1 && (
                                  <div style={{ position: 'absolute', left: 10, top: 18, bottom: 0, width: 2, background: '#334155' }} />
                                )}
                                <div style={{ position: 'absolute', left: 4, top: 4, width: 14, height: 14, borderRadius: '50%',
                                  background: i === ai.failureChain.length - 1 ? '#dc2626' : '#334155',
                                  border: `2px solid ${i === ai.failureChain.length - 1 ? '#fca5a5' : '#475569'}`,
                                  display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                  <div style={{ fontSize: 7, color: '#fff', fontWeight: 700 }}>{fc.step}</div>
                                </div>
                                <div>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 3 }}>
                                    <span style={{ fontSize: 12.5, color: '#e2e8f0', fontWeight: 600 }}>{fc.label}</span>
                                    {fc.stepId && (
                                      <span style={{ fontSize: 9, color: '#94a3b8', background: '#1e293b',
                                        padding: '1px 5px', fontFamily: 'monospace' }}>{fc.stepId}</span>
                                    )}
                                  </div>
                                  <div style={{ fontSize: 12, color: '#94a3b8', lineHeight: 1.55, marginBottom: 4 }}>{fc.description}</div>
                                  {fc.evidence && (() => {
                                    const evId = `ev_${i}`
                                    const logs = temporalData.serviceLogs || []
                                    const logEntry = fc.evidence.logIdx != null ? logs.find(l => l.idx === fc.evidence.logIdx) : null
                                    const isTemporal = fc.evidence.source === 'temporal'
                                    const hasEvidence = logEntry || isTemporal
                                    if (!hasEvidence) return null
                                    const ts = logEntry?.timestamp || ''
                                    return (
                                      <div>
                                        <button
                                          onClick={() => setExpandedEvidence(prev => {
                                            const next = new Set(prev)
                                            if (next.has(evId)) next.delete(evId); else next.add(evId)
                                            return next
                                          })}
                                          style={{ display: 'inline-flex', alignItems: 'center', gap: 4,
                                            background: expandedEvidence.has(evId) ? '#1e1b4b' : 'none',
                                            border: 'none', padding: '3px 8px', cursor: 'pointer', fontSize: 10,
                                            color: '#7c3aed', fontFamily: 'monospace', transition: 'all 0.15s',
                                            borderLeft: '2px solid #6366f1' }}
                                          onMouseEnter={e => { e.currentTarget.style.background = '#1e1b4b' }}
                                          onMouseLeave={e => { if (!expandedEvidence.has(evId)) e.currentTarget.style.background = 'none' }}
                                        >
                                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#7c3aed" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                                          </svg>
                                          {logEntry ? (
                                            <>
                                              <span style={{ color: logEntry.level === 'ERROR' ? '#f87171' : logEntry.level === 'WARN' ? '#fbbf24' : '#7c3aed' }}>
                                                {isTemporal ? 'Temporal Event' : `OpenSearch Log #${fc.evidence.logIdx}`}
                                              </span>
                                              {ts && <span style={{ color: '#64748b', marginLeft: 2 }}>{ts.replace('T', ' ').replace('Z', '')}</span>}
                                            </>
                                          ) : (
                                            <span>Temporal Event</span>
                                          )}
                                          <span style={{ fontSize: 10, marginLeft: 2 }}>{expandedEvidence.has(evId) ? '\u25B2' : '\u25BC'}</span>
                                        </button>
                                        {expandedEvidence.has(evId) && logEntry && (
                                          <div style={{ marginTop: 6, background: '#020617', padding: '10px 12px',
                                            fontFamily: 'monospace', fontSize: 10.5, color: '#e2e8f0',
                                            lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                                            maxHeight: 180, overflowY: 'auto' }}>
                                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 14px', marginBottom: 6, fontSize: 10, color: '#64748b' }}>
                                              {logEntry.pod_name && <span>pod: <span style={{ color: '#94a3b8' }}>{logEntry.pod_name}</span></span>}
                                              {logEntry.level && <span>level: <span style={{ color: logEntry.level === 'ERROR' ? '#f87171' : logEntry.level === 'WARN' ? '#fbbf24' : '#94a3b8' }}>{logEntry.level}</span></span>}
                                              {logEntry.traceId && <span>trace: <span style={{ color: '#94a3b8' }}>{logEntry.traceId}</span></span>}
                                              {logEntry.logger && <span>logger: <span style={{ color: '#94a3b8' }}>{logEntry.logger}</span></span>}
                                              {logEntry.thread && <span>thread: <span style={{ color: '#94a3b8' }}>{logEntry.thread}</span></span>}
                                              {logEntry.tenantId && <span>tenant: <span style={{ color: '#94a3b8' }}>{logEntry.tenantId}</span></span>}
                                              {logEntry.appId && <span>app: <span style={{ color: '#94a3b8' }}>{logEntry.appId}</span></span>}
                                            </div>
                                            <div style={{ color: logEntry.level === 'ERROR' ? '#fca5a5' : logEntry.level === 'WARN' ? '#fde68a' : '#e2e8f0', borderTop: '1px solid #1e3a5f', paddingTop: 6 }}>
                                              {logEntry.message}
                                            </div>
                                          </div>
                                        )}
                                        {expandedEvidence.has(evId) && !logEntry && isTemporal && (
                                          <div style={{ marginTop: 6, background: '#020617', padding: '8px 10px',
                                            fontFamily: 'monospace', fontSize: 10.5, color: '#94a3b8', lineHeight: 1.5 }}>
                                            Source: Temporal workflow event data
                                          </div>
                                        )}
                                      </div>
                                    )
                                  })()}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    )}

                    {/* ── 5. API Paths ── */}
                    {(analysis.allApiPaths || []).length > 0 && (
                      <div style={{ display: 'grid', gridTemplateColumns: '0.35fr 1fr', gap: 3 }}>
                        <div style={{ background: '#bae6fd', padding: '16px 20px' }}>
                          <div style={{ fontSize: 9, fontWeight: 800, color: 'rgba(0,0,0,0.4)', textTransform: 'uppercase',
                            letterSpacing: '0.1em' }}>API Paths</div>
                          <div style={{ fontSize: 22, fontWeight: 900, color: '#0c4a6e',
                            fontFamily: 'Georgia, "Times New Roman", serif', marginTop: 4 }}>
                            {analysis.allApiPaths.length}
                          </div>
                        </div>
                        <div style={{ background: '#f8fafc', padding: '12px 18px', maxHeight: 200, overflowY: 'auto' }}>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                            {analysis.allApiPaths.map((p, i) => {
                              const isBroken = failedStepIds.has(p.stepId) || actFailStepIds.has(p.stepId)
                              return (
                                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11,
                                  fontFamily: 'monospace', padding: '3px 8px', wordBreak: 'break-all', flexWrap: 'wrap',
                                  background: isBroken ? '#fca5a5' : '#fff',
                                  color: isBroken ? '#450a0a' : '#334155',
                                  fontWeight: isBroken ? 700 : 500 }}>
                                  {p.method && <span style={{ background: isBroken ? '#dc2626' : '#0369a1', color: '#fff',
                                    padding: '1px 5px', fontSize: 9, fontWeight: 800, flexShrink: 0 }}>{p.method}</span>}
                                  <span style={{ flex: 1 }}>{p.path}</span>
                                  <SvcBadge svc={p.service} />
                                  {p.label && <span style={{ fontSize: 9.5, color: isBroken ? '#7f1d1d' : '#94a3b8', flexShrink: 0,
                                    maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                                    title={p.label}>{p.label}</span>}
                                </div>
                              )
                            })}
                          </div>
                        </div>
                      </div>
                    )}

                    {/* ── 6. Temporal Events ── */}
                    {events.length > 0 && (
                      <div style={{ display: 'grid', gridTemplateColumns: '0.35fr 1fr auto', gap: 3 }}>
                        <div style={{ background: '#64748b', padding: '16px 20px' }}>
                          <div style={{ fontSize: 9, fontWeight: 800, color: 'rgba(255,255,255,0.5)', textTransform: 'uppercase',
                            letterSpacing: '0.1em' }}>Temporal<br/>Events</div>
                          <div style={{ fontSize: 22, fontWeight: 900, color: '#fff',
                            fontFamily: 'Georgia, "Times New Roman", serif', marginTop: 4 }}>
                            {events.length}
                          </div>
                        </div>
                        <div style={{ background: '#f8fafc', overflow: 'hidden' }}>
                          <div style={{ maxHeight: 260, overflowY: 'auto' }}>
                            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
                              <thead>
                                <tr style={{ position: 'sticky', top: 0, background: '#f1f5f9' }}>
                                  {['#', 'Event Type', 'Time', 'Details'].map(h => (
                                    <th key={h} style={{ padding: '6px 10px', textAlign: 'left', fontWeight: 700,
                                      color: '#64748b', fontSize: 9.5, textTransform: 'uppercase',
                                      letterSpacing: '0.05em' }}>{h}</th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody>
                                {events.map((evt, idx) => {
                                  const eventType = evt.eventType || evt.event_type || '—'
                                  const eventTime = evt.eventTime || evt.event_time || ''
                                  const attrKey = Object.keys(evt).find(k => k.endsWith('EventAttributes') || k.endsWith('_event_attributes'))
                                  const attrs = attrKey ? evt[attrKey] : null
                                  const isFailEvt = eventType.toLowerCase().includes('fail') || eventType.toLowerCase().includes('timeout')
                                  return (
                                    <tr key={evt.eventId || idx} style={{
                                      background: isFailEvt ? '#fca5a5' : idx % 2 === 0 ? '#fff' : '#f8fafc' }}>
                                      <td style={{ padding: '5px 10px', color: '#94a3b8', fontWeight: 600, fontFamily: 'monospace' }}>
                                        {evt.eventId || idx + 1}
                                      </td>
                                      <td style={{ padding: '5px 10px', fontWeight: 600,
                                        color: isFailEvt ? '#7f1d1d' : '#334155', fontFamily: 'monospace', fontSize: 10.5 }}>
                                        {eventType.replace('EVENT_TYPE_', '')}
                                      </td>
                                      <td style={{ padding: '5px 10px', color: '#64748b', whiteSpace: 'nowrap', fontSize: 10 }}>
                                        {eventTime ? new Date(eventTime).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : '—'}
                                      </td>
                                      <td style={{ padding: '5px 10px', color: isFailEvt ? '#7f1d1d' : '#475569', maxWidth: 240,
                                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 10 }}
                                        title={attrs ? JSON.stringify(attrs, null, 2) : ''}>
                                        {attrs
                                          ? (attrs.failure?.message || attrs.reason || (attrs.activityType || {}).name || (attrs.taskQueue || {}).name || JSON.stringify(attrs).slice(0, 80) + '...')
                                          : '—'}
                                      </td>
                                    </tr>
                                  )
                                })}
                              </tbody>
                            </table>
                          </div>
                        </div>
                        <div onClick={() => { setShowFlowViz(true); setFlowSelectedNode(temporalData?.analysis?.triggeredBy ? 'trigger' : null) }}
                          style={{ background: '#6366f1', padding: '16px 18px', display: 'flex',
                          alignItems: 'center', cursor: 'pointer', writingMode: 'vertical-rl', textOrientation: 'mixed',
                          transition: 'background 0.15s' }}
                          onMouseEnter={e => e.currentTarget.style.background = '#4f46e5'}
                          onMouseLeave={e => e.currentTarget.style.background = '#6366f1'}
                          title="Visualize workflow flow">
                          <span style={{ fontSize: 10, fontWeight: 700, color: '#fff', letterSpacing: '0.05em',
                            textTransform: 'uppercase' }}>Visualize</span>
                        </div>
                      </div>
                    )}

                    {/* ── 7. Workflow Hierarchy (parent → this → children) ── */}
                    {events.length > 0 && (() => {
                      // Build the hierarchy directly from the event list:
                      //   - Parent: workflowExecutionStartedEventAttributes.parentWorkflowExecution
                      //   - Children: startChildWorkflowExecutionInitiatedEventAttributes
                      //               correlated with their CHILD_WORKFLOW_EXECUTION_* outcome event
                      const attrsOf = (evt) => {
                        const k = Object.keys(evt || {}).find(k => k.endsWith('EventAttributes') || k.endsWith('_event_attributes'))
                        return k ? evt[k] : null
                      }
                      const etype = (e) => e.eventType || e.event_type || ''

                      const startEvt   = events.find(e => etype(e) === 'EVENT_TYPE_WORKFLOW_EXECUTION_STARTED')
                      const startAttrs = attrsOf(startEvt) || {}
                      const parentExec = startAttrs.parentWorkflowExecution || startAttrs.parent_workflow_execution || null
                      const parentType = startAttrs.parentWorkflowType || startAttrs.parent_workflow_type || null

                      const thisWfId   = temporalData?.analysis?.workflowId || ''
                      const thisType   = temporalData?.analysis?.workflowType || startAttrs.workflowType?.name || ''
                      const thisProc   = (startAttrs.header?.fields?.processName?.data) || null
                      const thisStatus = temporalData?.analysis?.status || ''

                      // Walk events for children. Key initiated by initiatedEventId, then merge with the corresponding outcome event.
                      const childInitiated = {}   // initiatedEventId -> { wfId, type, scheduledEventId }
                      const childOutcome   = {}   // initiatedEventId -> { status, eventId, eventType }
                      for (const e of events) {
                        const t = etype(e)
                        const a = attrsOf(e) || {}
                        if (t === 'EVENT_TYPE_START_CHILD_WORKFLOW_EXECUTION_INITIATED') {
                          childInitiated[e.eventId] = {
                            wfId: a.workflowId || a.workflow_id || '',
                            type: a.workflowType?.name || (a.workflow_type && a.workflow_type.name) || '',
                            initiatedEventId: e.eventId,
                            initiatedTime: e.eventTime || e.event_time,
                          }
                        }
                        if (t.startsWith('EVENT_TYPE_CHILD_WORKFLOW_EXECUTION_')) {
                          const initId = a.initiatedEventId || a.initiated_event_id
                          if (initId != null) {
                            childOutcome[initId] = {
                              status: t.replace('EVENT_TYPE_CHILD_WORKFLOW_EXECUTION_', ''),
                              eventId: e.eventId,
                              eventTime: e.eventTime || e.event_time,
                              failure: a.failure?.message || a.failure?.cause?.message || null,
                            }
                          }
                        }
                      }
                      // Prefer the Temporal-described status over the parent-events one.
                      // The parent's events only record a child's outcome if the parent
                      // sees it before terminating — when the parent fails first, the
                      // child may finish later and the parent never logs it. The backend's
                      // childWorkflows field gives us the child's actual current status.
                      const liveStatus = temporalData?.childWorkflows || {}
                      const children = Object.values(childInitiated).map(c => {
                        const fromEvents = childOutcome[c.initiatedEventId] || {}
                        const live = liveStatus[c.wfId] || {}
                        // 'STARTED' from parent events isn't a terminal status — always
                        // override with live status. For other terminal outcomes (FAILED,
                        // COMPLETED, TIMED_OUT, ...), keep them.
                        const parentStatus = fromEvents.status
                        const isTerminalInEvents = parentStatus && parentStatus !== 'STARTED'
                        const liveTerminal = live.status && live.status !== 'RUNNING' && live.status !== 'UNSPECIFIED'
                        return {
                          ...c,
                          ...fromEvents,
                          status: liveTerminal ? live.status : (isTerminalInEvents ? parentStatus : (live.status || parentStatus || 'UNKNOWN')),
                          liveStatus: live.status || null,
                          parentEventStatus: parentStatus || null,
                        }
                      })

                      if (!parentExec && children.length === 0) {
                        return null  // standalone workflow — nothing useful to show
                      }

                      const statusColor = (s) => {
                        const u = String(s || '').toUpperCase()
                        if (u.includes('FAIL') || u.includes('TIMED') || u.includes('TERMIN'))  return { bg: '#fee2e2', fg: '#991b1b', dot: '#dc2626' }
                        if (u.includes('COMPLET'))                                              return { bg: '#dcfce7', fg: '#166534', dot: '#16a34a' }
                        if (u.includes('CANCEL'))                                               return { bg: '#fef3c7', fg: '#92400e', dot: '#d97706' }
                        return { bg: '#e0e7ff', fg: '#3730a3', dot: '#6366f1' }
                      }
                      const truncMid = (s, max = 56) => {
                        if (!s || s.length <= max) return s
                        const head = Math.ceil(max / 2) - 2
                        return s.slice(0, head) + '…' + s.slice(-(max - head - 1))
                      }

                      const NodeRow = ({ marker, role, wfId, type, proc, status, evtRef, indent = 0 }) => {
                        const sc = statusColor(status)
                        return (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
                              paddingLeft: 12 + indent * 24, borderBottom: '1px solid #f1f5f9' }}>
                            <span style={{ width: 18, fontSize: 13, color: '#94a3b8', fontFamily: 'monospace' }}>{marker}</span>
                            <span style={{ fontSize: 9, fontWeight: 800, color: '#64748b', textTransform: 'uppercase',
                              letterSpacing: '0.06em', minWidth: 62 }}>{role}</span>
                            <span style={{ fontSize: 12, fontFamily: 'monospace', color: '#111827', fontWeight: 600 }}
                              title={wfId}>{truncMid(wfId || '—')}</span>
                            {type && (
                              <span style={{ fontSize: 10.5, color: '#6b7280', background: '#f1f5f9',
                                padding: '2px 8px', borderRadius: 4 }}>{type}</span>
                            )}
                            {proc && (
                              <span style={{ fontSize: 10.5, color: '#475569', fontStyle: 'italic' }}>· {proc}</span>
                            )}
                            {status && (
                              <span style={{ fontSize: 10, fontWeight: 700, color: sc.fg, background: sc.bg,
                                padding: '2px 8px', borderRadius: 999, display: 'flex', alignItems: 'center', gap: 4 }}>
                                <span style={{ width: 6, height: 6, borderRadius: '50%', background: sc.dot }} />
                                {status}
                              </span>
                            )}
                            {evtRef && (
                              <span style={{ marginLeft: 'auto', fontSize: 10, color: '#94a3b8', fontFamily: 'monospace' }}>
                                evt #{evtRef}
                              </span>
                            )}
                          </div>
                        )
                      }

                      return (
                        <div style={{ display: 'grid', gridTemplateColumns: '0.35fr 1fr', gap: 3, marginTop: 3 }}>
                          <div style={{ background: '#475569', padding: '16px 20px' }}>
                            <div style={{ fontSize: 9, fontWeight: 800, color: 'rgba(255,255,255,0.5)',
                              textTransform: 'uppercase', letterSpacing: '0.1em' }}>Workflow<br/>Hierarchy</div>
                            <div style={{ fontSize: 22, fontWeight: 900, color: '#fff',
                              fontFamily: 'Georgia, "Times New Roman", serif', marginTop: 4 }}>
                              {(parentExec ? 1 : 0) + 1 + children.length}
                            </div>
                            <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.5)', marginTop: 4,
                              letterSpacing: '0.05em' }}>workflows</div>
                          </div>
                          <div style={{ background: '#fff' }}>
                            {parentExec && (() => {
                              const pid = parentExec.workflowId || parentExec.workflow_id
                              const pLive = (temporalData?.childWorkflows || {})[pid] || {}
                              return (
                                <NodeRow marker="◆" role="Parent"
                                  wfId={pid}
                                  type={parentType?.name || ''}
                                  status={pLive.status || null} />
                              )
                            })()}
                            <NodeRow marker={parentExec ? '└─◉' : '◉'} role="Current"
                              wfId={thisWfId}
                              type={thisType}
                              proc={thisProc}
                              status={thisStatus}
                              indent={parentExec ? 1 : 0} />
                            {children.map((c, i) => (
                              <NodeRow key={c.initiatedEventId || i}
                                marker={(parentExec ? '    ' : '  ') + '└─◇'}
                                role="Child"
                                wfId={c.wfId}
                                type={c.type}
                                status={c.status}
                                evtRef={c.eventId || c.initiatedEventId}
                                indent={(parentExec ? 1 : 0) + 1} />
                            ))}
                            {children.length === 0 && !parentExec && (
                              <div style={{ padding: '12px 14px', color: '#9ca3af', fontSize: 11, fontStyle: 'italic' }}>
                                Standalone workflow — no parent or children.
                              </div>
                            )}
                          </div>
                        </div>
                      )
                    })()}
                  </>
                )
              })()}

              {/* ── How did you fix ── */}
              {temporalData && (
                <div style={{ display: 'grid', gridTemplateColumns: '0.35fr 1fr', gap: 3 }}>
                  <div style={{ background: '#fef3c7', padding: '16px 20px' }}>
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                      <div style={{ fontSize: 9, fontWeight: 800, color: '#92400e', textTransform: 'uppercase',
                        letterSpacing: '0.1em' }}>How Did<br/>You Fix?</div>
                      <div style={{ position: 'relative', display: 'inline-block' }}>
                        <div style={{ width: 15, height: 15, borderRadius: '50%', background: '#92400e', color: '#fff',
                          fontSize: 10, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center',
                          cursor: 'help', flexShrink: 0, marginTop: 1 }}
                          onMouseEnter={e => { e.currentTarget.nextSibling.style.display = 'block' }}
                          onMouseLeave={e => { e.currentTarget.nextSibling.style.display = 'none' }}>i</div>
                        <div style={{ display: 'none', position: 'absolute', left: 20, top: -4, width: 260,
                          background: '#1e293b', color: '#e2e8f0', fontSize: 11, lineHeight: 1.55, padding: '10px 14px',
                          borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.25)', zIndex: 50, pointerEvents: 'none' }}>
                          <div style={{ fontWeight: 700, color: '#fbbf24', marginBottom: 4, fontSize: 10, textTransform: 'uppercase',
                            letterSpacing: '0.05em' }}>Learning Loop</div>
                          User fixes issue &rarr; submits fix &rarr; stored in DB &rarr; next similar failure &rarr; AI finds past fix &rarr; suggests proven resolution &rarr; user validates &rarr; knowledge base grows smarter
                        </div>
                      </div>
                    </div>
                  </div>
                  <div style={{ background: '#f8fafc', padding: '14px 18px' }}>
                    {fixNoteSubmitted ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                        <span style={{ fontSize: 12, color: '#065f46', fontWeight: 600 }}>Fix note saved. Thank you!</span>
                      </div>
                    ) : (
                      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                        <textarea
                          value={fixNote}
                          onChange={e => setFixNote(e.target.value)}
                          placeholder="Describe how you resolved this issue..."
                          style={{ flex: 1, minHeight: 60, padding: '10px 12px', fontSize: 12, border: '1.5px solid #e2e8f0',
                            borderRadius: 6, resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5,
                            outline: 'none', transition: 'border-color 0.15s', color: '#111827' }}
                          onFocus={e => e.target.style.borderColor = '#6366f1'}
                          onBlur={e => e.target.style.borderColor = '#e2e8f0'}
                        />
                        <button
                          disabled={!fixNote.trim()}
                          onClick={() => {
                            const ai = temporalData?.aiAnalysis || {}
                            const analysis = temporalData?.analysis || {}
                            const actFails = analysis.activityFailures || []
                            const af = actFails[0] || {}
                            const failedPaths = analysis.failedApiPaths || []
                            fetch(`${API}/api/temporal/submit-fix`, {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({
                                workflow_id: selectedWf?.workflow_id || '',
                                tenant: app?.tenant || '',
                                app_name: app?.name || '',
                                fix_description: fixNote.trim(),
                                error_context: {
                                  error_step: af.label || af.stepId || '',
                                  error_service: (af.service || {}).name || '',
                                  error_http_code: af.httpCode || null,
                                  error_message: (af.message || '').slice(0, 500),
                                  error_body: (typeof af.errorBody === 'string' ? af.errorBody : JSON.stringify(af.errorBody || '')).slice(0, 500),
                                  error_api_path: (failedPaths[0] || {}).path || '',
                                  ai_root_cause: (ai.rootCause || '').slice(0, 500),
                                },
                              }),
                            })
                            .then(r => r.json())
                            .then(() => setFixNoteSubmitted(true))
                            .catch(() => setFixNoteSubmitted(true))
                          }}
                          style={{ padding: '10px 20px', background: fixNote.trim() ? '#111827' : '#e2e8f0',
                            color: fixNote.trim() ? '#fff' : '#9ca3af', border: 'none', fontSize: 12,
                            fontWeight: 700, cursor: fixNote.trim() ? 'pointer' : 'default',
                            transition: 'all 0.15s', flexShrink: 0 }}>
                          Submit
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Flow Visualization modal ── */}
      {showFlowViz && temporalData && (() => {
        const analysis = temporalData.analysis || {}
        const timeline = analysis.activityTimeline || []
        const actFails = analysis.activityFailures || []
        const failStepIds = new Set(actFails.map(a => a.stepId).filter(Boolean))
        const failMap = {}
        actFails.forEach(af => { if (af.stepId) failMap[af.stepId] = af })
        const events = Array.isArray(temporalData.events) ? temporalData.events : []

        // Build time map from events
        const timeMap = {}
        events.forEach(evt => {
          const etype = evt.eventType || evt.event_type || ''
          const eid = String(evt.eventId || '')
          const etime = evt.eventTime || evt.event_time || ''
          if (etype === 'EVENT_TYPE_ACTIVITY_TASK_SCHEDULED') timeMap[eid] = { scheduled: etime }
          if (etype === 'EVENT_TYPE_ACTIVITY_TASK_STARTED') {
            const sid = String((evt.activityTaskStartedEventAttributes || {}).scheduledEventId || '')
            if (timeMap[sid]) timeMap[sid].started = etime
          }
          if (etype === 'EVENT_TYPE_ACTIVITY_TASK_COMPLETED') {
            const sid = String((evt.activityTaskCompletedEventAttributes || {}).scheduledEventId || '')
            if (timeMap[sid]) timeMap[sid].completed = etime
          }
          if (etype === 'EVENT_TYPE_ACTIVITY_TASK_FAILED') {
            const sid = String((evt.activityTaskFailedEventAttributes || {}).scheduledEventId || '')
            if (timeMap[sid]) timeMap[sid].failed = etime
          }
        })

        // Build nodes from timeline
        const nodes = timeline.map((t, i) => {
          const isFailed = failStepIds.has(t.stepId)
          const failInfo = failMap[t.stepId]
          const times = timeMap[String(t.eventId)] || {}
          let duration = null
          const endT = times.completed || times.failed
          if (times.scheduled && endT) {
            duration = new Date(endT) - new Date(times.scheduled)
          }
          return { ...t, idx: i, isFailed, failInfo, times, duration }
        })

        const hasTrigger = !!(analysis.triggeredBy)
        const startEvt = events.find(e => (e.eventType || e.event_type || '').includes('STARTED'))
        const triggerTime = startEvt ? (startEvt.eventTime || startEvt.event_time) : null
        const sel = flowSelectedNode === 'trigger' ? 'trigger' : (flowSelectedNode != null ? nodes[flowSelectedNode] : null)

        // Layout: nodes in a flowing grid
        const COLS = 3
        const NODE_W = 260, NODE_H = 80, GAP_X = 80, GAP_Y = 50
        const TRIGGER_H = 56
        const Y_OFFSET = hasTrigger ? TRIGGER_H + GAP_Y : 0
        const rows = Math.ceil(nodes.length / COLS)
        const svgW = COLS * NODE_W + (COLS - 1) * GAP_X + 80
        const svgH = Y_OFFSET + rows * NODE_H + (rows - 1) * GAP_Y + 80
        const triggerX = 40 + (NODE_W + GAP_X) // center column
        const triggerY = 40

        const getPos = (idx) => {
          const row = Math.floor(idx / COLS)
          const colInRow = idx % COLS
          const col = row % 2 === 0 ? colInRow : (COLS - 1 - colInRow)
          return {
            x: 40 + col * (NODE_W + GAP_X),
            y: 40 + Y_OFFSET + row * (NODE_H + GAP_Y),
          }
        }

        return (
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 2100,
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
            onClick={() => setShowFlowViz(false)}>
            <div style={{ background: '#f8fafc', borderRadius: 16, width: '96vw', maxWidth: 1400,
              maxHeight: '94vh', overflow: 'hidden', display: 'flex', flexDirection: 'column',
              boxShadow: '0 25px 60px rgba(0,0,0,0.25)' }}
              onClick={e => e.stopPropagation()}>

              {/* Header */}
              <div style={{ padding: '16px 24px', borderBottom: '1.5px solid #e5e7eb', display: 'flex',
                justifyContent: 'space-between', alignItems: 'center', background: '#fff', flexShrink: 0 }}>
                <div>
                  <div style={{ fontSize: 16, fontWeight: 800, color: '#111827' }}>Workflow Flow</div>
                  <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2, fontFamily: 'monospace' }}>
                    {analysis.workflowId || selectedWf?.workflow_id} &middot; {nodes.length} steps
                  </div>
                </div>
                <button onClick={() => setShowFlowViz(false)}
                  style={{ background: '#fff', border: '1.5px solid #e2e8f0', borderRadius: '50%',
                    width: 34, height: 34, cursor: 'pointer', color: '#64748b', fontSize: 16, lineHeight: 1,
                    display: 'flex', alignItems: 'center', justifyContent: 'center' }}>✕</button>
              </div>

              {/* Body: flow + detail panel */}
              <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
                {/* Flow canvas */}
                <div style={{ flex: 1, overflow: 'auto', padding: 20, background: '#f8fafc' }}>
                  {nodes.length === 0 ? (
                    <div style={{ color: '#9ca3af', textAlign: 'center', padding: '60px 0', fontSize: 14 }}>
                      No activity steps found in this workflow
                    </div>
                  ) : (
                    <div style={{ position: 'relative', display: 'inline-block' }}>
                    <svg width={svgW} height={svgH} style={{ display: 'block' }}>
                      <defs>
                        <marker id="fv-arrow" viewBox="0 0 10 10" refX="10" refY="5"
                          markerWidth="8" markerHeight="8" orient="auto-start-reverse">
                          <path d="M 0 0 L 10 5 L 0 10 z" fill="#cbd5e1" />
                        </marker>
                        <marker id="fv-arrow-fail" viewBox="0 0 10 10" refX="10" refY="5"
                          markerWidth="8" markerHeight="8" orient="auto-start-reverse">
                          <path d="M 0 0 L 10 5 L 0 10 z" fill="#fca5a5" />
                        </marker>
                        <filter id="fv-shadow" x="-10%" y="-10%" width="120%" height="130%">
                          <feDropShadow dx="0" dy="2" stdDeviation="4" floodOpacity="0.08" />
                        </filter>
                        <filter id="fv-shadow-sel" x="-10%" y="-10%" width="120%" height="130%">
                          <feDropShadow dx="0" dy="3" stdDeviation="8" floodOpacity="0.18" />
                        </filter>
                        <marker id="fv-arrow-trig" viewBox="0 0 10 10" refX="10" refY="5"
                          markerWidth="8" markerHeight="8" orient="auto-start-reverse">
                          <path d="M 0 0 L 10 5 L 0 10 z" fill="#a5b4fc" />
                        </marker>
                      </defs>

                      {/* Trigger node */}
                      {hasTrigger && (() => {
                        const tb = analysis.triggeredBy
                        const isTrigSel = flowSelectedNode === 'trigger'
                        return (
                          <g style={{ cursor: 'pointer' }}
                            onClick={(e) => { e.stopPropagation(); setFlowSelectedNode(isTrigSel ? null : 'trigger') }}>
                            <title>{`Triggered: ${triggerTime ? new Date(triggerTime).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : 'N/A'}\nUser: ${tb.user || 'Unknown'}${tb.ip ? `\nIP: ${tb.ip}` : ''}${(analysis.request||{}).url ? `\n${(analysis.request||{}).method} ${(analysis.request||{}).url}` : ''}`}</title>
                            <rect x={triggerX} y={triggerY} width={NODE_W} height={TRIGGER_H}
                              rx={28} ry={28} fill={isTrigSel ? '#c7d2fe' : '#e0e7ff'}
                              stroke={isTrigSel ? '#6366f1' : '#a5b4fc'} strokeWidth={isTrigSel ? 2.5 : 1.5}
                              filter={isTrigSel ? 'url(#fv-shadow-sel)' : 'url(#fv-shadow)'} />
                            <circle cx={triggerX + 28} cy={triggerY + TRIGGER_H / 2} r={16} fill="#6366f1" />
                            <text x={triggerX + 28} y={triggerY + TRIGGER_H / 2 + 5} textAnchor="middle"
                              fontSize="14" fontWeight="700" fill="#fff" style={{ pointerEvents: 'none' }}>
                              {(tb.user || '?')[0].toUpperCase()}
                            </text>
                            <text x={triggerX + 52} y={triggerY + TRIGGER_H / 2 - 4} fontSize="12" fontWeight="700"
                              fill="#312e81" style={{ pointerEvents: 'none' }}>
                              {(tb.user || 'Unknown').slice(0, 24)}
                            </text>
                            <text x={triggerX + 52} y={triggerY + TRIGGER_H / 2 + 12} fontSize="9.5" fill="#6366f1"
                              fontFamily="monospace" style={{ pointerEvents: 'none' }}>
                              {tb.ip || tb.origin || 'Trigger'}
                            </text>
                          </g>
                        )
                      })()}

                      {/* Connection from trigger to first step */}
                      {hasTrigger && nodes.length > 0 && (() => {
                        const firstPos = getPos(0)
                        const fromCX = triggerX + NODE_W / 2
                        const fromY = triggerY + TRIGGER_H
                        const toCX = firstPos.x + NODE_W / 2
                        const toY = firstPos.y
                        if (Math.abs(fromCX - toCX) < 1) {
                          return <line x1={fromCX} y1={fromY} x2={toCX} y2={toY}
                            stroke="#a5b4fc" strokeWidth={2} markerEnd="url(#fv-arrow-trig)" />
                        }
                        const midY = fromY + GAP_Y / 2
                        return <path d={`M ${fromCX} ${fromY} L ${fromCX} ${midY} L ${toCX} ${midY} L ${toCX} ${toY}`}
                          fill="none" stroke="#a5b4fc" strokeWidth={2} markerEnd="url(#fv-arrow-trig)" />
                      })()}

                      {/* Connection lines */}
                      {nodes.map((n, i) => {
                        if (i === 0) return null
                        const from = getPos(i - 1)
                        const to = getPos(i)
                        const fromCX = from.x + NODE_W / 2
                        const fromCY = from.y + NODE_H / 2
                        const toCX = to.x + NODE_W / 2
                        const toCY = to.y + NODE_H / 2

                        const sameRow = Math.floor(i / COLS) === Math.floor((i - 1) / COLS)
                        const nextIsFailed = n.isFailed
                        const markerUrl = nextIsFailed ? 'url(#fv-arrow-fail)' : 'url(#fv-arrow)'
                        const lineColor = nextIsFailed ? '#fca5a5' : '#cbd5e1'

                        if (sameRow) {
                          // Horizontal connection
                          const startX = Math.min(from.x + NODE_W, to.x + NODE_W)
                          const endX = Math.max(from.x, to.x)
                          return (
                            <line key={`ln${i}`}
                              x1={from.x + (from.x < to.x ? NODE_W : 0)} y1={from.y + NODE_H / 2}
                              x2={to.x + (from.x < to.x ? 0 : NODE_W)} y2={to.y + NODE_H / 2}
                              stroke={lineColor} strokeWidth={2} markerEnd={markerUrl} />
                          )
                        } else {
                          // Vertical wrap: down from prev row, then across to new position
                          const midY = from.y + NODE_H + (GAP_Y / 2)
                          return (
                            <path key={`ln${i}`}
                              d={`M ${fromCX} ${from.y + NODE_H} L ${fromCX} ${midY} L ${toCX} ${midY} L ${toCX} ${to.y}`}
                              fill="none" stroke={lineColor} strokeWidth={2} markerEnd={markerUrl} />
                          )
                        }
                      })}

                      {/* Nodes */}
                      {nodes.map((n, i) => {
                        const pos = getPos(i)
                        const isSelected = flowSelectedNode === i
                        const methodMatch = n.apiPath ? null : null
                        const method = (analysis.allApiPaths || []).find(p => p.stepId === n.stepId)?.method || 'CALL'
                        const methodColors = { GET: '#16a34a', POST: '#f59e0b', PUT: '#3b82f6', DELETE: '#ef4444', PATCH: '#8b5cf6' }
                        const mColor = methodColors[method] || '#6b7280'

                        return (
                          <g key={`nd${i}`} style={{ cursor: 'pointer' }}
                            onClick={(e) => { e.stopPropagation(); setFlowSelectedNode(isSelected ? null : i) }}>
                            <title>{`${n.label || n.activity || `Step ${i+1}`}${n.times.scheduled ? `\nScheduled: ${new Date(n.times.scheduled).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}` : ''}${n.times.started ? `\nStarted: ${new Date(n.times.started).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}` : ''}${n.times.completed ? `\nCompleted: ${new Date(n.times.completed).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}` : ''}${n.times.failed ? `\nFailed: ${new Date(n.times.failed).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}` : ''}${n.duration != null ? `\nDuration: ${n.duration < 1000 ? n.duration + 'ms' : (n.duration/1000).toFixed(2) + 's'}` : ''}${n.apiPath ? `\n${method} ${n.apiPath}` : ''}${n.service ? `\nService: ${n.service.name}` : ''}`}</title>
                            {/* Card background */}
                            <rect x={pos.x} y={pos.y} width={NODE_W} height={NODE_H}
                              rx={12} ry={12}
                              fill={n.isFailed ? '#fef2f2' : '#fff'}
                              stroke={isSelected ? '#6366f1' : n.isFailed ? '#fca5a5' : '#e5e7eb'}
                              strokeWidth={isSelected ? 2.5 : 1.5}
                              filter={isSelected ? 'url(#fv-shadow-sel)' : 'url(#fv-shadow)'} />
                            {/* Left color accent */}
                            <rect x={pos.x} y={pos.y} width={5} height={NODE_H}
                              rx={2} fill={n.isFailed ? '#ef4444' : '#16a34a'} />
                            {/* Step label */}
                            <text x={pos.x + 16} y={pos.y + 22} fontSize="12" fontWeight="700"
                              fill="#111827" style={{ pointerEvents: 'none' }}>
                              {(n.label || n.activity || `Step ${i + 1}`).slice(0, 30)}
                            </text>
                            {/* Method badge + API path */}
                            {n.apiPath && (
                              <>
                                <rect x={pos.x + 16} y={pos.y + 32} width={method.length * 7 + 8} height={16}
                                  rx={3} fill={mColor} />
                                <text x={pos.x + 20} y={pos.y + 44} fontSize="9" fontWeight="800"
                                  fill="#fff" style={{ pointerEvents: 'none' }}>{method}</text>
                                <text x={pos.x + 16 + method.length * 7 + 14} y={pos.y + 44}
                                  fontSize="10" fill="#64748b" fontFamily="monospace"
                                  style={{ pointerEvents: 'none' }}>
                                  {n.apiPath.length > 24 ? n.apiPath.slice(0, 24) + '...' : n.apiPath}
                                </text>
                              </>
                            )}
                            {/* Service badge */}
                            {n.service && (
                              <g>
                                <rect x={pos.x + 16} y={pos.y + NODE_H - 24} width={n.service.name.length * 6.5 + 12} height={16}
                                  rx={4} fill="#dbeafe" />
                                <text x={pos.x + 22} y={pos.y + NODE_H - 12} fontSize="9" fontWeight="700"
                                  fill="#1e40af" style={{ pointerEvents: 'none' }}>{n.service.name}</text>
                              </g>
                            )}
                            {/* Duration */}
                            {n.duration != null && (
                              <text x={pos.x + NODE_W - 14} y={pos.y + NODE_H - 12}
                                textAnchor="end" fontSize="9" fill="#9ca3af" fontFamily="monospace"
                                style={{ pointerEvents: 'none' }}>
                                {n.duration < 1000 ? `${n.duration}ms` : `${(n.duration/1000).toFixed(1)}s`}
                              </text>
                            )}
                            {/* Failed icon */}
                            {n.isFailed && (
                              <text x={pos.x + NODE_W - 14} y={pos.y + 20}
                                textAnchor="end" fontSize="14" style={{ pointerEvents: 'none' }}>
                                &#x26A0;
                              </text>
                            )}
                          </g>
                        )
                      })}
                    </svg>

                    </div>
                  )}
                </div>

                {/* Detail side panel */}
                {(sel === 'trigger' || sel) && (
                  <div style={{ width: 380, borderLeft: '1.5px solid #e5e7eb', background: '#fff',
                    overflow: 'auto', flexShrink: 0 }}>

                    {sel === 'trigger' ? (() => {
                      const tb = analysis.triggeredBy || {}
                      const req = analysis.request
                      return (
                        <>
                          {/* Trigger header */}
                          <div style={{ padding: '20px', background: '#e0e7ff', borderBottom: '1px solid #c7d2fe' }}>
                            <div style={{ fontSize: 8, fontWeight: 800, color: '#6366f1', textTransform: 'uppercase',
                              letterSpacing: '0.1em', marginBottom: 10 }}>Triggered By</div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                              <div style={{ width: 40, height: 40, borderRadius: '50%', background: '#6366f1',
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                fontSize: 18, fontWeight: 700, color: '#fff', flexShrink: 0 }}>
                                {(tb.user || '?')[0].toUpperCase()}
                              </div>
                              <div>
                                <div style={{ fontSize: 16, fontWeight: 800, color: '#312e81' }}>{tb.user || 'Unknown'}</div>
                                {tb.ip && <div style={{ fontSize: 11, color: '#4338ca', fontFamily: 'monospace', marginTop: 2 }}>{tb.ip}</div>}
                              </div>
                            </div>
                          </div>

                          {/* Trigger details */}
                          <div style={{ padding: '12px 20px', borderBottom: '1px solid #f3f4f6' }}>
                            {tb.userAgent && (
                              <div style={{ marginBottom: 10 }}>
                                <div style={{ fontSize: 9, fontWeight: 700, color: '#6366f1', textTransform: 'uppercase',
                                  letterSpacing: '0.05em', marginBottom: 2 }}>User-Agent</div>
                                <div style={{ fontSize: 10.5, fontFamily: 'monospace', color: '#334155', wordBreak: 'break-word', lineHeight: 1.4 }}>
                                  {tb.userAgent}</div>
                              </div>
                            )}
                            {tb.referer && (
                              <div style={{ marginBottom: 10 }}>
                                <div style={{ fontSize: 9, fontWeight: 700, color: '#6366f1', textTransform: 'uppercase',
                                  letterSpacing: '0.05em', marginBottom: 2 }}>Referer</div>
                                <div style={{ fontSize: 10.5, fontFamily: 'monospace', color: '#334155', wordBreak: 'break-all', lineHeight: 1.4 }}>
                                  {tb.referer}</div>
                              </div>
                            )}
                            <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
                              {tb.origin && (
                                <div>
                                  <div style={{ fontSize: 9, fontWeight: 700, color: '#6366f1', textTransform: 'uppercase',
                                    letterSpacing: '0.05em', marginBottom: 2 }}>Origin</div>
                                  <div style={{ fontSize: 11, fontFamily: 'monospace', color: '#334155' }}>{tb.origin}</div>
                                </div>
                              )}
                              {tb.appEnv && (
                                <div>
                                  <div style={{ fontSize: 9, fontWeight: 700, color: '#6366f1', textTransform: 'uppercase',
                                    letterSpacing: '0.05em', marginBottom: 2 }}>Environment</div>
                                  <div style={{ fontSize: 11, fontFamily: 'monospace', color: '#334155' }}>{tb.appEnv}</div>
                                </div>
                              )}
                            </div>
                          </div>

                          {/* Request / cURL */}
                          {req && req.url && (
                            <div style={{ padding: '14px 20px' }}>
                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                                <div style={{ fontSize: 8, fontWeight: 800, color: '#92400e', textTransform: 'uppercase',
                                  letterSpacing: '0.1em' }}>Request</div>
                                <button onClick={() => {
                                    const hdrs = req.headers || {}
                                    const curlParts = [`curl -X ${req.method} '${req.url}'`]
                                    Object.entries(hdrs).forEach(([k, v]) => {
                                      if (v && v !== 'Bearer <token>') curlParts.push(`  -H '${k}: ${v}'`)
                                      else if (k === 'Authorization') curlParts.push(`  -H '${k}: Bearer <YOUR_TOKEN>'`)
                                    })
                                    if (req.params && Object.keys(req.params).length > 0)
                                      curlParts.push(`  -d '${JSON.stringify(req.params)}'`)
                                    navigator.clipboard.writeText(curlParts.join(' \\\n'))
                                  }}
                                  style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: '#1e293b',
                                    color: '#fff', border: 'none', borderRadius: 5, padding: '4px 10px', fontSize: 10,
                                    fontWeight: 700, cursor: 'pointer' }}
                                  onMouseEnter={e => { e.currentTarget.style.background = '#334155' }}
                                  onMouseLeave={e => { e.currentTarget.style.background = '#1e293b' }}>
                                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                    <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
                                  </svg>
                                  Copy cURL
                                </button>
                              </div>
                              {/* URL bar */}
                              <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10, borderRadius: 6,
                                overflow: 'hidden', border: '1.5px solid #e5e7eb' }}>
                                <div style={{ background: '#dbeafe', padding: '6px 10px', fontWeight: 800, fontSize: 10,
                                  color: '#1e40af', flexShrink: 0 }}>{req.method}</div>
                                <div style={{ background: '#fff', padding: '6px 10px', fontSize: 10, fontFamily: 'monospace',
                                  color: '#1e293b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}
                                  title={req.url}>
                                  {req.url}
                                </div>
                              </div>
                              {/* Headers */}
                              {req.headers && (
                                <div style={{ marginBottom: 8 }}>
                                  <div style={{ fontSize: 9, fontWeight: 700, color: '#92400e', textTransform: 'uppercase',
                                    letterSpacing: '0.05em', marginBottom: 4 }}>Headers</div>
                                  <div style={{ background: '#fffbeb', borderRadius: 5, border: '1px solid #fde68a', overflow: 'hidden' }}>
                                    {Object.entries(req.headers).filter(([,v]) => v).map(([k, v], i, arr) => (
                                      <div key={k} style={{ display: 'grid', gridTemplateColumns: '100px 1fr', fontSize: 10,
                                        borderBottom: i < arr.length - 1 ? '1px solid #fef3c7' : 'none' }}>
                                        <div style={{ padding: '4px 8px', fontWeight: 700, color: '#92400e' }}>{k}</div>
                                        <div style={{ padding: '4px 8px', fontFamily: 'monospace', color: '#334155', wordBreak: 'break-all' }}>{v}</div>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              )}
                              {/* Body / Params */}
                              {req.params && Object.keys(req.params).length > 0 && (
                                <div>
                                  <div style={{ fontSize: 9, fontWeight: 700, color: '#92400e', textTransform: 'uppercase',
                                    letterSpacing: '0.05em', marginBottom: 4 }}>Body / Params</div>
                                  <div style={{ background: '#fffbeb', borderRadius: 5, border: '1px solid #fde68a', overflow: 'hidden' }}>
                                    {Object.entries(req.params).map(([k, v], i, arr) => (
                                      <div key={k} style={{ display: 'grid', gridTemplateColumns: '100px 1fr', fontSize: 10,
                                        borderBottom: i < arr.length - 1 ? '1px solid #fef3c7' : 'none' }}>
                                        <div style={{ padding: '4px 8px', fontWeight: 700, color: '#065f46' }}>{k}</div>
                                        <div style={{ padding: '4px 8px', fontFamily: 'monospace', color: '#334155', wordBreak: 'break-all' }}>
                                          {typeof v === 'object' ? JSON.stringify(v) : String(v)}</div>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              )}
                            </div>
                          )}
                        </>
                      )
                    })() : (
                      <>
                    {/* Panel header */}
                    <div style={{ padding: '16px 20px', borderBottom: '1px solid #f3f4f6' }}>
                      <div style={{ fontSize: 8, fontWeight: 800, color: '#9ca3af', textTransform: 'uppercase',
                        letterSpacing: '0.1em', marginBottom: 4 }}>Task</div>
                      <div style={{ fontSize: 15, fontWeight: 700, color: '#111827' }}>
                        {sel.label || sel.activity || `Step ${sel.idx + 1}`}
                      </div>
                      {sel.stepId && (
                        <div style={{ fontSize: 10, color: '#94a3b8', fontFamily: 'monospace', marginTop: 2 }}>{sel.stepId}</div>
                      )}
                    </div>

                    {/* Status */}
                    <div style={{ padding: '12px 20px', borderBottom: '1px solid #f3f4f6' }}>
                      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 12px',
                        borderRadius: 20, background: sel.isFailed ? '#fef2f2' : '#f0fdf4',
                        border: `1px solid ${sel.isFailed ? '#fca5a5' : '#bbf7d0'}` }}>
                        <div style={{ width: 8, height: 8, borderRadius: '50%',
                          background: sel.isFailed ? '#ef4444' : '#16a34a' }} />
                        <span style={{ fontSize: 11, fontWeight: 700,
                          color: sel.isFailed ? '#dc2626' : '#16a34a' }}>
                          {sel.isFailed ? 'Failed' : 'Completed'}
                        </span>
                      </div>
                    </div>

                    {/* API Details */}
                    {sel.apiPath && (
                      <div style={{ padding: '12px 20px', borderBottom: '1px solid #f3f4f6' }}>
                        <div style={{ fontSize: 8, fontWeight: 800, color: '#9ca3af', textTransform: 'uppercase',
                          letterSpacing: '0.1em', marginBottom: 6 }}>API Endpoint</div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                          {(() => {
                            const m = (analysis.allApiPaths || []).find(p => p.stepId === sel.stepId)?.method || 'CALL'
                            const mc = { GET: '#16a34a', POST: '#f59e0b', PUT: '#3b82f6', DELETE: '#ef4444', PATCH: '#8b5cf6' }
                            return (
                              <span style={{ background: mc[m] || '#6b7280', color: '#fff', padding: '2px 8px',
                                fontSize: 10, fontWeight: 800, borderRadius: 3 }}>{m}</span>
                            )
                          })()}
                          <span style={{ fontSize: 11, fontFamily: 'monospace', color: '#334155', wordBreak: 'break-all' }}>
                            {sel.apiPath}
                          </span>
                        </div>
                        {sel.apiUrl && (
                          <div style={{ fontSize: 10, fontFamily: 'monospace', color: '#94a3b8', wordBreak: 'break-all', marginTop: 4 }}>
                            {sel.apiUrl}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Service */}
                    {sel.service && (
                      <div style={{ padding: '12px 20px', borderBottom: '1px solid #f3f4f6' }}>
                        <div style={{ fontSize: 8, fontWeight: 800, color: '#9ca3af', textTransform: 'uppercase',
                          letterSpacing: '0.1em', marginBottom: 6 }}>Service</div>
                        <div style={{ fontSize: 13, fontWeight: 600, color: '#1e40af' }}>{sel.service.name}</div>
                        <div style={{ fontSize: 10, color: '#94a3b8', fontFamily: 'monospace', marginTop: 2 }}>
                          {sel.service.host}:{sel.service.port}
                        </div>
                        {sel.service.vsPrefix && (
                          <div style={{ fontSize: 10, color: '#94a3b8', fontFamily: 'monospace' }}>
                            route: {sel.service.vsPrefix}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Timing */}
                    <div style={{ padding: '12px 20px', borderBottom: '1px solid #f3f4f6' }}>
                      <div style={{ fontSize: 8, fontWeight: 800, color: '#9ca3af', textTransform: 'uppercase',
                        letterSpacing: '0.1em', marginBottom: 6 }}>Timing</div>
                      {sel.times.scheduled && (
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 3 }}>
                          <span style={{ color: '#6b7280' }}>Scheduled</span>
                          <span style={{ fontFamily: 'monospace', color: '#334155' }}>
                            {new Date(sel.times.scheduled).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })}
                          </span>
                        </div>
                      )}
                      {sel.times.started && (
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 3 }}>
                          <span style={{ color: '#6b7280' }}>Started</span>
                          <span style={{ fontFamily: 'monospace', color: '#334155' }}>
                            {new Date(sel.times.started).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })}
                          </span>
                        </div>
                      )}
                      {(sel.times.completed || sel.times.failed) && (
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 3 }}>
                          <span style={{ color: '#6b7280' }}>{sel.times.failed ? 'Failed' : 'Completed'}</span>
                          <span style={{ fontFamily: 'monospace', color: sel.times.failed ? '#dc2626' : '#334155' }}>
                            {new Date(sel.times.completed || sel.times.failed).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })}
                          </span>
                        </div>
                      )}
                      {sel.duration != null && (
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11,
                          paddingTop: 4, borderTop: '1px solid #f3f4f6' }}>
                          <span style={{ color: '#6b7280', fontWeight: 600 }}>Duration</span>
                          <span style={{ fontFamily: 'monospace', fontWeight: 700,
                            color: sel.duration > 5000 ? '#dc2626' : '#111827' }}>
                            {sel.duration < 1000 ? `${sel.duration}ms` : `${(sel.duration/1000).toFixed(2)}s`}
                          </span>
                        </div>
                      )}
                    </div>

                    {/* Error details (if failed) */}
                    {sel.failInfo && (
                      <div style={{ padding: '12px 20px', borderBottom: '1px solid #f3f4f6' }}>
                        <div style={{ fontSize: 8, fontWeight: 800, color: '#dc2626', textTransform: 'uppercase',
                          letterSpacing: '0.1em', marginBottom: 6 }}>Error Response</div>
                        {sel.failInfo.httpCode && (
                          <div style={{ display: 'inline-block', background: sel.failInfo.httpCode >= 500 ? '#dc2626' : '#f59e0b',
                            color: '#fff', padding: '2px 8px', fontSize: 11, fontWeight: 800, borderRadius: 3, marginBottom: 6 }}>
                            HTTP {sel.failInfo.httpCode}
                          </div>
                        )}
                        {sel.failInfo.errorBody && (
                          <div style={{ fontSize: 11, fontFamily: 'monospace', color: '#7f1d1d', background: '#fef2f2',
                            padding: '8px 10px', wordBreak: 'break-word', lineHeight: 1.5, borderRadius: 4 }}>
                            {typeof sel.failInfo.errorBody === 'string' ? sel.failInfo.errorBody : JSON.stringify(sel.failInfo.errorBody, null, 2)}
                          </div>
                        )}
                        {!sel.failInfo.errorBody && sel.failInfo.message && (
                          <div style={{ fontSize: 11, fontFamily: 'monospace', color: '#7f1d1d',
                            wordBreak: 'break-word', lineHeight: 1.5 }}>
                            {sel.failInfo.message}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Activity type */}
                    {sel.activity && (
                      <div style={{ padding: '12px 20px', borderBottom: '1px solid #f3f4f6' }}>
                        <div style={{ fontSize: 8, fontWeight: 800, color: '#9ca3af', textTransform: 'uppercase',
                          letterSpacing: '0.1em', marginBottom: 6 }}>Activity Type</div>
                        <div style={{ fontSize: 11, fontFamily: 'monospace', color: '#475569' }}>{sel.activity}</div>
                      </div>
                    )}

                    {/* Original request cURL for this workflow */}
                    {analysis.request && analysis.request.url && (
                      <div style={{ padding: '12px 20px', borderTop: '2px solid #fde68a', background: '#fffbeb' }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                          <div style={{ fontSize: 8, fontWeight: 800, color: '#92400e', textTransform: 'uppercase',
                            letterSpacing: '0.1em' }}>Original Request</div>
                          <button onClick={() => {
                              const req = analysis.request; const hdrs = req.headers || {}
                              const curlParts = [`curl -X ${req.method} '${req.url}'`]
                              Object.entries(hdrs).forEach(([k, v]) => {
                                if (v && v !== 'Bearer <token>') curlParts.push(`  -H '${k}: ${v}'`)
                                else if (k === 'Authorization') curlParts.push(`  -H '${k}: Bearer <YOUR_TOKEN>'`)
                              })
                              if (req.params && Object.keys(req.params).length > 0)
                                curlParts.push(`  -d '${JSON.stringify(req.params)}'`)
                              navigator.clipboard.writeText(curlParts.join(' \\\n'))
                            }}
                            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: '#1e293b',
                              color: '#fff', border: 'none', borderRadius: 5, padding: '4px 10px', fontSize: 10,
                              fontWeight: 700, cursor: 'pointer' }}
                            onMouseEnter={e => { e.currentTarget.style.background = '#334155' }}
                            onMouseLeave={e => { e.currentTarget.style.background = '#1e293b' }}>
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                              <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
                            </svg>
                            Copy cURL
                          </button>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8, borderRadius: 5,
                          overflow: 'hidden', border: '1px solid #e5e7eb' }}>
                          <div style={{ background: '#dbeafe', padding: '5px 8px', fontWeight: 800, fontSize: 9,
                            color: '#1e40af', flexShrink: 0 }}>{analysis.request.method}</div>
                          <div style={{ background: '#fff', padding: '5px 8px', fontSize: 9, fontFamily: 'monospace',
                            color: '#1e293b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}
                            title={analysis.request.url}>
                            {analysis.request.url}
                          </div>
                        </div>
                        {/* Headers */}
                        {analysis.request.headers && (
                          <div style={{ marginBottom: 8 }}>
                            <div style={{ fontSize: 9, fontWeight: 700, color: '#92400e', textTransform: 'uppercase',
                              letterSpacing: '0.05em', marginBottom: 4 }}>Headers</div>
                            <div style={{ background: '#fff', borderRadius: 5, border: '1px solid #fde68a', overflow: 'hidden' }}>
                              {Object.entries(analysis.request.headers).filter(([,v]) => v).map(([k, v], i, arr) => (
                                <div key={k} style={{ display: 'grid', gridTemplateColumns: '100px 1fr', fontSize: 10,
                                  borderBottom: i < arr.length - 1 ? '1px solid #fef3c7' : 'none' }}>
                                  <div style={{ padding: '4px 8px', fontWeight: 700, color: '#92400e' }}>{k}</div>
                                  <div style={{ padding: '4px 8px', fontFamily: 'monospace', color: '#334155', wordBreak: 'break-all' }}>{v}</div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                        {/* Body / Params */}
                        {analysis.request.params && Object.keys(analysis.request.params).length > 0 && (
                          <div>
                            <div style={{ fontSize: 9, fontWeight: 700, color: '#92400e', textTransform: 'uppercase',
                              letterSpacing: '0.05em', marginBottom: 4 }}>Body / Params</div>
                            <div style={{ background: '#fff', borderRadius: 5, border: '1px solid #fde68a', overflow: 'hidden' }}>
                              {Object.entries(analysis.request.params).map(([k, v], i, arr) => (
                                <div key={k} style={{ display: 'grid', gridTemplateColumns: '100px 1fr', fontSize: 10,
                                  borderBottom: i < arr.length - 1 ? '1px solid #fef3c7' : 'none' }}>
                                  <div style={{ padding: '4px 8px', fontWeight: 700, color: '#065f46' }}>{k}</div>
                                  <div style={{ padding: '4px 8px', fontFamily: 'monospace', color: '#334155', wordBreak: 'break-all' }}>
                                    {typeof v === 'object' ? JSON.stringify(v) : String(v)}</div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        )
      })()}

      {/* ── Runlog modal ── */}
      {runlogData && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 2000,
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
          onClick={() => setRunlogData(null)}>
          <div style={{ background: '#fff', borderRadius: 16, width: '90vw', maxWidth: 820,
            maxHeight: '88vh', overflow: 'hidden', display: 'flex', flexDirection: 'column',
            boxShadow: '0 20px 60px rgba(0,0,0,0.2)' }}
            onClick={e => e.stopPropagation()}>

            {/* Modal header */}
            <div style={{ padding: '18px 24px', borderBottom: '1.5px solid #e5e7eb', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 15, color: '#111827' }}>{runlogData.exec?.name}</div>
                <div style={{ fontSize: 12, color: '#6b7280', marginTop: 3, fontFamily: 'monospace' }}>{runlogData.exec?.id}</div>
                {runlogData.meta && (
                  <div style={{ display: 'flex', gap: 16, marginTop: 8, fontSize: 12 }}>
                    {[
                      { label: 'Started',   val: fmtTs(runlogData.exec?.startedAt) },
                      { label: 'Duration',  val: fmtDur(runlogData.meta.duration) },
                      { label: 'Flow Path', val: runlogData.meta.flowPath || '/' },
                      { label: 'Status',    val: execStatusMeta(runlogData.exec?.status).label, color: execStatusMeta(runlogData.exec?.status).color },
                    ].map(({ label, val, color }) => (
                      <span key={label} style={{ color: '#9ca3af' }}>{label}: <strong style={{ color: color || '#374151' }}>{val}</strong></span>
                    ))}
                  </div>
                )}
              </div>
              <button onClick={() => setRunlogData(null)}
                style={{ background: '#f3f4f6', border: 'none', borderRadius: 8, padding: '6px 10px', cursor: 'pointer', fontSize: 14, color: '#6b7280', flexShrink: 0 }}>
                ✕ Close
              </button>
            </div>

            {/* Modal body — steps */}
            <div style={{ overflowY: 'auto', padding: '20px 24px', flex: 1 }}>
              {runlogData.loading ? (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, padding: 40, color: '#6b7280' }}>
                  <div className={styles.spinner} /> Loading runlog…
                </div>
              ) : runlogData.error ? (
                <div style={{ color: '#dc2626', background: '#fef2f2', borderRadius: 10, padding: 16 }}>Error: {runlogData.error}</div>
              ) : runlogData.events?.length === 0 ? (
                <div style={{ textAlign: 'center', padding: 40, color: '#9ca3af' }}>No steps recorded for this execution.</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
                  {runlogData.events?.map((evt, i) => {
                    const desc = (() => { try { return JSON.parse(evt.description) } catch { return null } })()
                    const sm   = execStatusMeta(evt.status)
                    const hasErr = evt.error && evt.error !== 'null' && evt.error !== null
                    return (
                      <div key={i} style={{ display: 'flex', gap: 0 }}>
                        {/* Timeline line */}
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 36, flexShrink: 0 }}>
                          <div style={{ width: 28, height: 28, borderRadius: '50%', background: sm.bg, border: `2px solid ${sm.border}`,
                            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color: sm.color, flexShrink: 0 }}>
                            {i + 1}
                          </div>
                          {i < (runlogData.events?.length - 1) && (
                            <div style={{ width: 2, flex: 1, minHeight: 16, background: '#e5e7eb', margin: '4px 0' }} />
                          )}
                        </div>
                        {/* Step content */}
                        <div style={{ flex: 1, paddingLeft: 12, paddingBottom: 16, paddingTop: 2 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                            <span style={{ fontWeight: 700, fontSize: 13, color: '#111827' }}>
                              {desc?.customLabel || desc?.label || evt.stepName}
                            </span>
                            {desc?.nodeType && (
                              <span style={{ fontSize: 11, background: '#eef2ff', color: '#4f46e5', borderRadius: 5, padding: '1px 7px', fontWeight: 600 }}>
                                {desc.nodeType}
                              </span>
                            )}
                            <span style={{ color: sm.color, background: sm.bg, border: `1px solid ${sm.border}`,
                              borderRadius: 20, padding: '1px 9px', fontWeight: 700, fontSize: 11, marginLeft: 'auto' }}>
                              {sm.label}
                            </span>
                          </div>
                          <div style={{ fontSize: 11.5, color: '#6b7280', marginTop: 3 }}>
                            {evt.duration != null && <span>⏱ {fmtDur(evt.duration)}</span>}
                            {evt.startedAt && <span style={{ marginLeft: 12 }}>Started: {fmtTs(evt.startedAt)}</span>}
                          </div>
                          {hasErr && (
                            <div style={{ marginTop: 6, background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 7, padding: '6px 10px',
                              fontSize: 11.5, color: '#dc2626', fontFamily: 'monospace', wordBreak: 'break-all' }}>
                              {typeof evt.error === 'string' ? evt.error : JSON.stringify(evt.error)}
                            </div>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Root ─────────────────────────────────────────────────────────────────────

export default function TenantApps({ initialTarget } = {}) {
  const [selectedTenant,   setSelectedTenant]   = useState(
    initialTarget?.tenant ? { name: initialTarget.tenant } : null
  )
  const [selectedApp,      setSelectedApp]      = useState(
    initialTarget?.app ? { name: initialTarget.app } : null
  )
  const appliedTargetRef = useRef(initialTarget || null)

  // If user navigates here a second time with a new target, apply it.
  useEffect(() => {
    if (!initialTarget) return
    if (appliedTargetRef.current === initialTarget) return
    appliedTargetRef.current = initialTarget
    setSelectedTenant(initialTarget.tenant ? { name: initialTarget.tenant } : null)
    setSelectedApp(initialTarget.app ? { name: initialTarget.app } : null)
  }, [initialTarget])

  if (selectedTenant && selectedApp) {
    return (
      <AppDetailPage
        tenant={selectedTenant}
        app={selectedApp}
        initialEnv={appliedTargetRef.current?.env || null}
        initialSection={appliedTargetRef.current?.section || null}
        onBack={() => setSelectedApp(null)}
      />
    )
  }

  if (selectedTenant) {
    return <AppListPage tenant={selectedTenant} onBack={() => setSelectedTenant(null)} onSelectApp={setSelectedApp} />
  }

  return <TenantListPage onSelect={setSelectedTenant} />
}
