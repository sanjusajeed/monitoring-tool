import { useState, useEffect, useMemo, useRef, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'
import {
  ComposedChart, BarChart, PieChart,
  Area, Bar, Pie, Cell, Sector, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts'
import { istMidnightUtc } from '../utils/dates'

const API = import.meta.env.VITE_API_BASE_URL || ''

// ─── DateRangeFilter ─────────────────────────────────────────────────────────
const PRESETS = [
  { label: 'Today',         ist: true },
  { label: 'Last 1 hour',   hours: 1 },
  { label: 'Last 7 days',   hours: 24 * 7 },
  { label: 'Last 30 days',  hours: 24 * 30 },
]

function DateRangeFilter({ value, onChange }) {
  const pick = (preset) => {
    const end = new Date()
    const start = preset.ist
      ? istMidnightUtc(end)
      : new Date(Date.now() - preset.hours * 3600 * 1000)
    onChange({ start, end, label: preset.label })
  }
  return (
    <div style={{ display: 'inline-flex', gap: 2, padding: 3, background: '#f1f5f9', border: '1px solid #e2e8f0', borderRadius: 8 }}>
      {PRESETS.map(p => {
        const active = value?.label === p.label
        return (
          <button key={p.label} type="button" onClick={() => pick(p)}
            style={{
              padding: '6px 12px', fontSize: 12, fontWeight: 600,
              border: 'none', borderRadius: 6, cursor: 'pointer',
              background: active ? '#fff' : 'transparent',
              color: active ? '#1e40af' : '#64748b',
              boxShadow: active ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
              transition: 'all 0.15s', whiteSpace: 'nowrap',
            }}>
            {p.label}
          </button>
        )
      })}
    </div>
  )
}

// ─── Env tokens ──────────────────────────────────────────────────────────────
const ENV_META = {
  prod:  { label: 'PROD',  dot: '#dc2626', bg: '#fef2f2', border: '#fecaca' },
  uat:   { label: 'UAT',   dot: '#d97706', bg: '#fffbeb', border: '#fde68a' },
  qa:    { label: 'QA',    dot: '#2563eb', bg: '#eff6ff', border: '#bfdbfe' },
  dev:   { label: 'Dev',   dot: '#10b981', bg: '#ecfdf5', border: '#a7f3d0' },
  stage: { label: 'Stage', dot: '#8b5cf6', bg: '#f5f3ff', border: '#ddd6fe' },
  demo:  { label: 'Demo',  dot: '#0ea5e9', bg: '#ecfeff', border: '#a5f3fc' },
}
const envMeta = (e) => ENV_META[(e || '').toLowerCase()] || { label: e || 'unknown', dot: '#6b7280', bg: '#f9fafb', border: '#e5e7eb' }

// ─── Style primitives ────────────────────────────────────────────────────────
const cardBase = {
  background: '#fff',
  border: '1px solid #e2e8f0',
  borderRadius: 14,
  boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
}

// ─── KPI color definitions ───────────────────────────────────────────────────
const KPI_PALETTE = {
  tenants:  { bg: '#eff6ff', border: '#bfdbfe', iconBg: '#dbeafe', iconColor: '#3b82f6', numColor: '#1d4ed8' },
  apps:     { bg: '#f5f3ff', border: '#ddd6fe', iconBg: '#ede9fe', iconColor: '#7c3aed', numColor: '#6d28d9' },
  requests: { bg: '#f0fdf4', border: '#bbf7d0', iconBg: '#dcfce7', iconColor: '#16a34a', numColor: '#15803d' },
  errors:   { bg: '#fef2f2', border: '#fecaca', iconBg: '#fee2e2', iconColor: '#dc2626', numColor: '#b91c1c' },
  rate:     { bg: '#fffbeb', border: '#fde68a', iconBg: '#fef3c7', iconColor: '#d97706', numColor: '#b45309' },
}

// ─── SVG icon for KPI cards ──────────────────────────────────────────────────
function SummaryIcon({ type }) {
  const common = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }
  if (type === 'tenants') return (
    <svg {...common}>
      <path d="M16 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2"/>
      <circle cx="9.5" cy="7" r="4"/>
      <path d="M22 21v-2a4 4 0 0 0-3-3.87"/>
      <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
    </svg>
  )
  if (type === 'apps') return (
    <svg {...common}>
      <rect x="4" y="4" width="6" height="6" rx="1.5"/>
      <rect x="14" y="4" width="6" height="6" rx="1.5"/>
      <rect x="4" y="14" width="6" height="6" rx="1.5"/>
      <rect x="14" y="14" width="6" height="6" rx="1.5"/>
    </svg>
  )
  if (type === 'requests') return (
    <svg {...common}>
      <path d="M4 19V5"/><path d="M4 19h16"/>
      <rect x="7" y="11" width="3" height="5" rx="1"/>
      <rect x="12" y="7" width="3" height="9" rx="1"/>
      <rect x="17" y="9" width="3" height="7" rx="1"/>
    </svg>
  )
  if (type === 'errors') return (
    <svg {...common}>
      <path d="M10.3 4.3 2.8 17.1A2 2 0 0 0 4.5 20h15a2 2 0 0 0 1.7-2.9L13.7 4.3a2 2 0 0 0-3.4 0Z"/>
      <path d="M12 9v4"/><path d="M12 17h.01"/>
    </svg>
  )
  return (
    <svg {...common}>
      <path d="M19 5 5 19"/>
      <circle cx="7.5" cy="7.5" r="2"/>
      <circle cx="16.5" cy="16.5" r="2"/>
    </svg>
  )
}

// ─── Formatters ──────────────────────────────────────────────────────────────
const fmt = (v) => (v == null ? '—' : typeof v === 'number' ? v.toLocaleString() : v)
const pct = (v) => (v == null ? '—' : `${Number(v).toFixed(2)}%`)
const ms = (v) => {
  if (v == null) return '—'
  const n = Number(v)
  if (!isFinite(n)) return '—'
  if (n < 1000)    return `${Math.round(n)}ms`
  if (n < 60000)   return `${(n / 1000).toFixed(n < 10000 ? 2 : 1)}s`
  if (n < 3600000) { const m = Math.floor(n / 60000), s = Math.round((n % 60000) / 1000); return s ? `${m}m ${s}s` : `${m}m` }
  const h = Math.floor(n / 3600000), mm = Math.round((n % 3600000) / 60000)
  return mm ? `${h}h ${mm}m` : `${h}h`
}
const fmtK = (v) => v == null ? '—' : v >= 1e9 ? (v/1e9).toFixed(1)+'B' : v >= 1e6 ? (v/1e6).toFixed(1)+'M' : v >= 1e3 ? (v/1e3).toFixed(0)+'K' : String(v)

const appAvatarColor = (name) => {
  const palette = ['#6366f1','#f97316','#10b981','#3b82f6','#a855f7','#ec4899','#14b8a6','#f59e0b']
  let h = 0; for (const c of (name || '')) h = (h * 31 + c.charCodeAt(0)) & 0xffffffff
  return palette[Math.abs(h) % palette.length]
}
const appInitials = (name) => (name || '').split(/[\s\-.]+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase()

// ─── Env pill ─────────────────────────────────────────────────────────────────
function EnvPill({ env, compact = false }) {
  const m = envMeta(env)
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      background: m.bg, color: m.dot, border: `1px solid ${m.border}`,
      padding: compact ? '1px 7px' : '2px 9px', borderRadius: 999,
      fontSize: compact ? 10 : 11, fontWeight: 700,
    }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: m.dot }} />
      {m.label}
    </span>
  )
}

// ─── Fleet Traffic Chart ──────────────────────────────────────────────────────
function FleetTrafficChart({ buckets, hoursBack, loading }) {
  if (loading) return (
    <div style={{ height: 240, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#94a3b8', fontSize: 12 }}>
      Loading…
    </div>
  )
  if (!buckets || buckets.length === 0) return (
    <div style={{ height: 240, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#94a3b8', fontSize: 12 }}>
      No timeseries data for this range
    </div>
  )
  const fmtTs = (ts) => {
    const d = new Date(ts)
    if (hoursBack <= 24) return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata', hour12: false })
    if (hoursBack <= 168) return d.toLocaleDateString('en-IN', { weekday: 'short', hour: '2-digit', timeZone: 'Asia/Kolkata', hour12: false }).replace(',', '')
    return d.toLocaleDateString('en-IN', { month: 'short', day: '2-digit', timeZone: 'Asia/Kolkata' })
  }
  const chartData = buckets.map(b => ({
    label: fmtTs(b.ts),
    requests: b.requests,
    errorRate: b.error_rate_pct,
  }))
  return (
    <ResponsiveContainer width="100%" height={240}>
      <ComposedChart data={chartData} margin={{ top: 4, right: 52, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="reqGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stopColor="#3b82f6" stopOpacity={0.28}/>
            <stop offset="100%" stopColor="#3b82f6" stopOpacity={0.02}/>
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} stroke="#f0f4f8" strokeDasharray="0"/>
        <XAxis
          dataKey="label"
          tick={{ fontSize: 10, fill: '#94a3b8' }}
          tickLine={false}
          axisLine={false}
          interval="preserveStartEnd"
        />
        <YAxis
          yAxisId="left"
          tick={{ fontSize: 10, fill: '#94a3b8' }}
          tickLine={false}
          axisLine={false}
          tickFormatter={fmtK}
        />
        <YAxis
          yAxisId="right"
          orientation="right"
          tick={{ fontSize: 10, fill: '#ef4444' }}
          tickLine={false}
          axisLine={false}
          tickFormatter={v => v === 0 ? '0%' : v < 1 ? v.toFixed(1) + '%' : Math.round(v) + '%'}
        />
        <Tooltip
          cursor={{ stroke: '#cbd5e1', strokeWidth: 1 }}
          contentStyle={{ background: '#1e293b', border: 'none', borderRadius: 8, fontSize: 12, color: '#f8fafc', padding: '10px 14px' }}
          labelStyle={{ color: '#94a3b8', marginBottom: 6, fontWeight: 600 }}
          formatter={(v, n) => n === 'errorRate' ? [v.toFixed(2) + '%', 'Error Rate (%)'] : [fmtK(v), 'Requests']}
        />
        <Legend
          verticalAlign="top"
          align="right"
          iconType="circle"
          iconSize={8}
          wrapperStyle={{ paddingBottom: 8, fontSize: 11, color: '#374151' }}
          formatter={(name) => <span style={{ fontSize: 11, color: '#374151', fontWeight: 500 }}>{name}</span>}
        />
        <Area
          yAxisId="left"
          type="monotone"
          dataKey="requests"
          name="Requests"
          stroke="#3b82f6"
          strokeWidth={2}
          fill="url(#reqGrad)"
          dot={{ r: 2.5, fill: '#3b82f6', strokeWidth: 0 }}
          activeDot={{ r: 5, fill: '#3b82f6', stroke: '#fff', strokeWidth: 2 }}
        />
        <Line
          yAxisId="right"
          type="monotone"
          dataKey="errorRate"
          name="Error Rate (%)"
          stroke="#ef4444"
          strokeWidth={1.5}
          dot={{ r: 2.5, fill: '#ef4444', strokeWidth: 0 }}
          activeDot={{ r: 5, fill: '#ef4444', stroke: '#fff', strokeWidth: 2 }}
        />
      </ComposedChart>
    </ResponsiveContainer>
  )
}

// ─── Env Bar Chart ────────────────────────────────────────────────────────────
function EnvBarChart({ envTotals }) {
  if (!envTotals || envTotals.length === 0) return (
    <div style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#94a3b8', fontSize: 12 }}>
      No environment data
    </div>
  )
  const enriched = envTotals.map(e => ({ ...e, _label: (envMeta(e.env).label || e.env).toUpperCase() }))
  const maxReq = Math.max(...enriched.map(e => e.requests || 0), 1)

  return (
    <div>
      {/* Legend */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 16, marginBottom: 12, fontSize: 11, color: '#374151' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#6366f1', display: 'inline-block' }} />
          Requests
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#ef4444', display: 'inline-block' }} />
          Errors
        </span>
      </div>

      {/* Bar rows */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {enriched.map(e => {
          const pct = (e.requests || 0) / maxReq * 100
          const errCount = e.errors || 0
          const errRate = Number(e.error_rate_pct || 0).toFixed(2)
          const inside = pct > 18
          return (
            <div key={e.env} style={{ display: 'grid', gridTemplateColumns: '52px 1fr auto', gap: 10, alignItems: 'center' }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: '#374151', textAlign: 'right' }}>{e._label}</span>
              <div style={{ position: 'relative', height: 26, background: '#f1f5f9', borderRadius: 6 }}>
                {e.requests > 0 && (
                  <div style={{
                    position: 'absolute', left: 0, top: 0, bottom: 0,
                    width: `${pct}%`,
                    background: 'linear-gradient(90deg, #6366f1 0%, #818cf8 100%)',
                    borderRadius: 6,
                  }} />
                )}
                {e.requests > 0 && (
                  <span style={{
                    position: 'absolute',
                    left: inside ? 10 : `calc(${pct}% + 6px)`,
                    top: '50%', transform: 'translateY(-50%)',
                    fontSize: 11, fontWeight: 700,
                    color: inside ? '#fff' : '#374151',
                    whiteSpace: 'nowrap', zIndex: 1,
                  }}>
                    {(e.requests).toLocaleString()}
                  </span>
                )}
              </div>
              <span style={{ fontSize: 11, color: '#ef4444', whiteSpace: 'nowrap', minWidth: 96, textAlign: 'right' }}>
                {errCount.toLocaleString()} ({errRate}%)
              </span>
            </div>
          )
        })}
      </div>

      {/* X-axis ticks */}
      <div style={{ display: 'grid', gridTemplateColumns: '52px 1fr auto', gap: 10, marginTop: 8 }}>
        <span />
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#94a3b8' }}>
          {[0, 0.25, 0.5, 0.75, 1].map(f => (
            <span key={f}>{fmtK(Math.round(f * maxReq))}</span>
          ))}
        </div>
        <span />
      </div>
    </div>
  )
}

// ─── Tenant Donut Chart ───────────────────────────────────────────────────────
const DONUT_COLORS = ['#0ea5e9','#10b981','#f59e0b','#ef4444','#06b6d4','#f97316','#84cc16','#e879f9']

function renderActiveDonutSlice(props) {
  const { cx, cy, innerRadius, outerRadius, startAngle, endAngle, fill } = props
  return (
    <g>
      <Sector cx={cx} cy={cy} innerRadius={innerRadius - 4} outerRadius={outerRadius + 8}
        startAngle={startAngle} endAngle={endAngle} fill={fill}
        style={{ filter: `drop-shadow(0 4px 8px ${fill}66)` }} />
    </g>
  )
}

function TenantDonutChart({ tenants }) {
  const [activeIndex, setActiveIndex] = useState(null)
  if (!tenants || tenants.length === 0) return (
    <div style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#94a3b8', fontSize: 12 }}>
      No tenant data
    </div>
  )
  const allWfTotal  = tenants.reduce((s, t) => s + (t.workflow_total || 0), 0)
  const allWfFailed = tenants.reduce((s, t) => s + (t.workflow_failed || 0), 0)
  const successRate = allWfTotal > 0 ? Math.round((allWfTotal - allWfFailed) / allWfTotal * 100) : 0

  const sorted = [...tenants].sort((a, b) => (b.workflow_total || 0) - (a.workflow_total || 0))
  const top8 = sorted.filter(t => (t.workflow_total || 0) > 0).slice(0, 8)
  const totalWf = top8.reduce((s, t) => s + (t.workflow_total || 0), 0)
  const chartData = top8.map(t => ({ name: t.tenant, value: t.workflow_total || 0 }))

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 160px', height: 200 }}>
      {/* Donut — no recharts Legend so cx="50%" truly centers in this column */}
      <div style={{ position: 'relative' }}>
        <ResponsiveContainer width="100%" height={200}>
          <PieChart>
            <Pie
              data={chartData}
              dataKey="value"
              nameKey="name"
              cx="50%" cy="50%"
              innerRadius="50%" outerRadius="78%"
              paddingAngle={2}
              activeIndex={activeIndex}
              activeShape={renderActiveDonutSlice}
              onMouseEnter={(_, index) => setActiveIndex(index)}
              onMouseLeave={() => setActiveIndex(null)}
            >
              {chartData.map((_, i) => <Cell key={i} fill={DONUT_COLORS[i % DONUT_COLORS.length]} />)}
            </Pie>
            <Tooltip
              contentStyle={{ background: '#1e293b', border: 'none', borderRadius: 10, fontSize: 12, color: '#f8fafc', padding: '10px 14px' }}
              formatter={(v, name) => {
                const pct = totalWf > 0 ? ((v / totalWf) * 100).toFixed(1) : 0
                return [`${fmtK(v)} executions (${pct}%)`, name]
              }}
            />
          </PieChart>
        </ResponsiveContainer>
        {/* Center label — left/top 50% matches cx="50%" cy="50%" exactly */}
        <div style={{
          position: 'absolute', left: '50%', top: '50%',
          transform: 'translate(-50%, -50%)',
          textAlign: 'center', pointerEvents: 'none',
        }}>
          <div style={{ fontSize: 22, fontWeight: 800, color: '#0f172a', lineHeight: 1 }}>{successRate}%</div>
          <div style={{ fontSize: 11, fontWeight: 600, color: '#10b981', marginTop: 3 }}>Successful</div>
        </div>
      </div>

      {/* Custom legend */}
      <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 7, paddingRight: 4, overflow: 'hidden' }}>
        {chartData.map((d, i) => {
          const pctVal = totalWf > 0 ? (d.value / totalWf * 100).toFixed(0) : 0
          return (
            <div key={d.name} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: DONUT_COLORS[i % DONUT_COLORS.length], flexShrink: 0 }} />
              <span style={{ fontSize: 10, color: '#374151', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {d.name} <span style={{ color: '#94a3b8' }}>{pctVal}%</span>
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── Top Tenants Traffic Chart ────────────────────────────────────────────────
const TRAFFIC_COLORS = ['#ef4444','#f59e0b','#10b981','#3b82f6','#8b5cf6','#ec4899','#06b6d4','#f97316']

function TenantTrafficChart({ tenants }) {
  const [activeIndex, setActiveIndex] = useState(null)
  if (!tenants || tenants.length === 0) return (
    <div style={{ height: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#94a3b8', fontSize: 12 }}>No tenant data</div>
  )
  const top8 = [...tenants]
    .filter(t => (t.total_requests || 0) > 0)
    .sort((a, b) => (b.total_requests || 0) - (a.total_requests || 0))
    .slice(0, 8)
  const total = top8.reduce((s, t) => s + (t.total_requests || 0), 0)
  const chartData = top8.map(t => ({ name: t.tenant, value: t.total_requests || 0 }))

  return (
    <ResponsiveContainer width="100%" height={300}>
      <PieChart>
        <Pie
          data={chartData}
          dataKey="value"
          nameKey="name"
          cx="50%" cy="48%"
          innerRadius="48%" outerRadius="72%"
          paddingAngle={3}
          activeIndex={activeIndex}
          activeShape={renderActiveDonutSlice}
          onMouseEnter={(_, i) => setActiveIndex(i)}
          onMouseLeave={() => setActiveIndex(null)}
          strokeWidth={0}
        >
          {chartData.map((_, i) => <Cell key={i} fill={TRAFFIC_COLORS[i % TRAFFIC_COLORS.length]} />)}
        </Pie>
        <Tooltip
          contentStyle={{ background: '#1e293b', border: 'none', borderRadius: 10, fontSize: 12, color: '#f8fafc', padding: '10px 14px' }}
          formatter={(v, name) => {
            const pct = total > 0 ? ((v / total) * 100).toFixed(1) : 0
            return [`${fmtK(v)} requests (${pct}%)`, name]
          }}
        />
        <Legend
          layout="horizontal" align="center" verticalAlign="bottom"
          iconType="circle" iconSize={9}
          wrapperStyle={{ paddingTop: 12 }}
          formatter={(name) => {
            const t = top8.find(x => x.tenant === name)
            const pct = total > 0 ? (((t?.total_requests || 0) / total) * 100).toFixed(1) : 0
            return (
              <span style={{ fontSize: 11, color: '#374151', marginRight: 6 }}>
                {name} <span style={{ color: '#9ca3af' }}>{pct}%</span>
              </span>
            )
          }}
        />
      </PieChart>
    </ResponsiveContainer>
  )
}

// ─── Workflow Health Chart (stacked passed vs failed) ─────────────────────────
function WorkflowHealthChart({ tenants }) {
  if (!tenants || tenants.length === 0) return (
    <div style={{ height: 220, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#94a3b8', fontSize: 12 }}>No data</div>
  )
  const top8 = [...tenants]
    .filter(t => (t.workflow_total || 0) > 0)
    .sort((a, b) => (b.workflow_total || 0) - (a.workflow_total || 0))
    .slice(0, 8)
  const chartData = top8.map(t => {
    const failed = t.workflow_failed || 0
    const passed = Math.max(0, (t.workflow_total || 0) - failed)
    return {
      name: t.tenant.length > 12 ? t.tenant.slice(0, 11) + '…' : t.tenant,
      Passed: passed,
      Failed: failed,
    }
  })
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={chartData} layout="vertical" margin={{ top: 4, right: 14, left: 8, bottom: 0 }}>
        <CartesianGrid horizontal={false} stroke="#f1f5f9" />
        <XAxis type="number" tick={{ fontSize: 10, fill: '#94a3b8' }} tickLine={false} axisLine={false} tickFormatter={fmtK} />
        <YAxis type="category" dataKey="name" tick={{ fontSize: 10, fill: '#374151' }} tickLine={false} axisLine={false} width={80} />
        <Tooltip
          cursor={{ fill: 'rgba(99,102,241,0.05)' }}
          contentStyle={{ background: '#1e293b', border: 'none', borderRadius: 10, fontSize: 12, color: '#f8fafc', padding: '10px 14px' }}
          labelStyle={{ color: '#94a3b8', marginBottom: 6 }}
          formatter={(v, n) => [fmtK(v), n]}
        />
        <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11, paddingTop: 8 }} />
        <Bar dataKey="Passed" stackId="wf" fill="#10b981" radius={[0, 0, 0, 0]} maxBarSize={14} />
        <Bar dataKey="Failed" stackId="wf" fill="#ef4444" radius={[0, 4, 4, 0]} maxBarSize={14} />
      </BarChart>
    </ResponsiveContainer>
  )
}

// ─── App Latency Chart ────────────────────────────────────────────────────────
function AppLatencyChart({ rows }) {
  if (!rows || rows.length === 0) return (
    <div style={{ height: 220, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#94a3b8', fontSize: 12 }}>No latency data</div>
  )
  const top8 = rows.slice(0, 8)
  const chartData = top8.map(r => ({
    name: (r.app || r.tenant || '').slice(0, 14),
    P95:  Math.round(r.p95_latency_ms || 0),
    Avg:  Math.round(r.avg_latency_ms || 0),
  }))
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={chartData} layout="vertical" margin={{ top: 4, right: 14, left: 8, bottom: 0 }}>
        <CartesianGrid horizontal={false} stroke="#f1f5f9" />
        <XAxis type="number" tick={{ fontSize: 10, fill: '#94a3b8' }} tickLine={false} axisLine={false} tickFormatter={v => v >= 1000 ? (v/1000).toFixed(1)+'s' : v+'ms'} />
        <YAxis type="category" dataKey="name" tick={{ fontSize: 10, fill: '#374151' }} tickLine={false} axisLine={false} width={80} />
        <Tooltip
          cursor={{ fill: 'rgba(59,130,246,0.05)' }}
          contentStyle={{ background: '#1e293b', border: 'none', borderRadius: 10, fontSize: 12, color: '#f8fafc', padding: '10px 14px' }}
          labelStyle={{ color: '#94a3b8', marginBottom: 6 }}
          formatter={(v, n) => [ms(v), n]}
        />
        <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11, paddingTop: 8 }} />
        <Bar dataKey="P95" fill="#3b82f6" radius={[0, 4, 4, 0]} maxBarSize={14} />
        <Bar dataKey="Avg" fill="#93c5fd" radius={[0, 4, 4, 0]} maxBarSize={14} />
      </BarChart>
    </ResponsiveContainer>
  )
}

// ─── Error Rate Bar Chart ─────────────────────────────────────────────────────
function ErrorRateChart({ rows }) {
  if (!rows || rows.length === 0) return (
    <div style={{ height: 220, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#94a3b8', fontSize: 12 }}>No error rate data</div>
  )
  const chartData = rows.slice(0, 10).map(r => {
    const rate = Number(r.error_rate_pct || 0)
    const color = rate >= 10 ? '#ef4444' : rate >= 3 ? '#f59e0b' : '#10b981'
    return {
      name:  (r.app || r.tenant || '').slice(0, 16),
      rate,
      color,
      label: r.tenant ? `${r.app} · ${r.tenant}` : r.app,
    }
  })
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={chartData} layout="vertical" margin={{ top: 4, right: 50, left: 8, bottom: 0 }}>
        <CartesianGrid horizontal={false} stroke="#f1f5f9" />
        <XAxis type="number" tick={{ fontSize: 10, fill: '#94a3b8' }} tickLine={false} axisLine={false} tickFormatter={v => v + '%'} />
        <YAxis type="category" dataKey="name" tick={{ fontSize: 10, fill: '#374151' }} tickLine={false} axisLine={false} width={100} />
        <Tooltip
          cursor={{ fill: 'rgba(239,68,68,0.05)' }}
          contentStyle={{ background: '#1e293b', border: 'none', borderRadius: 10, fontSize: 12, color: '#f8fafc', padding: '10px 14px' }}
          labelStyle={{ color: '#94a3b8', marginBottom: 6 }}
          formatter={(v, _, props) => [`${Number(v).toFixed(2)}%`, props.payload.label || 'Error Rate']}
        />
        <Bar dataKey="rate" radius={[0, 4, 4, 0]} maxBarSize={14}>
          {chartData.map((d, i) => <Cell key={i} fill={d.color} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

// ─── Leaderboard card ─────────────────────────────────────────────────────────
function LeaderboardCard({ title, icon, iconBg, iconColor, rows, renderRight, emptyMsg, onRowClick }) {
  return (
    <div style={{ ...cardBase, padding: 18, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ width: 36, height: 36, borderRadius: 10, background: iconBg, color: iconColor,
          display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{icon}</div>
        <div style={{ fontSize: 14, fontWeight: 700, color: '#111827' }}>{title}</div>
      </div>
      {(!rows || rows.length === 0) ? (
        <div style={{ color: '#9ca3af', fontSize: 13, textAlign: 'center', padding: '22px 0' }}>
          {emptyMsg || 'No data'}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {rows.map((r, i) => (
            <div key={`${r.tenant}-${r.app}-${r.environment}-${i}`}
              onClick={() => onRowClick && onRowClick(r)}
              style={{
                display: 'flex', alignItems: 'center', gap: 12,
                padding: '10px 8px', margin: '0 -8px',
                borderBottom: i < rows.length - 1 ? '1px solid #f3f4f6' : 'none',
                cursor: onRowClick ? 'pointer' : 'default',
                borderRadius: 6, transition: 'background 0.12s',
              }}
              onMouseEnter={(e) => { if (onRowClick) e.currentTarget.style.background = '#f9fafb' }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
            >
              <div style={{
                width: 30, height: 30, borderRadius: 8,
                background: appAvatarColor(r.app),
                color: '#fff', fontWeight: 800, fontSize: 11,
                display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
              }}>{appInitials(r.app)}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: '#111827', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{r.app}</span>
                  <EnvPill env={r.environment} compact />
                </div>
                <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {r.tenant}
                </div>
              </div>
              <div style={{ textAlign: 'right', flexShrink: 0 }}>{renderRight(r)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Evidence panel ───────────────────────────────────────────────────────────
function EvidencePanel({ data }) {
  const failures = Array.isArray(data?.failure_details)    ? data.failure_details    : []
  const samples  = Array.isArray(data?.sample_logs)        ? data.sample_logs        : []
  const signals  = Array.isArray(data?.correlated_signals) ? data.correlated_signals : []
  const failedWf = Number(data?.failed_workflows) || 0
  const monoFont = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
  const fmtTime = (ts) => {
    if (!ts) return ''
    const m = String(ts).match(/T(\d{2}:\d{2}:\d{2})/)
    if (m) return m[1]
    const d = new Date(ts)
    if (!isNaN(d.getTime())) return d.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }) + ' IST'
    return String(ts).slice(0, 19)
  }
  const statusColor = (st) => {
    const n = Number(st) || 0
    if (n >= 500) return { bg: '#fee2e2', fg: '#991b1b' }
    if (n >= 400) return { bg: '#fef3c7', fg: '#92400e' }
    return { bg: '#f3f4f6', fg: '#374151' }
  }
  const sectionLabel = { fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }
  return (
    <div>
      <div style={{ marginBottom: 18 }}>
        <div style={sectionLabel}>
          <span>⚠</span> Failure Breakdown
          {failedWf > 0 && (
            <span style={{ marginLeft: 'auto', fontSize: 10.5, color: '#b45309', background: '#fef3c7', border: '1px solid #fde68a', padding: '2px 8px', borderRadius: 999 }}>
              {failedWf} failed workflow{failedWf === 1 ? '' : 's'}
            </span>
          )}
        </div>
        {failures.length === 0 ? (
          <div style={{ fontSize: 12, color: '#9ca3af' }}>No endpoint failures recorded.</div>
        ) : (
          <div style={{ border: '1px solid #f3f4f6', borderRadius: 10, overflow: 'hidden' }}>
            {failures.map((f, i) => {
              const sc = statusColor(f.status)
              return (
                <div key={i} style={{ display: 'grid', gridTemplateColumns: '24px 1fr auto', alignItems: 'center', gap: 10, padding: '10px 12px', borderBottom: i < failures.length - 1 ? '1px solid #f3f4f6' : 'none', background: i % 2 ? '#fafafa' : '#fff' }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: '#9ca3af' }}>{i + 1}.</span>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, color: '#111827', fontFamily: monoFont, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.path || '—'}</div>
                    <div style={{ fontSize: 11, color: '#6b7280', marginTop: 3, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ background: sc.bg, color: sc.fg, fontWeight: 700, padding: '1px 7px', borderRadius: 4 }}>{f.status || '—'}</span>
                      {f.cause_hint && <span>· {f.cause_hint}</span>}
                      {f.app && <span style={{ color: '#9ca3af' }}>· {f.app}</span>}
                    </div>
                  </div>
                  <div style={{ fontSize: 14, fontWeight: 800, color: '#dc2626', fontVariantNumeric: 'tabular-nums' }}>{Number(f.count || 0).toLocaleString()}</div>
                </div>
              )
            })}
          </div>
        )}
      </div>
      <div style={{ marginBottom: 18 }}>
        <div style={sectionLabel}><span>📄</span> Representative Logs</div>
        {samples.length === 0 ? (
          <div style={{ fontSize: 12, color: '#9ca3af' }}>No sample error logs available.</div>
        ) : (
          <div style={{ background: '#0f172a', borderRadius: 10, padding: '10px 14px', fontFamily: monoFont, fontSize: 11.5, color: '#e2e8f0', lineHeight: 1.7 }}>
            {samples.map((s, i) => {
              const sc = statusColor(s.status)
              return (
                <div key={i} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', padding: '3px 0', borderBottom: i < samples.length - 1 ? '1px solid #1e293b' : 'none' }}>
                  <span style={{ color: '#94a3b8' }}>[{fmtTime(s.timestamp)}]</span>
                  <span style={{ color: '#a5f3fc', fontWeight: 700 }}>{s.method || ''}</span>
                  <span style={{ color: '#e2e8f0', overflowWrap: 'anywhere' }}>{s.path || ''}</span>
                  <span style={{ background: sc.bg, color: sc.fg, fontWeight: 700, padding: '0 6px', borderRadius: 3 }}>{s.status || '—'}</span>
                  {s.cause_hint && <span style={{ color: '#fca5a5' }}>· {s.cause_hint}</span>}
                  {s.app && <span style={{ color: '#64748b' }}>· {s.app}</span>}
                </div>
              )
            })}
          </div>
        )}
      </div>
      <div style={{ marginBottom: 18 }}>
        <div style={sectionLabel}><span>🔗</span> Correlated Signals</div>
        {signals.length === 0 ? (
          <div style={{ fontSize: 12, color: '#9ca3af' }}>No correlated pod or workflow signals.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {signals.map((s, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 8, padding: '8px 12px' }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#6366f1', flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 700, color: '#111827', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: monoFont }}>{s.entity || '—'}</div>
                  {s.note && <div style={{ fontSize: 10.5, color: '#6b7280', marginTop: 2 }}>{s.note}</div>}
                </div>
                <div style={{ fontSize: 12, fontWeight: 700, color: '#dc2626', flexShrink: 0 }}>{s.detail || ''}</div>
              </div>
            ))}
          </div>
        )}
      </div>
      {data?.root_cause && (
        <div style={{ marginBottom: 18 }}>
          <div style={sectionLabel}><span>🎯</span> Root Cause (recap)</div>
          {(data.window_start || data.window_end) && (() => {
            const fmtT = (t) => {
              if (!t) return '—'
              const d = new Date(t)
              return isNaN(d.getTime()) ? String(t) : d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' }) + ' IST'
            }
            const startD = data.window_start ? new Date(data.window_start) : null
            const endD   = data.window_end   ? new Date(data.window_end)   : null
            const durMs  = (startD && endD && !isNaN(startD) && !isNaN(endD)) ? (endD - startD) : 0
            const durMin = Math.round(durMs / 60000)
            const durLabel = durMin >= 60 ? `${Math.floor(durMin/60)}h ${durMin%60}m` : `${durMin}m`
            return (
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, background: '#eef2ff', border: '1px solid #c7d2fe', color: '#3730a3', borderRadius: 8, padding: '6px 10px', marginBottom: 8, fontSize: 11.5, fontWeight: 600 }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                Analysis window: {fmtT(data.window_start)} → {fmtT(data.window_end)}
                {durMs > 0 && <span style={{ color: '#6366f1' }}>· {durLabel}</span>}
                <span style={{ color: '#6b7280', fontWeight: 500 }}>· check pod restarts in this range</span>
              </div>
            )
          })()}
          <div style={{ fontSize: 12.5, lineHeight: 1.55, color: '#111827', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '10px 12px' }}>
            {data.root_cause}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Tenant card with hover popover ───────────────────────────────────────────
function TenantCard({ t, onTenantClick, onAppClick }) {
  const [hover, setHover] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [aiLoading, setAiLoading] = useState(false)
  const [aiError,   setAiError]   = useState(null)
  const [aiData,    setAiData]    = useState(null)
  const [modalTab,  setModalTab]  = useState('summary')
  const wrapRef = useRef(null)
  const [popAlign, setPopAlign] = useState('left')
  useLayoutEffect(() => {
    if (!hover || !wrapRef.current) return
    const rect = wrapRef.current.getBoundingClientRect()
    const POPOVER_MAX = 360
    const roomRight = window.innerWidth - rect.left - 16
    setPopAlign(roomRight < POPOVER_MAX ? 'right' : 'left')
  }, [hover])

  const healthColor = t.avg_health_score >= 80 ? '#16a34a' : t.avg_health_score >= 50 ? '#d97706' : '#dc2626'

  const openInvestigate = (e) => {
    e.stopPropagation()
    setModalOpen(true); setModalTab('summary'); setAiData(null); setAiError(null); setAiLoading(true)
    let cancelled = false
    fetch(`${API}/api/insights/${encodeURIComponent(t.tenant)}/investigate`, { method: 'POST' })
      .then(r => r.ok ? r.json() : r.json().then(j => Promise.reject(j.detail || `HTTP ${r.status}`)))
      .then(json => { if (!cancelled) { setAiData(json); setAiLoading(false) } })
      .catch(err => { if (!cancelled) { setAiError(typeof err === 'string' ? err : 'Failed to investigate'); setAiLoading(false) } })
    return () => { cancelled = true }
  }
  const closeModal = (e) => { if (e) e.stopPropagation(); setModalOpen(false) }
  const score = Number(aiData?.confidence_score) || 0
  const scoreColor = score >= 80 ? { bg: '#ecfdf5', fg: '#047857', border: '#a7f3d0' } : score >= 50 ? { bg: '#fffbeb', fg: '#b45309', border: '#fde68a' } : { bg: '#fef2f2', fg: '#b91c1c', border: '#fecaca' }

  return (
    <div ref={wrapRef} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ position: 'relative', zIndex: hover ? 50 : 1 }}>
      <div
        onClick={() => onTenantClick && onTenantClick(t)}
        style={{
          background: '#fff',
          border: `1.5px solid ${hover ? '#6366f1' : '#e2e8f0'}`,
          borderRadius: 12,
          overflow: 'hidden',
          display: 'flex',
          boxShadow: hover ? '0 4px 14px rgba(99,102,241,0.12)' : '0 1px 4px rgba(0,0,0,0.06)',
          transition: 'border-color 0.15s, box-shadow 0.15s',
          cursor: onTenantClick ? 'pointer' : 'default',
        }}>
        <div style={{ width: 4, background: healthColor, flexShrink: 0 }} />
        <div style={{ flex: 1, padding: 13 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#0f172a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.tenant}</div>
              <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 1, fontWeight: 500 }}>{t.app_count} app{t.app_count === 1 ? '' : 's'}</div>
            </div>
            <button type="button" onClick={openInvestigate} title="Investigate"
              style={{ width: 24, height: 24, borderRadius: 6, border: '1px solid #e5e7eb', background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0, opacity: hover ? 1 : 0, pointerEvents: hover ? 'auto' : 'none', transition: 'opacity 0.12s' }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#6366f1" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
              </svg>
            </button>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
            <div>
              <div style={{ fontSize: 17, fontWeight: 800, color: '#0f172a', letterSpacing: '-0.03em' }}>{fmt(t.total_requests)}</div>
              <div style={{ fontSize: 10, color: '#94a3b8', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.04em', marginTop: 1 }}>Requests</div>
            </div>
            <div style={{ textAlign: 'center' }}>
              {t.workflow_total > 0 ? (
                <div style={{ fontSize: 13, fontWeight: 700, color: t.workflow_failed > 0 ? '#dc2626' : '#16a34a' }}>
                  {fmt(t.workflow_failed || 0)}<span style={{ color: '#9ca3af', fontWeight: 500 }}> / {fmt(t.workflow_total)}</span>
                </div>
              ) : <div style={{ fontSize: 13, fontWeight: 700, color: '#94a3b8' }}>—</div>}
              <div style={{ fontSize: 10, color: '#94a3b8', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.04em', marginTop: 1 }}>Wf failed</div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: t.error_rate_pct > 5 ? '#dc2626' : t.error_rate_pct > 1 ? '#d97706' : '#16a34a' }}>
                {pct(t.error_rate_pct)}
              </div>
              <div style={{ fontSize: 10, color: '#94a3b8', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.04em', marginTop: 1 }}>Error rate</div>
            </div>
          </div>
        </div>
      </div>

      {hover && t.top_apps && t.top_apps.length > 0 && (
        <div style={{ position: 'absolute', top: '100%', zIndex: 100, ...(popAlign === 'right' ? { right: 0 } : { left: 0 }), paddingTop: 8, minWidth: 300, width: 'max-content', maxWidth: 360 }}>
          <div style={{ background: '#fff', color: '#111827', border: '1px solid #e5e7eb', borderRadius: 10, padding: '12px 14px', boxShadow: '0 16px 40px rgba(17,24,39,0.12), 0 2px 6px rgba(17,24,39,0.06)' }}>
            <div style={{ fontSize: 10.5, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10, paddingBottom: 8, borderBottom: '1px solid #f3f4f6' }}>Top contributing apps</div>
            {t.top_apps.map((a, i) => (
              <div key={i}
                onClick={(e) => { e.stopPropagation(); onAppClick && onAppClick(t, a) }}
                style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 8px', margin: '0 -8px', borderBottom: i < t.top_apps.length - 1 ? '1px solid #f9fafb' : 'none', cursor: onAppClick ? 'pointer' : 'default', borderRadius: 6, transition: 'background 0.12s' }}
                onMouseEnter={(e) => { if (onAppClick) e.currentTarget.style.background = '#f3f4f6' }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
              >
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: envMeta(a.env_key).dot, flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600, color: '#111827', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.app}</div>
                  <div style={{ fontSize: 10.5, color: '#9ca3af', marginTop: 1, fontWeight: 500 }}>{envMeta(a.env_key).label}</div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3, flexShrink: 0 }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: '#dc2626', background: '#fef2f2', border: '1px solid #fecaca', padding: '2px 8px', borderRadius: 6, fontVariantNumeric: 'tabular-nums' }}>{pct(a.error_rate_pct)}</span>
                  {(a.workflow_total || 0) > 0 && (
                    <span style={{ fontSize: 10.5, fontWeight: 600, color: '#9ca3af', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                      <span style={{ color: (a.workflow_failed || 0) > 0 ? '#dc2626' : '#16a34a', fontWeight: 700 }}>{fmt(a.workflow_failed || 0)}</span>
                      {' / '}{fmt(a.workflow_total)}{' WF FAILED'}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {modalOpen && createPortal(
        <div onClick={closeModal} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)', zIndex: 10000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: '#fff', borderRadius: 14, width: '100%', maxWidth: 720, maxHeight: '88vh', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 50px rgba(0,0,0,0.25)' }}>
            <div style={{ padding: '16px 20px', borderBottom: '1px solid #e5e7eb', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 11, color: '#6b7280', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Critical Incident · {t.tenant}</div>
                <div style={{ fontSize: 16, fontWeight: 700, color: '#111827', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {aiData?.worst_app?.app ? <>{aiData.worst_app.app} <span style={{ color: '#6b7280', fontWeight: 500 }}>({aiData.worst_app.environment || '—'})</span></> : 'Tenant investigation'}
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {aiData && !aiData.error && (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: scoreColor.bg, color: scoreColor.fg, border: `1px solid ${scoreColor.border}`, padding: '3px 10px', borderRadius: 999, fontSize: 11, fontWeight: 700 }}>
                    Confidence {score}%
                  </span>
                )}
                <button type="button" onClick={closeModal} style={{ width: 32, height: 32, borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff', cursor: 'pointer', fontSize: 16, color: '#6b7280' }}>×</button>
              </div>
            </div>
            {aiData && !aiError && (
              <div style={{ display: 'flex', gap: 4, padding: '0 20px', borderBottom: '1px solid #e5e7eb' }}>
                {[{ id: 'summary', label: 'Summary' }, { id: 'evidence', label: 'Evidence' }].map(tab => (
                  <button key={tab.id} type="button" onClick={() => setModalTab(tab.id)}
                    style={{ padding: '10px 14px', fontSize: 12.5, fontWeight: 600, color: modalTab === tab.id ? '#10B981' : '#6b7280', background: 'transparent', border: 'none', borderBottom: modalTab === tab.id ? '2px solid #10B981' : '2px solid transparent', cursor: 'pointer', marginBottom: -1 }}>
                    {tab.label}
                  </button>
                ))}
              </div>
            )}
            <div style={{ padding: 20, overflowY: 'auto', flex: 1 }}>
              {aiLoading && (
                <div style={{ textAlign: 'center', padding: 40, color: '#6b7280', fontSize: 13 }}>
                  <div style={{ width: 28, height: 28, border: '3px solid #e5e7eb', borderTopColor: '#6366f1', borderRadius: '50%', margin: '0 auto 12px', animation: 'tcSpin 0.8s linear infinite' }} />
                  Analyzing tenant…
                  <style>{`@keyframes tcSpin { to { transform: rotate(360deg); } }`}</style>
                </div>
              )}
              {aiError && <div style={{ background: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca', borderRadius: 8, padding: 12, fontSize: 12 }}>{aiError}</div>}
              {aiData && aiData.error && <div style={{ background: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca', borderRadius: 8, padding: 12, fontSize: 12, marginBottom: 14 }}>AI: {aiData.error}</div>}
              {aiData && !aiError && modalTab === 'summary' && (
                <>
                  {[
                    { label: 'ERROR SUMMARY',  type: 'p',  value: aiData.error_summary },
                    { label: 'ROOT CAUSE',     type: 'p',  value: aiData.root_cause },
                    { label: 'EVIDENCE',       type: 'ul', value: aiData.evidence },
                    { label: 'IMPACT',         type: 'p',  value: aiData.impact },
                    { label: 'WHAT TO CHECK',  type: 'ol', value: aiData.what_to_check },
                    { label: 'SUGGESTED FIX',  type: 'p',  value: aiData.suggested_fix, accent: true },
                  ].map((s, i) => {
                    const empty = s.type === 'p' ? !s.value : !(Array.isArray(s.value) && s.value.length)
                    return (
                      <div key={i} style={{ marginBottom: 14 }}>
                        <div style={{ fontSize: 10.5, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>{s.label}</div>
                        {empty ? <div style={{ fontSize: 12, color: '#9ca3af' }}>—</div>
                          : s.type === 'p' ? <div style={{ fontSize: 12.5, lineHeight: 1.55, color: '#111827', background: s.accent ? '#f0fdf4' : 'transparent', border: s.accent ? '1px solid #bbf7d0' : 'none', borderRadius: s.accent ? 8 : 0, padding: s.accent ? '10px 12px' : 0 }}>{s.value}</div>
                          : <ol style={{ margin: 0, paddingLeft: s.type === 'ol' ? 20 : 18, fontSize: 12.5, lineHeight: 1.6, color: '#374151', listStyleType: s.type === 'ol' ? 'decimal' : 'disc' }}>{s.value.map((it, idx) => <li key={idx} style={{ marginBottom: 4 }}>{it}</li>)}</ol>
                        }
                      </div>
                    )
                  })}
                </>
              )}
              {aiData && !aiError && modalTab === 'evidence' && <EvidencePanel data={aiData} />}
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}

// ─── Last-updated pill ────────────────────────────────────────────────────────
function LastUpdated({ ts }) {
  if (!ts) return null
  const d = new Date(ts)
  if (isNaN(d.getTime())) return null
  const diffSec = Math.max(0, Math.round((Date.now() - d.getTime()) / 1000))
  const rel = diffSec < 60 ? `${diffSec}s ago` : diffSec < 3600 ? `${Math.round(diffSec/60)}m ago` : diffSec < 86400 ? `${Math.round(diffSec/3600)}h ago` : `${Math.round(diffSec/86400)}d ago`
  const abs = d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' }) + ' IST'
  return (
    <div title={`Latest analyzer run: ${abs}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 20, padding: '4px 12px', fontSize: 11.5, color: '#15803d', fontWeight: 600 }}>
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#16a34a' }} />
      Updated {rel}
    </div>
  )
}

// ─── Section header ───────────────────────────────────────────────────────────
function SectionHead({ icon, title, badge }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
      <span style={{ fontSize: 14 }}>{icon}</span>
      <span style={{ fontSize: 13, fontWeight: 700, color: '#374151' }}>{title}</span>
      {badge != null && (
        <span style={{ background: '#e2e8f0', color: '#64748b', borderRadius: 10, padding: '1px 8px', fontSize: 11, fontWeight: 600 }}>{badge}</span>
      )}
    </div>
  )
}

// ─── Dashboard ────────────────────────────────────────────────────────────────
// ─── API Monitor Section ─────────────────────────────────────────────────────

function fmtMs(ms) {
  if (ms == null) return '—'
  if (ms >= 1000) return (ms / 1000).toFixed(2) + ' s'
  return Math.round(ms) + ' ms'
}

function fmtRanAt(iso) {
  try {
    return new Date(iso).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false })
  } catch { return iso }
}

function ApiMonitorSection({ dateRange }) {
  const [tenants,        setTenants]        = useState([])
  const [selTenant,      setSelTenant]      = useState('')
  const [collections,    setCollections]    = useState([])
  const [selCol,         setSelCol]         = useState('')
  const [stats,          setStats]          = useState(null)
  const [statsLoading,   setStatsLoading]   = useState(false)
  const [insight,        setInsight]        = useState(null)
  const [insightLoading, setInsightLoading] = useState(false)
  const [apiView,        setApiView]        = useState('lines')
  const [selectedApi,    setSelectedApi]    = useState(null)

  useEffect(() => {
    fetch(`${API}/api/api-monitor/tenants-with-collections`)
      .then(r => r.ok ? r.json() : null)
      .then(j => j && setTenants(j.tenants || []))
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (!selTenant) { setCollections([]); setSelCol(''); setStats(null); return }
    fetch(`${API}/api/api-monitor/${encodeURIComponent(selTenant)}/collections`)
      .then(r => r.ok ? r.json() : null)
      .then(j => { setCollections(j?.collections || []); setSelCol(''); setStats(null) })
      .catch(() => {})
  }, [selTenant])

  useEffect(() => {
    if (!selTenant || !selCol) { setStats(null); setInsight(null); return }
    setStatsLoading(true)
    const qs = new URLSearchParams()
    if (dateRange?.start) qs.set('start', dateRange.start.toISOString())
    if (dateRange?.end)   qs.set('end',   dateRange.end.toISOString())
    fetch(`${API}/api/api-monitor/${encodeURIComponent(selTenant)}/collections/${selCol}/stats?${qs}`)
      .then(r => r.ok ? r.json() : null)
      .then(j => { setStats(j || null); setInsight(null); setSelectedApi(null) })
      .catch(() => {})
      .finally(() => setStatsLoading(false))
  }, [selTenant, selCol, dateRange?.start?.getTime(), dateRange?.end?.getTime()])

  const fetchInsight = () => {
    if (!selTenant || !selCol || insightLoading) return
    setInsightLoading(true); setInsight(null)
    fetch(`${API}/api/api-monitor/${encodeURIComponent(selTenant)}/collections/${selCol}/insights`, { method: 'POST' })
      .then(r => r.ok ? r.json() : null)
      .then(j => setInsight(j?.insight || 'No insight available.'))
      .catch(() => setInsight('Failed to generate insight.'))
      .finally(() => setInsightLoading(false))
  }

  const trendData = (stats?.trend || []).map(r => ({
    ...r,
    label:    fmtRanAt(r.ran_at),
    dur_s:    r.duration_ms ? +(r.duration_ms / 1000).toFixed(2) : 0,
  }))
  const apiStats = stats?.api_stats || []

  const summaryLine = (() => {
    if (!stats || !trendData.length) return null
    const lastRun   = trendData[trendData.length - 1]
    const passRate  = lastRun.pass_rate
    const slowest   = apiStats[0]
    const failApis  = apiStats.filter(a => a.uptime_pct < 100)
    const parts     = [`${lastRun.passed}/${lastRun.total} passed (${passRate}%)`]
    if (slowest) parts.push(`Slowest: ${slowest.name} ${fmtMs(slowest.avg_duration)}`)
    if (failApis.length) parts.push(`${failApis.length} endpoint${failApis.length > 1 ? 's' : ''} with failures`)
    return parts.join('  •  ')
  })()

  const uptimeColor = (pct) => pct >= 95 ? '#16a34a' : pct >= 80 ? '#d97706' : '#dc2626'
  const avgColor    = (ms)  => ms <= 500  ? '#16a34a' : ms <= 2000 ? '#d97706' : '#dc2626'

  const dropdownStyle = {
    padding: '8px 12px', fontSize: 13, borderRadius: 8, border: '1px solid #e2e8f0',
    background: '#fff', color: '#0f172a', cursor: 'pointer', minWidth: 200,
    outline: 'none',
  }

  return (
    <div style={{ marginBottom: 18, background: '#fff', borderRadius: 14, border: '1px solid #e2e8f0', boxShadow: '0 1px 4px rgba(0,0,0,0.06)', overflow: 'hidden' }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      {/* Header */}
      <div style={{ padding: '16px 20px', borderBottom: '1px solid #f1f5f9', display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ width: 32, height: 32, borderRadius: 8, background: 'linear-gradient(135deg,#0ea5e9,#0284c7)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', flexShrink: 0 }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 12h-4l-3 9L9 3l-3 9H2"/>
          </svg>
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: '#0f172a' }}>API Monitor</div>
          <div style={{ fontSize: 11, color: '#94a3b8' }}>Trend charts &amp; response time analysis per collection</div>
        </div>
      </div>

      {/* Controls */}
      <div style={{ padding: '14px 20px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', borderBottom: '1px solid #f1f5f9' }}>
        <select value={selTenant} onChange={e => setSelTenant(e.target.value)} style={dropdownStyle} disabled={tenants.length === 0}>
          <option value="">Select a tenant…</option>
          {tenants.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        {selTenant && (
          <select value={selCol} onChange={e => setSelCol(e.target.value)} style={dropdownStyle} disabled={collections.length === 0}>
            <option value="">Select a collection…</option>
            {collections.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        )}
        {summaryLine && (
          <div style={{ fontSize: 12, color: '#64748b', flex: 1, minWidth: 0 }}>{summaryLine}</div>
        )}
        {selCol && !statsLoading && (
          <button onClick={fetchInsight} disabled={insightLoading} style={{ padding: '7px 14px', fontSize: 12, fontWeight: 600, border: '1px solid #bae6fd', borderRadius: 7, background: insightLoading ? '#f0f9ff' : '#e0f2fe', color: '#0369a1', cursor: insightLoading ? 'default' : 'pointer', display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
            {insightLoading
              ? <><span style={{ display: 'inline-block', width: 12, height: 12, border: '2px solid #0369a1', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />Analysing…</>
              : <>✦ AI Insights</>}
          </button>
        )}
      </div>

      {/* AI Insight box */}
      {insight && (
        <div style={{ margin: '12px 20px 0', padding: '12px 16px', background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: 8, fontSize: 13, color: '#0c4a6e', lineHeight: 1.6 }}>
          <span style={{ fontWeight: 700, marginRight: 6 }}>✦</span>{insight}
        </div>
      )}

      {/* Loading */}
      {statsLoading && (
        <div style={{ padding: '40px 20px', textAlign: 'center', color: '#94a3b8', fontSize: 13 }}>Loading stats…</div>
      )}

      {/* Empty state */}
      {!statsLoading && selCol && !stats?.trend?.length && (
        <div style={{ padding: '40px 20px', textAlign: 'center', color: '#94a3b8', fontSize: 13 }}>No cron run history yet for this collection.</div>
      )}

      {/* No collection selected */}
      {!selCol && !statsLoading && (
        <div style={{ padding: '40px 20px', textAlign: 'center', color: '#cbd5e1', fontSize: 13 }}>Select a tenant and collection to view monitoring data.</div>
      )}

      {/* Charts */}
      {!statsLoading && trendData.length > 0 && (
        <div style={{ padding: '20px 20px 0' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginBottom: 24 }}>
            {/* Pass Rate Trend */}
            <div>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#475569', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Pass Rate Trend</div>
              <ResponsiveContainer width="100%" height={160}>
                <ComposedChart data={trendData} margin={{ top: 4, right: 8, bottom: 0, left: -16 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="label" tick={{ fontSize: 10, fill: '#94a3b8' }} />
                  <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: '#94a3b8' }} unit="%" />
                  <Tooltip formatter={(v) => [`${v}%`, 'Pass Rate']} contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e2e8f0' }} />
                  <Line type="monotone" dataKey="pass_rate" stroke="#16a34a" strokeWidth={2} dot={{ r: 3, fill: '#16a34a' }} activeDot={{ r: 5 }} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
            {/* Duration Trend */}
            <div>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#475569', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Suite Duration Trend</div>
              <ResponsiveContainer width="100%" height={160}>
                <ComposedChart data={trendData} margin={{ top: 4, right: 8, bottom: 0, left: -16 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="label" tick={{ fontSize: 10, fill: '#94a3b8' }} />
                  <YAxis tick={{ fontSize: 10, fill: '#94a3b8' }} unit="s" />
                  <Tooltip formatter={(v) => [`${v}s`, 'Duration']} contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e2e8f0' }} />
                  <Line type="monotone" dataKey="dur_s" stroke="#7c3aed" strokeWidth={2} dot={{ r: 3, fill: '#7c3aed' }} activeDot={{ r: 5 }} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* API Response Times — Lines / Table toggle */}
          {apiStats.length > 0 && (() => {
            const LINE_COLORS = [
              '#2563eb','#dc2626','#16a34a','#d97706','#7c3aed',
              '#0891b2','#db2777','#65a30d','#ea580c','#0284c7',
              '#9333ea','#b45309','#0f766e','#be123c','#4338ca',
            ]
            const apiNames   = apiStats.map(a => a.name)
            const perRunData = (stats?.per_run_api || []).map(r => ({
              ...r,
              label: fmtRanAt(r.ran_at),
            }))

            return (
              <div style={{ marginBottom: 24 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.05em' }}>API Response Times</div>
                  <div style={{ display: 'inline-flex', gap: 2, padding: 3, background: '#f1f5f9', border: '1px solid #e2e8f0', borderRadius: 7 }}>
                    {[['lines', '📈 Lines'], ['table', '☰ Table']].map(([v, label]) => (
                      <button key={v} type="button" onClick={() => setApiView(v)} style={{ padding: '4px 12px', fontSize: 11.5, fontWeight: 600, border: 'none', borderRadius: 5, cursor: 'pointer', background: apiView === v ? '#fff' : 'transparent', color: apiView === v ? '#1e40af' : '#64748b', boxShadow: apiView === v ? '0 1px 3px rgba(0,0,0,0.1)' : 'none', transition: 'all 0.15s' }}>
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                {apiView === 'lines' && (
                  perRunData.length < 2
                    ? <div style={{ padding: '30px 0', textAlign: 'center', color: '#94a3b8', fontSize: 13 }}>Need at least 2 runs to show a trend line.</div>
                    : (() => {
                        const handleApiClick = (name) => setSelectedApi(prev => prev === name ? null : name)
                        return (
                          <ResponsiveContainer width="100%" height={340}>
                            <ComposedChart data={perRunData} margin={{ top: 4, right: 16, bottom: 0, left: -8 }}>
                              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                              <XAxis dataKey="label" tick={{ fontSize: 10, fill: '#94a3b8' }} />
                              <YAxis tick={{ fontSize: 10, fill: '#94a3b8' }} tickFormatter={v => v >= 1 ? `${v}s` : `${(v * 1000).toFixed(0)}ms`} />
                              <Tooltip
                                content={({ active, payload, label: lbl }) => {
                                  if (!active || !payload?.length) return null
                                  const visible = payload.filter(p => selectedApi === null || p.dataKey === selectedApi)
                                  const sorted  = [...visible].sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
                                  return (
                                    <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, padding: '10px 14px', fontSize: 11.5, boxShadow: '0 4px 16px rgba(0,0,0,0.12)', maxWidth: 260, maxHeight: 320, overflowY: 'auto' }}>
                                      <div style={{ fontWeight: 700, color: '#475569', marginBottom: 7 }}>{lbl}</div>
                                      {sorted.map(p => (
                                        <div key={p.dataKey} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 3, alignItems: 'center' }}>
                                          <span style={{ display: 'flex', alignItems: 'center', gap: 5, color: '#374151', minWidth: 0 }}>
                                            <span style={{ width: 8, height: 8, borderRadius: '50%', background: p.color, flexShrink: 0 }} />
                                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 150 }}>{p.dataKey}</span>
                                          </span>
                                          <span style={{ fontWeight: 700, color: p.color, flexShrink: 0 }}>
                                            {p.value >= 1 ? `${p.value.toFixed(2)}s` : `${(p.value * 1000).toFixed(0)}ms`}
                                          </span>
                                        </div>
                                      ))}
                                    </div>
                                  )
                                }}
                              />
                              <Legend
                                wrapperStyle={{ fontSize: 11, paddingTop: 8, cursor: 'pointer' }}
                                onClick={(e) => handleApiClick(e.dataKey)}
                                formatter={(value, entry) => {
                                  const dimmed = selectedApi !== null && selectedApi !== value
                                  const label  = value.length > 28 ? value.slice(0, 26) + '…' : value
                                  return (
                                    <span style={{ color: dimmed ? '#d1d5db' : entry.color, fontWeight: selectedApi === value ? 700 : 400, transition: 'all 0.15s' }}>
                                      {label}
                                    </span>
                                  )
                                }}
                              />
                              {apiNames.map((name, i) => {
                                const color   = LINE_COLORS[i % LINE_COLORS.length]
                                const isSelected = selectedApi === name
                                const dimmed     = selectedApi !== null && !isSelected
                                return (
                                  <Line
                                    key={name}
                                    type="monotone"
                                    dataKey={name}
                                    stroke={color}
                                    strokeWidth={isSelected ? 3 : 1.8}
                                    strokeOpacity={dimmed ? 0.08 : 1}
                                    dot={false}
                                    activeDot={{ r: isSelected || selectedApi === null ? 5 : 0, onClick: () => handleApiClick(name), style: { cursor: 'pointer' } }}
                                    onClick={() => handleApiClick(name)}
                                    style={{ cursor: 'pointer' }}
                                    connectNulls
                                  />
                                )
                              })}
                            </ComposedChart>
                          </ResponsiveContainer>
                        )
                      })()
                )}

                {apiView === 'table' && (
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                      <thead>
                        <tr style={{ background: '#f8fafc' }}>
                          {['API Name', 'Avg', 'P95', 'Min', 'Max', 'Uptime'].map(h => (
                            <th key={h} style={{ padding: '8px 12px', textAlign: h === 'API Name' ? 'left' : 'right', fontWeight: 600, color: '#64748b', borderBottom: '1px solid #e2e8f0', whiteSpace: 'nowrap' }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {apiStats.map((a, i) => (
                          <tr key={i} style={{ borderBottom: '1px solid #f1f5f9', background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                            <td style={{ padding: '8px 12px', color: '#0f172a', fontWeight: 500, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</td>
                            <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 700, color: avgColor(a.avg_duration) }}>{fmtMs(a.avg_duration)}</td>
                            <td style={{ padding: '8px 12px', textAlign: 'right', color: '#475569' }}>{fmtMs(a.p95_duration)}</td>
                            <td style={{ padding: '8px 12px', textAlign: 'right', color: '#475569' }}>{fmtMs(a.min_duration)}</td>
                            <td style={{ padding: '8px 12px', textAlign: 'right', color: '#475569' }}>{fmtMs(a.max_duration)}</td>
                            <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 700, color: uptimeColor(a.uptime_pct) }}>{a.uptime_pct}%</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )
          })()}
        </div>
      )}
    </div>
  )
}

// ─── GraphCredentialModal ─────────────────────────────────────────────────────
function GraphCredentialModal({ onClose }) {
  const [tenantId,     setTenantId]     = useState('')
  const [clientId,     setClientId]     = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [testing,      setTesting]      = useState(false)
  const [result,       setResult]       = useState(null)

  const canTest = tenantId.trim() && clientId.trim() && clientSecret.trim() && !testing

  async function handleTest() {
    setTesting(true)
    setResult(null)
    try {
      const res  = await fetch(`${API}/api/support/test-graph-credentials`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenant_id: tenantId.trim(), client_id: clientId.trim(), client_secret: clientSecret.trim() }),
      })
      const data = await res.json()
      setResult(data)
    } catch (e) {
      setResult({ ok: false, error: e.message })
    } finally {
      setTesting(false)
    }
  }

  const inputStyle = {
    width: '100%', padding: '8px 10px', fontSize: 13, borderRadius: 7,
    border: '1px solid #e2e8f0', outline: 'none', boxSizing: 'border-box',
    fontFamily: 'inherit', color: '#0f172a', background: '#fff',
  }
  const labelStyle = { fontSize: 12, fontWeight: 600, color: '#475569', marginBottom: 4, display: 'block' }

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
         onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div style={{ background: '#fff', borderRadius: 14, padding: 28, width: 440, maxWidth: '95vw', boxShadow: '0 20px 60px rgba(0,0,0,0.18)' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 15, color: '#0f172a' }}>Test Graph Credentials</div>
            <div style={{ fontSize: 11.5, color: '#94a3b8', marginTop: 2 }}>Verify Microsoft O365 credentials via client_credentials flow</div>
          </div>
          <button type="button" onClick={onClose}
            style={{ width: 30, height: 30, borderRadius: 8, border: '1px solid #e5e7eb', background: '#f8fafc', cursor: 'pointer', fontSize: 16, color: '#6b7280', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            ×
          </button>
        </div>

        {/* Fields */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={labelStyle}>O365 Tenant ID</label>
            <input style={inputStyle} value={tenantId} onChange={e => setTenantId(e.target.value)}
              placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" autoComplete="off" />
          </div>
          <div>
            <label style={labelStyle}>Client ID</label>
            <input style={inputStyle} value={clientId} onChange={e => setClientId(e.target.value)}
              placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" autoComplete="off" />
          </div>
          <div>
            <label style={labelStyle}>Client Secret</label>
            <input style={inputStyle} type="password" value={clientSecret} onChange={e => setClientSecret(e.target.value)}
              placeholder="••••••••••••••••" autoComplete="new-password" />
          </div>
        </div>

        {/* Test button */}
        <div style={{ marginTop: 20, display: 'flex', justifyContent: 'flex-end' }}>
          <button type="button" onClick={handleTest} disabled={!canTest}
            style={{ padding: '9px 20px', fontSize: 13, fontWeight: 600, borderRadius: 8, border: 'none', cursor: canTest ? 'pointer' : 'not-allowed',
                     background: canTest ? 'linear-gradient(135deg,#6366f1,#4f46e5)' : '#e2e8f0', color: canTest ? '#fff' : '#94a3b8' }}>
            {testing ? 'Testing…' : 'Test Credentials'}
          </button>
        </div>

        {/* Result banner */}
        {result && (
          <div style={{ marginTop: 14, padding: '10px 14px', borderRadius: 8, fontSize: 12.5, lineHeight: 1.5,
                        background: result.ok ? '#f0fdf4' : '#fef2f2',
                        border: `1px solid ${result.ok ? '#bbf7d0' : '#fecaca'}`,
                        color: result.ok ? '#166534' : '#991b1b' }}>
            {result.ok ? `✓ ${result.message}` : `✗ ${result.error}`}
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}

function Dashboard({ onNavigate }) {
  const goToTenant   = (tenant, app = null, env = null) => onNavigate?.('tenant-apps', { tenant, app, env })
  const goToInsights = (r, section) => onNavigate?.('tenant-apps', { tenant: r.tenant, app: r.app, env: r.env_key, section })

  const [envFilter, setEnvFilter] = useState('prod')
  const [dateRange, setDateRange] = useState({ start: istMidnightUtc(new Date()), end: new Date(), label: 'Today' })
  const [data,    setData]    = useState(null)
  const [loading, setLoading] = useState(true)
  const [err,     setErr]     = useState(null)
  const [tsData,    setTsData]    = useState(null)
  const [tsLoading, setTsLoading] = useState(false)
  const [hovKpi,   setHovKpi]   = useState(null)
  const [envHov,   setEnvHov]   = useState(false)
  const [donutHov, setDonutHov] = useState(false)
  const [investigateModal, setInvestigateModal] = useState(null)
  const [graphModal,       setGraphModal]       = useState(false)

  const openInvestigateForLifecycle = (failure) => {
    setInvestigateModal({ workflowId: failure.workflow_id, runId: failure.run_id, kind: failure.kind_label || failure.kind, appName: failure.app_display_name || failure.app_name, tenantName: failure.tenant_name, env: failure.environment, loading: true, data: null, error: null })
    const qs = new URLSearchParams({ workflow_id: failure.workflow_id, namespace: 'default' }).toString()
    fetch(`${API}/api/temporal/investigate?${qs}`)
      .then(r => r.ok ? r.json() : r.json().then(j => Promise.reject(j.detail || `HTTP ${r.status}`)))
      .then(json => setInvestigateModal(s => s ? { ...s, loading: false, data: json } : null))
      .catch(e => setInvestigateModal(s => s ? { ...s, loading: false, error: typeof e === 'string' ? e : 'Failed to investigate' } : null))
  }

  useEffect(() => {
    let cancelled = false
    setLoading(true); setErr(null)
    const qs = new URLSearchParams()
    if (envFilter && envFilter !== 'all') qs.set('env', envFilter)
    if (dateRange?.start) qs.set('start', dateRange.start.toISOString())
    if (dateRange?.end)   qs.set('end',   dateRange.end.toISOString())
    qs.set('limit', '10')
    // For large-file workflows, cap at "Today" when a multi-day preset is chosen
    if (dateRange?.label === 'Last 7 days' || dateRange?.label === 'Last 30 days') {
      qs.set('lw_start', istMidnightUtc(new Date()).toISOString())
      qs.set('lw_end',   new Date().toISOString())
    }
    fetch(`${API}/api/dashboard/leaderboards?${qs}`)
      .then(r => r.ok ? r.json() : r.json().then(j => Promise.reject(j.detail || `HTTP ${r.status}`)))
      .then(json => { if (!cancelled) { setData(json); setLoading(false) } })
      .catch(e => { if (!cancelled) { setErr(typeof e === 'string' ? e : 'Failed to load'); setLoading(false) } })
    return () => { cancelled = true }
  }, [envFilter, dateRange?.start?.getTime(), dateRange?.end?.getTime()])

  useEffect(() => {
    let cancelled = false
    setTsLoading(true)
    const qs = new URLSearchParams()
    if (envFilter && envFilter !== 'all') qs.set('env', envFilter)
    const hoursBack = Math.max(1, Math.min(720, Math.round((dateRange.end.getTime() - dateRange.start.getTime()) / 3600000)))
    qs.set('hours', String(hoursBack))
    fetch(`${API}/api/dashboard/fleet-timeseries?${qs}`)
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then(json => { if (!cancelled) { setTsData(json); setTsLoading(false) } })
      .catch(() => { if (!cancelled) setTsLoading(false) })
    return () => { cancelled = true }
  }, [envFilter, dateRange?.start?.getTime(), dateRange?.end?.getTime()])

  const envTabs = [
    { key: 'all',   label: 'All' },
    { key: 'prod',  label: 'PROD' },
    { key: 'uat',   label: 'UAT' },
    { key: 'qa',    label: 'QA' },
    { key: 'dev',   label: 'Dev' },
    { key: 'demo',  label: 'Demo' },
  ]

  const totals    = data?.global_totals || {}
  const envTotals = useMemo(() => data?.by_env_totals || [], [data])
  const hoursBack = Math.max(1, Math.round((dateRange.end.getTime() - dateRange.start.getTime()) / 3600000))

  const fmtRel = (iso) => {
    if (!iso) return '—'
    const t = new Date(iso).getTime()
    if (isNaN(t)) return '—'
    const mins = Math.max(0, Math.round((Date.now() - t) / 60000))
    if (mins < 60) return `${mins} min ago`
    const hrs = Math.round(mins / 60)
    if (hrs < 48) return `${hrs} hr ago`
    return `${Math.round(hrs / 24)} d ago`
  }
  const fmtDuration = (row) => {
    if (!row.start_time || !row.close_time) return '—'
    const msDiff = new Date(row.close_time).getTime() - new Date(row.start_time).getTime()
    if (!isFinite(msDiff) || msDiff < 0) return '—'
    if (msDiff < 60_000) return (msDiff / 1000).toFixed(1) + ' s'
    const m = Math.floor(msDiff / 60_000), s = Math.floor((msDiff % 60_000) / 1000)
    return `${m}m ${s}s`
  }
  const statusLabel = (s) => s ? String(s).replace(/^.*_/, '') : '—'
  const fmtSize = (b) => {
    if (b == null) return '—'
    if (b >= 1024 * 1024 * 1024) return (b / 1024 / 1024 / 1024).toFixed(2) + ' GB'
    return (b / 1024 / 1024).toFixed(1) + ' MB'
  }

  return (
    <div style={{ background: '#f1f5f9', minHeight: '100vh', fontFamily: "'Inter', -apple-system, system-ui, sans-serif", overflowY: 'auto', position: 'relative' }}>

      {/* Skyline watermark — fixed to viewport bottom, behind all content */}
      <div aria-hidden style={{
        position: 'fixed', bottom: 0, left: 0, right: 0,
        height: 180,
        backgroundImage: 'url(/skyline.png)',
        backgroundRepeat: 'no-repeat',
        backgroundPosition: 'bottom center',
        backgroundSize: '100% 180px',
        opacity: 0.1,
        pointerEvents: 'none',
        zIndex: 0,
      }} />

      {/* ── Sticky header ── */}
      <div style={{ background: '#fff', borderBottom: '1px solid #e2e8f0', position: 'sticky', top: 0, zIndex: 20, overflow: 'hidden' }}>
        {/* Skyline watermark — left half */}
        <div aria-hidden style={{
          position: 'absolute', top: 0, bottom: -50, left: 0, right: '50%',
          backgroundImage: 'url(/skyline.png)',
          backgroundRepeat: 'no-repeat',
          backgroundPosition: 'right bottom',
          backgroundSize: 'auto 200%',
          opacity: 0.45,
          pointerEvents: 'none',
          zIndex: 0,
        }} />
        {/* Skyline watermark — right half (mirrored) */}
        <div aria-hidden style={{
          position: 'absolute', top: 0, bottom: -50, left: '50%', right: 0,
          backgroundImage: 'url(/skyline.png)',
          backgroundRepeat: 'no-repeat',
          backgroundPosition: 'left bottom',
          backgroundSize: 'auto 200%',
          opacity: 0.45,
          pointerEvents: 'none',
          zIndex: 0,
          transform: 'scaleX(-1)',
        }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 24px 0', position: 'relative', zIndex: 1 }}>
          <div style={{ width: 38, height: 38, borderRadius: 10, background: 'linear-gradient(135deg,#6366f1,#4f46e5)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', flexShrink: 0 }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>
            </svg>
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 800, fontSize: 16, color: '#0f172a', letterSpacing: '-0.3px' }}>Monitoring Dashboard</div>
            <div style={{ fontSize: 11.5, color: '#94a3b8', marginTop: 1 }}>Cross-tenant fleet health · leaderboards · pod-level attribution</div>
          </div>
          <LastUpdated ts={data?.last_analyzed_at} />
          <button type="button" onClick={() => setGraphModal(true)}
            style={{ padding: '6px 14px', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap',
                     background: '#f0f4ff', color: '#4338ca', border: '1px solid #c7d2fe',
                     borderRadius: 8, cursor: 'pointer' }}>
            Test Graph Credentials
          </button>
          <DateRangeFilter value={dateRange} onChange={setDateRange} />
        </div>
        {/* ── Env tabs (pill style) ── */}
        <div style={{ display: 'flex', gap: 6, padding: '10px 24px', flexWrap: 'wrap', position: 'relative', zIndex: 1 }}>
          {envTabs.map(t => {
            const active = envFilter === t.key
            const m = t.key === 'all' ? { dot: '#6366f1' } : envMeta(t.key)
            return (
              <button key={t.key} type="button" onClick={() => setEnvFilter(t.key)}
                style={{
                  padding: '5px 14px', fontSize: 12, fontWeight: 700,
                  color: active ? '#fff' : '#64748b',
                  background: active ? '#1e293b' : '#f1f5f9',
                  border: 'none', borderRadius: 20, cursor: 'pointer',
                  display: 'inline-flex', alignItems: 'center', gap: 5,
                  transition: 'background 0.12s, color 0.12s',
                }}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: active ? '#fff' : m.dot }} />
                {t.label}
              </button>
            )
          })}
        </div>
      </div>

      {err && (
        <div style={{ margin: 20, padding: 14, ...cardBase, borderColor: '#fecaca', background: '#fef2f2', color: '#991b1b', borderRadius: 10 }}>
          Failed to load dashboard: {err}
        </div>
      )}
      {loading && !data && (
        <div style={{ minHeight: 'calc(100vh - 120px)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
          <style>{`
            @keyframes radarSpin { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }
            @keyframes radarPing { 0%{transform:scale(.5);opacity:.7} 100%{transform:scale(1.5);opacity:0} }
            @keyframes radarDot  { 0%,100%{opacity:.3;transform:translateY(0) scale(.8)} 40%{opacity:1;transform:translateY(-3px) scale(1)} }
          `}</style>

          <div style={{ position: 'relative', width: 40, height: 40 }}>
            <div style={{ position: 'absolute', inset: 0, borderRadius: '50%', border: '1.5px solid #10b981', animation: 'radarPing 1.8s ease-out infinite' }} />
            <svg width="40" height="40" viewBox="0 0 40 40" style={{ position: 'absolute', inset: 0, animation: 'radarSpin 3s linear infinite' }}>
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
                animation: 'radarDot 1.2s ease-in-out infinite',
                animationDelay: `${i * 0.2}s`,
              }} />
            ))}
          </div>
        </div>
      )}

      {data && (
        <div style={{ padding: '20px 24px', maxWidth: 1600, margin: '0 auto' }}>

          {/* ── KPI strip ── */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 14, marginBottom: 18 }}>
            {[
              { label: 'Tenants',        value: fmt(totals.tenants),        type: 'tenants'  },
              { label: 'Apps',           value: fmt(totals.apps),           type: 'apps'     },
              { label: 'Total Requests', value: fmtK(totals.total_requests),type: 'requests' },
              { label: 'Total Errors',   value: fmtK(totals.total_errors),  type: 'errors'   },
              { label: 'Error Rate',     value: pct(totals.error_rate_pct), type: 'rate'     },
            ].map(c => {
              const p = KPI_PALETTE[c.type]
              const hov = hovKpi === c.type
              return (
                <div
                  key={c.label}
                  onMouseEnter={() => setHovKpi(c.type)}
                  onMouseLeave={() => setHovKpi(null)}
                  style={{
                    background: p.bg,
                    border: `1px solid ${hov ? p.iconColor + '55' : p.border}`,
                    borderRadius: 14,
                    padding: '18px 20px 16px',
                    boxShadow: hov ? `0 8px 24px ${p.iconColor}22` : '0 2px 8px rgba(0,0,0,0.05)',
                    transform: hov ? 'translateY(-3px)' : 'translateY(0)',
                    transition: 'transform 0.18s, box-shadow 0.18s, border-color 0.18s',
                    cursor: 'default',
                  }}
                >
                  <div style={{ width: 36, height: 36, borderRadius: 10, background: p.iconBg, color: p.iconColor, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 12 }}>
                    <SummaryIcon type={c.type} />
                  </div>
                  <div style={{ fontSize: 28, fontWeight: 800, color: p.numColor, letterSpacing: '-1.5px', lineHeight: 1, marginBottom: 4 }}>{c.value}</div>
                  <div style={{ fontSize: 11.5, color: '#64748b', fontWeight: 500 }}>{c.label}</div>
                </div>
              )
            })}
          </div>

          {/* ── Fleet Traffic chart ── */}
          <div style={{ ...cardBase, marginBottom: 14, overflow: 'hidden' }}>
            <div style={{ padding: '14px 20px 12px', borderBottom: '1px solid #f1f5f9', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#0f172a', display: 'flex', alignItems: 'center', gap: 7 }}>
                  <div style={{ width: 26, height: 26, borderRadius: 7, background: '#eff6ff', color: '#3b82f6', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>
                      <path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>
                    </svg>
                  </div>
                  Fleet Traffic &amp; Error Rate
                </div>
                <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>Hourly totals across all tenants · {dateRange?.label || ''}</div>
              </div>
            </div>
            <div style={{ padding: '12px 16px 8px' }}>
              <FleetTrafficChart buckets={tsData?.buckets} hoursBack={hoursBack} loading={tsLoading} />
            </div>
          </div>

          {/* ── Env Bar + Top Tenants Traffic + Tenant Donut ── */}
          <div style={{ display: 'grid', gridTemplateColumns: '3fr 2fr 2fr', gap: 14, marginBottom: 18 }}>
            <div
              onMouseEnter={() => setEnvHov(true)}
              onMouseLeave={() => setEnvHov(false)}
              style={{ ...cardBase, overflow: 'hidden', transition: 'box-shadow 0.18s, border-color 0.18s', borderColor: envHov ? '#a5b4fc' : '#e2e8f0', boxShadow: envHov ? '0 6px 20px rgba(99,102,241,0.12)' : cardBase.boxShadow }}>
              <div style={{ padding: '14px 20px 12px', borderBottom: '1px solid #f1f5f9' }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#0f172a', display: 'flex', alignItems: 'center', gap: 7 }}><span>📊</span> Requests by Environment</div>
                <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>Requests vs Errors · all envs</div>
              </div>
              <div style={{ padding: '12px 16px 8px' }}>
                <EnvBarChart envTotals={envTotals} />
              </div>
            </div>
            <div style={{ ...cardBase, overflow: 'hidden' }}>
              <div style={{ padding: '14px 20px 12px', borderBottom: '1px solid #f1f5f9' }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#0f172a', display: 'flex', alignItems: 'center', gap: 7 }}>
                  <span>🏆</span> Top Tenants by Request Volume
                </div>
                <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>Share of total requests across top 8 tenants</div>
              </div>
              <div style={{ padding: '12px 16px 8px' }}>
                <TenantTrafficChart tenants={data.tenants} />
              </div>
            </div>
            <div
              onMouseEnter={() => setDonutHov(true)}
              onMouseLeave={() => setDonutHov(false)}
              style={{ ...cardBase, overflow: 'hidden', transition: 'box-shadow 0.18s, border-color 0.18s', borderColor: donutHov ? '#a5b4fc' : '#e2e8f0', boxShadow: donutHov ? '0 6px 20px rgba(99,102,241,0.12)' : cardBase.boxShadow }}>
              <div style={{ padding: '14px 20px 12px', borderBottom: '1px solid #f1f5f9' }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#0f172a', display: 'flex', alignItems: 'center', gap: 7 }}><span>🍩</span> Workflow Share</div>
                <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>By workflow executions (top 8)</div>
              </div>
              <div style={{ padding: '12px 8px 8px' }}>
                <TenantDonutChart tenants={data.tenants} />
              </div>
            </div>
          </div>

          {/* ── Workflow Health + App Latency ── */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14 }}>
            <div style={{ ...cardBase, overflow: 'hidden' }}>
              <div style={{ padding: '14px 20px 12px', borderBottom: '1px solid #f1f5f9' }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#0f172a', display: 'flex', alignItems: 'center', gap: 7 }}>
                  <span>✅</span> Workflow Health by Tenant
                </div>
                <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>Passed vs failed workflows — top 8</div>
              </div>
              <div style={{ padding: '12px 16px 8px' }}>
                <WorkflowHealthChart tenants={data.tenants} />
              </div>
            </div>
            <div style={{ ...cardBase, overflow: 'hidden' }}>
              <div style={{ padding: '14px 20px 12px', borderBottom: '1px solid #f1f5f9' }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#0f172a', display: 'flex', alignItems: 'center', gap: 7 }}>
                  <span>⚡</span> P95 Latency by App
                </div>
                <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>P95 vs average response time — top 8</div>
              </div>
              <div style={{ padding: '12px 16px 8px' }}>
                <AppLatencyChart rows={data.by_latency} />
              </div>
            </div>
          </div>

          {/* ── API Monitor Section ── */}
          <ApiMonitorSection dateRange={dateRange} />

          {/* ── Large file workflows + App publish & start failures ── */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 18 }}>
          {(() => {
            const largeWfs   = data.large_file_workflows || []
            const thresholdMb = ((data.large_file_threshold_bytes || 30_000_000) / 1024 / 1024).toFixed(0)
            return (
              <div style={{ ...cardBase, overflow: 'hidden' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 20px', borderBottom: '1px solid #f1f5f9' }}>
                  <div style={{ width: 30, height: 30, borderRadius: 8, background: '#fef3c7', color: '#b45309', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                      <polyline points="14 2 14 8 20 8"/>
                    </svg>
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#0f172a' }}>Large file workflows</div>
                  <div style={{ fontSize: 11, color: '#94a3b8' }}>history size ≥ {thresholdMb} MB</div>
                  <div style={{ marginLeft: 'auto', fontSize: 11, color: '#94a3b8' }}>
                    {data.large_file_last_run_at ? <>Last scan {fmtRel(data.large_file_last_run_at)} · {data.large_file_last_match_count ?? 0} oversized</> : <>No scans completed yet</>}
                  </div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '2fr 1.6fr 1fr 1fr 0.9fr 0.9fr', gap: 12, padding: '8px 20px', borderBottom: '1px solid #f3f4f6', fontSize: 10, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  <span>Workflow</span><span>Tenant / App</span><span>File size</span><span>Closed</span><span>Status</span><span style={{ textAlign: 'right' }}>Duration</span>
                </div>
                {largeWfs.length === 0 ? (
                  <div style={{ padding: '32px 20px', textAlign: 'center', color: '#94a3b8', fontSize: 12 }}>No workflows exceeded the size threshold in this window.</div>
                ) : largeWfs.map(w => (
                  <div key={`${w.workflow_id}-${w.run_id}`}
                    onClick={() => w.tenant_name && goToTenant(w.tenant_name, w.app_name)}
                    style={{ display: 'grid', gridTemplateColumns: '2fr 1.6fr 1fr 1fr 0.9fr 0.9fr', gap: 12, padding: '10px 20px', borderBottom: '1px solid #f9fafb', fontSize: 12, color: '#374151', cursor: w.tenant_name ? 'pointer' : 'default', alignItems: 'center' }}
                    onMouseEnter={(e) => { if (w.tenant_name) e.currentTarget.style.background = '#f8fafc' }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
                  >
                    <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={w.workflow_id}>{w.workflow_id}</span>
                    <span>{w.tenant_name || '—'}{w.app_name ? <span style={{ color: '#9ca3af' }}> / {w.app_name}</span> : ''}</span>
                    <span style={{ fontWeight: 700, color: '#b45309' }}>{fmtSize(w.history_size_bytes)}</span>
                    <span style={{ color: '#6b7280' }}>{fmtRel(w.close_time || w.start_time)}</span>
                    <span style={{ fontSize: 11, color: '#6b7280' }}>{statusLabel(w.status)}</span>
                    <span style={{ textAlign: 'right', color: '#6b7280' }}>{fmtDuration(w)}</span>
                  </div>
                ))}
              </div>
            )
          })()}

          {(() => {
            const appFails   = data.app_lifecycle_failures || []
            const rangeLabel = (dateRange?.label || 'Today').toLowerCase()
            const fetchedAt  = data.app_lifecycle_fetched_at
            const kindMeta   = { publish: { label: 'Publish', bg: '#fef3c7', fg: '#92400e' }, start: { label: 'Start', bg: '#e0e7ff', fg: '#3730a3' } }
            const fmtDur = (start, end) => {
              if (!start || !end) return '—'
              const msDiff = new Date(end).getTime() - new Date(start).getTime()
              if (!isFinite(msDiff) || msDiff < 0) return '—'
              if (msDiff < 60_000) return (msDiff / 1000).toFixed(1) + ' s'
              const m2 = Math.floor(msDiff / 60_000), s2 = Math.floor((msDiff % 60_000) / 1000)
              return `${m2}m ${s2}s`
            }
            return (
              <div style={{ ...cardBase, overflow: 'hidden' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 20px', borderBottom: '1px solid #f1f5f9' }}>
                  <div style={{ width: 30, height: 30, borderRadius: 8, background: '#fee2e2', color: '#b91c1c', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 9v2m0 4h.01M5.07 19h13.86c1.54 0 2.5-1.67 1.73-3L13.73 4a2 2 0 0 0-3.46 0L3.34 16c-.77 1.33.19 3 1.73 3z"/>
                    </svg>
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#0f172a' }}>App publish &amp; start failures</div>
                  <div style={{ fontSize: 11, color: '#94a3b8' }}>{rangeLabel} · Temporal `default` ns</div>
                  <div style={{ marginLeft: 'auto', fontSize: 11, color: '#94a3b8' }}>
                    {fetchedAt ? <>Fetched {fmtRel(fetchedAt)} · {appFails.length} failure{appFails.length === 1 ? '' : 's'}</> : <>Temporal unreachable</>}
                  </div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '2.4fr 0.8fr 1fr 0.9fr auto', gap: 12, padding: '8px 20px', borderBottom: '1px solid #f3f4f6', fontSize: 10, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  <span>Workflow</span><span>Kind</span><span>Closed</span><span style={{ textAlign: 'right' }}>Duration</span><span style={{ width: 110, textAlign: 'right' }}>Action</span>
                </div>
                {appFails.length === 0 ? (
                  <div style={{ padding: '32px 20px', textAlign: 'center', color: '#94a3b8', fontSize: 12 }}>
                    No failed app publish or start workflows in {rangeLabel}.
                  </div>
                ) : appFails.map(f => {
                  const meta = kindMeta[f.kind] || { label: f.kind || '—', bg: '#f3f4f6', fg: '#374151' }
                  const tip = [`Workflow: ${f.workflow_id}`, f.workflow_type && `Type: ${f.workflow_type}`, f.namespace && `Namespace: ${f.namespace}`, f.tenant_id && `Tenant ID: ${f.tenant_id}`, f.app_id && `App ID: ${f.app_id}`].filter(Boolean).join('\n')
                  return (
                    <div key={`${f.workflow_id}-${f.run_id}`} title={tip}
                      style={{ display: 'grid', gridTemplateColumns: '2.4fr 0.8fr 1fr 0.9fr auto', gap: 12, padding: '10px 20px', borderBottom: '1px solid #f9fafb', fontSize: 12, color: '#374151', alignItems: 'center' }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = '#f8fafc' }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
                    >
                      <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11, color: '#374151', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={f.workflow_id}>{f.workflow_id || '—'}</span>
                      <span><span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: meta.bg, color: meta.fg }}>{meta.label}</span></span>
                      <span style={{ color: '#6b7280' }}>{fmtRel(f.close_time)}</span>
                      <span style={{ textAlign: 'right', color: '#6b7280' }}>{fmtDur(f.start_time, f.close_time)}</span>
                      <span style={{ width: 110, textAlign: 'right' }}>
                        <button type="button"
                          onClick={(e) => { e.stopPropagation(); openInvestigateForLifecycle(f) }}
                          style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '4px 10px', borderRadius: 6, background: '#6366f1', color: '#fff', border: 'none', cursor: 'pointer', fontSize: 11, fontWeight: 600 }}
                          onMouseEnter={(e) => e.currentTarget.style.background = '#4f46e5'}
                          onMouseLeave={(e) => e.currentTarget.style.background = '#6366f1'}>
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                          </svg>
                          Investigate
                        </button>
                      </span>
                    </div>
                  )
                })}
              </div>
            )
          })()}
          </div>

          {/* ── Tenant grid ── */}
          {data.tenants?.length > 0 && (
            <div style={{ marginBottom: 18 }}>
              <SectionHead icon="🏢" title="Tenants" badge={data.tenants.length} />
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: 12 }}>
                {data.tenants.map(t => (
                  <TenantCard key={t.tenant} t={t}
                    onTenantClick={(t) => goToTenant(t.tenant)}
                    onAppClick={(t, a) => goToTenant(t.tenant, a.app, a.env_key)}
                  />
                ))}
              </div>
            </div>
          )}

          {/* ── App leaderboards ── */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 24 }}>
            <LeaderboardCard title="Workflow Failures" icon="⚙" iconBg="#fef2f2" iconColor="#dc2626"
              rows={data.by_workflow_failures} emptyMsg="No workflow failures in this window"
              onRowClick={(r) => goToInsights(r, 'workflow')}
              renderRight={(r) => (
                <div>
                  <div style={{ fontSize: 15, fontWeight: 800, color: '#dc2626' }}>{fmt(r.workflow_failed)}</div>
                  <div style={{ fontSize: 10, color: '#6b7280' }}>of {fmt(r.workflow_total)} · {pct(r.workflow_error_rate_pct)}</div>
                </div>
              )}
            />
            <LeaderboardCard title="API Failures" icon="🛰" iconBg="#fff7ed" iconColor="#ea580c"
              rows={data.by_api_failures} emptyMsg="No API failures in this window"
              onRowClick={(r) => goToInsights(r, 'api-failures')}
              renderRight={(r) => (
                <div>
                  <div style={{ fontSize: 15, fontWeight: 800, color: '#ea580c' }}>{fmt(r.api_failed)}</div>
                  <div style={{ fontSize: 10, color: '#6b7280' }}>of {fmt(r.api_total)} · {pct(r.api_error_rate_pct)}</div>
                </div>
              )}
            />
            <LeaderboardCard title="Highest P95 Latency" icon="⏱" iconBg="#eff6ff" iconColor="#2563eb"
              rows={data.by_latency} emptyMsg="No latency data"
              onRowClick={(r) => goToInsights(r, 'p95-latency')}
              renderRight={(r) => (
                <div>
                  <div style={{ fontSize: 15, fontWeight: 800, color: '#2563eb' }}>{ms(r.p95_latency_ms)}</div>
                  <div style={{ fontSize: 10, color: '#6b7280' }}>avg {ms(r.avg_latency_ms)}</div>
                </div>
              )}
            />
            <LeaderboardCard title="Highest Error Rate" icon="%" iconBg="#fffbeb" iconColor="#d97706"
              rows={data.by_error_rate} emptyMsg="No apps above traffic threshold"
              onRowClick={(r) => goToInsights(r, 'error-rate')}
              renderRight={(r) => (
                <div>
                  <div style={{ fontSize: 15, fontWeight: 800, color: '#d97706' }}>{pct(r.error_rate_pct)}</div>
                  <div style={{ fontSize: 10, color: '#6b7280' }}>{fmt(r.total_errors)} / {fmt(r.total_requests)}</div>
                </div>
              )}
            />
          </div>

        </div>
      )}

      {/* ── Investigate modal for App lifecycle failures ── */}
      {investigateModal && (
        <div onClick={() => setInvestigateModal(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 20 }}>
          <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: 14, width: '100%', maxWidth: 880, maxHeight: '90vh', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 50px rgba(0,0,0,0.25)' }}>
            <div style={{ padding: '16px 20px', borderBottom: '1px solid #e5e7eb', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ minWidth: 0 }}>
                {(() => {
                  const ctx = (investigateModal.data && investigateModal.data.appContext) || {}
                  const appName    = ctx.app_display_name || ctx.app_name || investigateModal.appName
                  const tenantName = ctx.tenant_name || investigateModal.tenantName
                  const env        = ctx.environment || investigateModal.env
                  return (<>
                    <div style={{ fontSize: 15, fontWeight: 700, color: '#111827' }}>Investigate {investigateModal.kind ? `(${investigateModal.kind})` : ''}{appName ? ` — ${appName}` : ''}</div>
                    <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2, fontFamily: 'ui-monospace, monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={investigateModal.workflowId}>
                      {tenantName ? `${tenantName} · ` : ''}{env ? `${env} · ` : ''}{investigateModal.workflowId}
                    </div>
                  </>)
                })()}
              </div>
              <button onClick={() => setInvestigateModal(null)} style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 22, color: '#6b7280', lineHeight: 1, padding: '0 4px' }}>×</button>
            </div>
            <div style={{ padding: 20, overflowY: 'auto' }}>
              {investigateModal.loading && <div style={{ padding: 32, textAlign: 'center', color: '#6b7280', fontSize: 13 }}>Running AI investigation… (≈ 10–30 s)</div>}
              {investigateModal.error && <div style={{ background: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca', borderRadius: 8, padding: 12, fontSize: 12 }}>{investigateModal.error}</div>}
              {investigateModal.data && (() => {
                const ai = investigateModal.data.aiAnalysis || {}
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                    <section>
                      <div style={{ fontSize: 11, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Root cause</div>
                      <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: 12, fontSize: 13, color: '#7f1d1d', lineHeight: 1.5 }}>{ai.rootCause || '(no root cause returned)'}</div>
                    </section>
                    {Array.isArray(ai.failureChain) && ai.failureChain.length > 0 && (
                      <section>
                        <div style={{ fontSize: 11, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Failure chain</div>
                        <ol style={{ margin: 0, paddingLeft: 22, fontSize: 12.5, color: '#374151', lineHeight: 1.6 }}>
                          {ai.failureChain.map((s, i) => (
                            <li key={i} style={{ marginBottom: 8 }}>
                              <span style={{ fontWeight: 700, color: '#111827' }}>{s.label || s.stepId || `Step ${i + 1}`}</span>
                              {s.stepId && <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 10.5, color: '#9ca3af', marginLeft: 6 }}>[{s.stepId}]</span>}
                              <div>{s.description}</div>
                            </li>
                          ))}
                        </ol>
                      </section>
                    )}
                    {Array.isArray(ai.resolution) && ai.resolution.length > 0 && (
                      <section>
                        <div style={{ fontSize: 11, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Resolution</div>
                        <ul style={{ margin: 0, paddingLeft: 22, fontSize: 12.5, color: '#065f46', lineHeight: 1.6 }}>
                          {ai.resolution.map((r, i) => <li key={i} style={{ marginBottom: 4 }}>{r}</li>)}
                        </ul>
                      </section>
                    )}
                    {ai.prevention && (
                      <section>
                        <div style={{ fontSize: 11, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Prevention</div>
                        <div style={{ fontSize: 12.5, color: '#374151', lineHeight: 1.5 }}>{ai.prevention}</div>
                      </section>
                    )}
                    {ai.model && (
                      <div style={{ marginTop: 8, paddingTop: 12, borderTop: '1px solid #f3f4f6', fontSize: 10, color: '#9ca3af', display: 'flex', justifyContent: 'space-between' }}>
                        <span>Model: {ai.model}</span>
                        {ai.tokensUsed && <span>Tokens: {ai.tokensUsed.input} in · {ai.tokensUsed.output} out</span>}
                      </div>
                    )}
                  </div>
                )
              })()}
            </div>
          </div>
        </div>
      )}

      {graphModal && <GraphCredentialModal onClose={() => setGraphModal(false)} />}
    </div>
  )
}

export default Dashboard
