import { useState, useEffect, useCallback } from 'react'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Legend,
} from 'recharts'
import styles from './Insights.module.css'

const API = import.meta.env.VITE_API_BASE_URL || ''

// ─── helpers ──────────────────────────────────────────────────────────────────

function fmt(n, decimals = 1) {
  if (n == null) return '—'
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'K'
  return typeof n === 'number' ? n.toFixed(decimals) : n
}

function fmtBytes(b) {
  if (b == null)      return '—'
  if (b >= 1_048_576) return (b / 1_048_576).toFixed(1) + ' MB'
  if (b >= 1_024)     return (b / 1_024).toFixed(1) + ' KB'
  return b + ' B'
}

function fmtMs(v) {
  if (v == null) return '—'
  const n = Number(v)
  if (!isFinite(n)) return '—'
  if (n < 1000)   return `${Math.round(n)}ms`
  if (n < 60000)  return `${(n / 1000).toFixed(n < 10000 ? 2 : 1)}s`
  if (n < 3600000) {
    const m = Math.floor(n / 60000)
    const s = Math.round((n % 60000) / 1000)
    return s ? `${m}m ${s}s` : `${m}m`
  }
  const h = Math.floor(n / 3600000)
  const m = Math.round((n % 3600000) / 60000)
  return m ? `${h}h ${m}m` : `${h}h`
}

function errorColor(rate) {
  if (rate == null) return '#6b7280'
  if (rate > 10)    return '#ef4444'
  if (rate > 3)     return '#f59e0b'
  return '#10b981'
}

function scoreColor(score) {
  if (score == null) return '#6b7280'
  if (score >= 80)   return '#10b981'
  if (score >= 50)   return '#f59e0b'
  return '#ef4444'
}

// ─── shared atoms ─────────────────────────────────────────────────────────────

function StatCard({ label, value, sub, color }) {
  return (
    <div className={styles.statCard}>
      <div className={styles.statValue} style={color ? { color } : {}}>{value}</div>
      <div className={styles.statLabel}>{label}</div>
      {sub && <div className={styles.statSub}>{sub}</div>}
    </div>
  )
}

function Section({ title, children }) {
  return (
    <div className={styles.section}>
      <div className={styles.sectionTitle}>{title}</div>
      {children}
    </div>
  )
}

function KVGrid({ children }) {
  return <div className={styles.kvGrid}>{children}</div>
}

function KV({ label, value, color }) {
  return (
    <div className={styles.kv}>
      <span className={styles.kvLabel}>{label}</span>
      <span className={styles.kvValue} style={color ? { color } : {}}>{value ?? '—'}</span>
    </div>
  )
}

// ─── charts ───────────────────────────────────────────────────────────────────

function fmtTick(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

const C = {
  requests: '#3b82f6',
  err5xx:   '#ef4444',
  err4xx:   '#f59e0b',
  latency:  '#a78bfa',
  workflow: '#10b981',
}

function Chart({ title, data, lines, height = 200 }) {
  return (
    <div className={styles.chartBox}>
      <div className={styles.chartTitle}>{title}</div>
      {!data?.length
        ? <div className={styles.chartEmpty}>No data</div>
        : (
          <ResponsiveContainer width="100%" height={height}>
            <LineChart data={data} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
              <XAxis dataKey="timestamp" tickFormatter={fmtTick}
                tick={{ fill: '#64748b', fontSize: 10 }} interval="preserveStartEnd" />
              <YAxis tick={{ fill: '#64748b', fontSize: 10 }} />
              <Tooltip
                contentStyle={{ background: '#0f172a', border: '1px solid #334155', fontSize: 12 }}
                labelFormatter={v => new Date(v).toUTCString().slice(0, 25)}
              />
              {lines.length > 1 && <Legend wrapperStyle={{ fontSize: 11, color: '#94a3b8' }} />}
              {lines.map(l => (
                <Line key={l.key} type="monotone" dataKey={l.key} name={l.name}
                  stroke={l.color} dot={false} strokeWidth={2} activeDot={{ r: 3 }} />
              ))}
            </LineChart>
          </ResponsiveContainer>
        )
      }
    </div>
  )
}

function useTimeSeries(url) {
  const [data, setData]       = useState(null)
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    if (!url) return
    setLoading(true)
    fetch(url)
      .then(r => r.ok ? r.json() : null)
      .then(d => setData(d?.data || []))
      .catch(() => setData([]))
      .finally(() => setLoading(false))
  }, [url])
  return { data, loading }
}

// ─── VIEW 1 — Tenants list ────────────────────────────────────────────────────

function TenantsListView({ onSelectTenant }) {
  const [rows,    setRows]    = useState([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState(null)
  const [active,  setActive]  = useState(null)

  useEffect(() => {
    fetch(`${API}/api/insights/summary`)
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(d => setRows(d.tenants || []))
      .catch(() => setError('Failed to load tenant summaries'))
      .finally(() => setLoading(false))
  }, [])

  function handleClick(row) {
    setActive(row.tenant_name)
    onSelectTenant(row.tenant_name)
  }

  return (
    <div className={styles.page}>
      <div className={styles.topBar}>
        <h1 className={styles.pageTitle}>Tenants</h1>
      </div>

      {error   && <div className={styles.error}>{error}</div>}
      {loading && <div className={styles.loading}>Loading…</div>}

      {!loading && !error && (
        <div className={styles.tenantTable}>
          {/* header */}
          <div className={styles.tenantTableHead}>
            <div className={styles.colTenant}>Tenant</div>
            <div className={styles.colGroup}>
              <span className={styles.colGroupLabel}>Workflow</span>
              <div className={styles.colGroupCells}>
                <span>Success</span>
                <span>Failed</span>
              </div>
            </div>
            <div className={styles.colGroup}>
              <span className={styles.colGroupLabel}>API</span>
              <div className={styles.colGroupCells}>
                <span>Success</span>
                <span>Failed</span>
              </div>
            </div>
            <div className={styles.colStat}>Health</div>
            <div className={styles.colStat}>Apps</div>
            <div className={styles.colStat}>Total Req</div>
          </div>

          {/* rows */}
          {rows.map(row => (
            <div
              key={row.tenant_name}
              className={`${styles.tenantRow} ${active === row.tenant_name ? styles.tenantRowActive : ''}`}
              onClick={() => handleClick(row)}
            >
              <div className={styles.colTenant}>
                <span className={styles.tenantName}>{row.tenant_name}</span>
                {row.analyzed_at && (
                  <span className={styles.tenantMeta}>
                    {new Date(row.analyzed_at).toLocaleDateString()}
                  </span>
                )}
              </div>

              <div className={styles.colGroupCells}>
                <span className={styles.successVal}>{fmt(row.workflow?.success, 0)}</span>
                <span className={styles.failedVal}>{fmt(row.workflow?.failed, 0)}</span>
              </div>

              <div className={styles.colGroupCells}>
                <span className={styles.successVal}>{fmt(row.api?.success, 0)}</span>
                <span className={styles.failedVal}>{fmt(row.api?.failed, 0)}</span>
              </div>

              <div className={styles.colStat}>
                <span style={{ color: scoreColor(row.health_score), fontWeight: 600 }}>
                  {row.health_score ?? '—'}
                </span>
              </div>

              <div className={styles.colStat}>{row.app_count ?? '—'}</div>

              <div className={styles.colStat}>{fmt(row.total_requests, 0)}</div>
            </div>
          ))}

          {!loading && rows.length === 0 && (
            <div className={styles.tenantEmpty}>No tenant data found. Run the analysis Lambda first.</div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── VIEW 2 — Tenant detail (app grid) ───────────────────────────────────────

function TenantDetailView({ tenantName, onBack, onSelectApp }) {
  const [tenantData, setTenantData] = useState(null)
  const [appData,    setAppData]    = useState([])
  const [loading,    setLoading]    = useState(true)
  const [error,      setError]      = useState(null)

  useEffect(() => {
    if (!tenantName) return
    setLoading(true)
    setError(null)
    Promise.all([
      fetch(`${API}/api/insights/${tenantName}`),
      fetch(`${API}/api/insights/${tenantName}/apps`),
    ])
      .then(async ([tRes, aRes]) => {
        if (!tRes.ok) throw new Error('Tenant not found')
        setTenantData(await tRes.json())
        setAppData(aRes.ok ? await aRes.json() : [])
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [tenantName])

  const tm = tenantData?.metrics  || {}
  const ti = tenantData?.insights || {}

  return (
    <div className={styles.page}>

      {/* back + header */}
      <div className={styles.detailHeader}>
        <button className={styles.backBtn} onClick={onBack}>← Tenants</button>
        <div className={styles.detailMeta}>
          <h1 className={styles.detailTitle}>{tenantName}</h1>
          {tenantData && (
            <div className={styles.detailSub}>
              <span className={styles.authorityText}>
                Last analyzed: {new Date(tenantData.analyzed_at).toLocaleString()}
              </span>
              <span className={styles.authorityText}>
                {tenantData.app_count} app{tenantData.app_count !== 1 ? 's' : ''}
              </span>
            </div>
          )}
        </div>
      </div>

      {error   && <div className={styles.error}>{error}</div>}
      {loading && <div className={styles.loading}>Loading…</div>}

      {!loading && tenantData && (<>

        {/* tenant stat cards */}
        <div className={styles.cardRow}>
          <StatCard label="Health Score" value={tm.health_score ?? '—'}
            color={scoreColor(tm.health_score)}
            sub={ti.risk_level ? `Risk: ${ti.risk_level}` : undefined} />
          <StatCard label="Total Requests" value={fmt(tm.total_requests, 0)} />
          <StatCard label="Error Rate"
            value={tm.overall_error_rate_pct != null ? tm.overall_error_rate_pct + '%' : '—'}
            color={errorColor(tm.overall_error_rate_pct)}
            sub={`${fmt(tm.total_5xx, 0)} 5xx · ${fmt(tm.total_4xx, 0)} 4xx`} />
          <StatCard label="Workflow Reqs" value={fmt(tm.total_workflow_requests, 0)}
            sub={tm.workflow_error_rate_pct != null ? `${tm.workflow_error_rate_pct}% errors` : undefined} />
          <StatCard label="Bandwidth Sent" value={fmtBytes(tm.bandwidth?.total_bytes_sent)} />
          <StatCard label="Unique IPs" value={fmt(tm.who?.total_unique_client_ips, 0)}
            sub={tm.who?.total_bot_requests ? `${tm.who.total_bot_requests} bots` : undefined} />
        </div>

        {/* tenant AI insights */}
        {(ti.health_score_reason || ti.critical_issues?.length > 0 || ti.top_recommendations?.length > 0) && (
          <div className={styles.insightsPanel}>
            {ti.health_score_reason && (
              <div className={styles.insightBlock}>
                <div className={styles.insightBlockTitle}>Health Summary</div>
                <p className={styles.insightText}>{ti.health_score_reason}</p>
              </div>
            )}
            {ti.cross_app_patterns && (
              <div className={styles.insightBlock}>
                <div className={styles.insightBlockTitle}>Cross-App Patterns</div>
                <p className={styles.insightText}>{ti.cross_app_patterns}</p>
              </div>
            )}
            {ti.critical_issues?.length > 0 && (
              <div className={styles.insightBlock}>
                <div className={styles.insightBlockTitle}>Critical Issues</div>
                <ul className={styles.list}>{ti.critical_issues.map((x, i) => <li key={i}>{x}</li>)}</ul>
              </div>
            )}
            {ti.top_recommendations?.length > 0 && (
              <div className={styles.insightBlock}>
                <div className={styles.insightBlockTitle}>Recommendations</div>
                <ul className={styles.list}>{ti.top_recommendations.map((x, i) => <li key={i}>{x}</li>)}</ul>
              </div>
            )}
          </div>
        )}

        {/* tenant charts */}
        <TenantCharts tenantName={tenantName} timeframe={tenantData?.timeframe} />

        {/* API monitor */}
        {appData.length > 0 && (
          <ApiMonitorSection apps={appData} onSelectApp={onSelectApp} />
        )}

        {/* app grid */}
        {appData.length > 0 && (
          <>
            <h2 className={styles.sectionHeading}>Applications</h2>
            <div className={styles.appGrid}>
              {appData.map(app => (
                <AppCard key={app.id} app={app} onClick={onSelectApp} />
              ))}
            </div>
          </>
        )}
      </>)}
    </div>
  )
}

// ─── VIEW 3 — App detail (charts + metrics) ───────────────────────────────────

function AppDetailView({ app, tenantName, onBack }) {
  const m   = app.metrics  || {}
  const ins = app.insights || {}
  const wf  = m.workflow   || {}
  const lat = m.latency_ms || {}
  const bw  = m.bandwidth  || {}
  const who = m.who        || {}

  const tf = app.timeframe || {}
  const tsUrl = tf.start && tf.end
    ? `${API}/api/timeseries/${app.tenant_name}/app?${new URLSearchParams({
        authority: app.authority, start: tf.start, end: tf.end,
      })}`
    : null
  const { data: tsData, loading: tsLoading } = useTimeSeries(tsUrl)

  return (
    <div className={styles.page}>

      <div className={styles.detailHeader}>
        <button className={styles.backBtn} onClick={onBack}>← {tenantName}</button>
        <div className={styles.detailMeta}>
          <h1 className={styles.detailTitle}>{app.app_name}</h1>
          <div className={styles.detailSub}>
            <span className={styles.envBadge}>{app.environment}</span>
            <span className={styles.authorityText}>{app.authority}</span>
            {tf.start && (
              <span className={styles.authorityText}>
                {new Date(tf.start).toLocaleString()} → {new Date(tf.end).toLocaleString()}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* key metrics */}
      <div className={styles.cardRow}>
        <StatCard label="Total Requests"  value={fmt(m.total_requests, 0)} />
        <StatCard label="Req / min"       value={m.request_rate_per_min ?? '—'} />
        <StatCard label="Error Rate"
          value={m.error_rate_pct != null ? m.error_rate_pct + '%' : '—'}
          color={errorColor(m.error_rate_pct)}
          sub={`${fmt(m.error_4xx_count, 0)} 4xx · ${fmt(m.error_5xx_count, 0)} 5xx`} />
        <StatCard label="P95 Latency"     value={fmtMs(lat.p95)}
          sub={lat.p99 != null ? `p99: ${fmtMs(lat.p99)}` : undefined} />
        <StatCard label="Workflow Reqs"   value={fmt(wf.total_requests, 0)}
          sub={wf.error_rate_pct != null ? `${wf.error_rate_pct}% errors` : undefined} />
        <StatCard label="Unique IPs"      value={fmt(who.unique_client_ips, 0)}
          sub={who.bot_rate_pct > 0 ? `${who.bot_rate_pct}% bots` : undefined} />
      </div>

      {/* charts */}
      <h2 className={styles.sectionHeading}>Time Series</h2>
      {tsLoading
        ? <div className={styles.chartLoading}>Loading charts…</div>
        : (
          <div className={styles.chartGrid}>
            <Chart title="Requests" data={tsData}
              lines={[{ key: 'requests',         name: 'Requests', color: C.requests }]} />
            <Chart title="5xx Errors" data={tsData}
              lines={[{ key: 'errors_5xx',        name: '5xx',      color: C.err5xx  }]} />
            <Chart title="4xx Errors" data={tsData}
              lines={[{ key: 'errors_4xx',        name: '4xx',      color: C.err4xx  }]} />
            <Chart title="Avg Latency (ms)" data={tsData}
              lines={[{ key: 'avg_latency_ms',    name: 'Latency',  color: C.latency }]} />
            <Chart title="Workflow Requests" data={tsData}
              lines={[{ key: 'workflow_requests', name: 'Workflow', color: C.workflow }]} />
          </div>
        )
      }

      {/* detailed metrics */}
      <h2 className={styles.sectionHeading} style={{ marginTop: 32 }}>Metrics</h2>
      <div className={styles.detailGrid}>

        <Section title="Traffic">
          <KVGrid>
            <KV label="Total Requests"  value={fmt(m.total_requests, 0)} />
            <KV label="Req / min"       value={m.request_rate_per_min} />
            <KV label="Error Rate"      value={m.error_rate_pct != null ? m.error_rate_pct + '%' : '—'} color={errorColor(m.error_rate_pct)} />
            <KV label="4xx"             value={fmt(m.error_4xx_count, 0)} />
            <KV label="5xx"             value={fmt(m.error_5xx_count, 0)} />
            <KV label="Downtime Gaps"   value={m.downtime_gap_count ?? '—'} />
          </KVGrid>
          {m.failure_reasons && Object.keys(m.failure_reasons).length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div className={styles.kvLabel} style={{ marginBottom: 6 }}>Failure Reasons</div>
              <KVGrid>
                {Object.entries(m.failure_reasons).map(([k, v]) => <KV key={k} label={k} value={v} />)}
              </KVGrid>
            </div>
          )}
        </Section>

        <Section title="Latency">
          <KVGrid>
            <KV label="Avg"          value={fmtMs(lat.avg)} />
            <KV label="P50"          value={fmtMs(lat.p50)} />
            <KV label="P95"          value={fmtMs(lat.p95)} />
            <KV label="P99"          value={fmtMs(lat.p99)} />
            <KV label="Max"          value={fmtMs(lat.max)} />
            <KV label="Upstream P95" value={fmtMs(m.upstream_processing_ms?.p95)} />
          </KVGrid>
        </Section>

        <Section title="Workflow">
          <KVGrid>
            <KV label="Total Requests" value={fmt(wf.total_requests, 0)} />
            <KV label="Errors"         value={fmt(wf.error_count, 0)} />
            <KV label="Error Rate"     value={wf.error_rate_pct != null ? wf.error_rate_pct + '%' : '—'} color={errorColor(wf.error_rate_pct)} />
            <KV label="Avg Latency"    value={fmtMs(wf.latency_ms?.avg)} />
            <KV label="P95 Latency"    value={fmtMs(wf.latency_ms?.p95)} />
          </KVGrid>
        </Section>

        <Section title="Bandwidth">
          <KVGrid>
            <KV label="Bytes Sent"     value={fmtBytes(bw.total_bytes_sent)} />
            <KV label="Bytes Received" value={fmtBytes(bw.total_bytes_received)} />
            <KV label="Avg Response"   value={fmtBytes(bw.avg_response_bytes)} />
          </KVGrid>
        </Section>

        <Section title="Who">
          <KVGrid>
            <KV label="Unique IPs"   value={who.unique_client_ips} />
            <KV label="Unique Users" value={who.unique_users || '—'} />
            <KV label="Bot Requests" value={who.bot_request_count} />
            <KV label="Bot Rate"     value={who.bot_rate_pct != null ? who.bot_rate_pct + '%' : '—'} />
          </KVGrid>
          {who.top_clients_by_requests?.length > 0 && (
            <table className={styles.table} style={{ marginTop: 10 }}>
              <thead><tr><th>Client IP</th><th>Requests</th></tr></thead>
              <tbody>
                {who.top_clients_by_requests.slice(0, 5).map((c, i) => (
                  <tr key={i}><td>{c.ip}</td><td>{c.requests}</td></tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>

      </div>

      {/* endpoint tables */}
      {m.top_endpoints_by_traffic?.length > 0 && (
        <Section title="Top Endpoints by Traffic">
          <table className={styles.table}>
            <thead><tr><th>Path</th><th>Requests</th><th>Avg (ms)</th></tr></thead>
            <tbody>
              {m.top_endpoints_by_traffic.slice(0, 10).map((e, i) => (
                <tr key={i}>
                  <td className={styles.pathCell}>{e.path}</td>
                  <td>{e.count}</td>
                  <td>{e.avg_duration_ms ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}

      {m.top_endpoints_by_errors?.length > 0 && (
        <Section title="Top Endpoints by Errors">
          <table className={styles.table}>
            <thead><tr><th>Path</th><th>Errors</th><th>Error Rate</th></tr></thead>
            <tbody>
              {m.top_endpoints_by_errors.slice(0, 10).map((e, i) => (
                <tr key={i}>
                  <td className={styles.pathCell}>{e.path}</td>
                  <td>{e.error_count}</td>
                  <td style={{ color: errorColor(e.error_rate_pct) }}>{e.error_rate_pct}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}

      {m.upstream_dependencies?.length > 0 && (
        <Section title="Upstream Dependencies">
          <table className={styles.table}>
            <thead><tr><th>Cluster</th><th>Requests</th><th>Errors</th><th>Error Rate</th></tr></thead>
            <tbody>
              {m.upstream_dependencies.map((d, i) => (
                <tr key={i}>
                  <td className={styles.pathCell}>{d.cluster}</td>
                  <td>{d.requests}</td>
                  <td>{d.errors}</td>
                  <td style={{ color: errorColor(d.error_rate_pct) }}>{d.error_rate_pct}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}

      {/* AI insights */}
      {(ins.error_analysis || ins.top_issues?.length > 0 || ins.recommendations?.length > 0) && (
        <>
          <h2 className={styles.sectionHeading} style={{ marginTop: 32 }}>AI Insights</h2>
          <div className={styles.insightsPanel}>
            {ins.error_analysis?.error_patterns && (
              <div className={styles.insightBlock}>
                <div className={styles.insightBlockTitle}>Error Analysis</div>
                <p className={styles.insightText}>{ins.error_analysis.error_patterns}</p>
              </div>
            )}
            {ins.performance_insights?.anomalies && (
              <div className={styles.insightBlock}>
                <div className={styles.insightBlockTitle}>Performance</div>
                <p className={styles.insightText}>{ins.performance_insights.anomalies}</p>
              </div>
            )}
            {ins.security_observations && (
              <div className={styles.insightBlock}>
                <div className={styles.insightBlockTitle}>Security</div>
                <p className={styles.insightText}>{ins.security_observations}</p>
              </div>
            )}
            {ins.top_issues?.length > 0 && (
              <div className={styles.insightBlock}>
                <div className={styles.insightBlockTitle}>Top Issues</div>
                <ul className={styles.list}>{ins.top_issues.map((t, i) => <li key={i}>{t}</li>)}</ul>
              </div>
            )}
            {ins.recommendations?.length > 0 && (
              <div className={styles.insightBlock}>
                <div className={styles.insightBlockTitle}>Recommendations</div>
                <ul className={styles.list}>{ins.recommendations.map((r, i) => <li key={i}>{r}</li>)}</ul>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

// ─── App card ─────────────────────────────────────────────────────────────────

function AppCard({ app, onClick }) {
  const m   = app.metrics  || {}
  const wf  = m.workflow   || {}
  const lat = m.latency_ms || {}
  return (
    <div className={styles.appCard} onClick={() => onClick(app)}>
      <div className={styles.appCardHeader}>
        <span className={styles.appName}>{app.app_name}</span>
        <span className={styles.envBadge}>{app.environment}</span>
      </div>
      <div className={styles.appCardBody}>
        <div className={styles.appStat}>
          <span className={styles.appStatVal}>{fmt(m.total_requests, 0)}</span>
          <span className={styles.appStatLbl}>requests</span>
        </div>
        <div className={styles.appStat}>
          <span className={styles.appStatVal} style={{ color: errorColor(m.error_rate_pct) }}>
            {m.error_rate_pct != null ? m.error_rate_pct + '%' : '—'}
          </span>
          <span className={styles.appStatLbl}>error rate</span>
        </div>
        <div className={styles.appStat}>
          <span className={styles.appStatVal}>{fmtMs(lat.p95)}</span>
          <span className={styles.appStatLbl}>p95 latency</span>
        </div>
        <div className={styles.appStat}>
          <span className={styles.appStatVal}>{fmt(wf.total_requests, 0)}</span>
          <span className={styles.appStatLbl}>workflows</span>
        </div>
      </div>
      <div className={styles.appCardFooter}>
        {m.downtime_gap_count > 0 && (
          <span className={styles.tag} style={{ background: '#fef3c7', color: '#92400e' }}>
            {m.downtime_gap_count} gap{m.downtime_gap_count > 1 ? 's' : ''}
          </span>
        )}
        {m.who?.bot_rate_pct > 0 && (
          <span className={styles.tag} style={{ background: '#ede9fe', color: '#5b21b6' }}>
            {m.who.bot_rate_pct}% bots
          </span>
        )}
        <span className={styles.viewDetail}>View details →</span>
      </div>
    </div>
  )
}

// ─── API Monitor section ──────────────────────────────────────────────────────

function apiStatus(errorRate) {
  if (errorRate == null) return { label: 'Unknown',  color: '#64748b', bg: '#0f172a' }
  if (errorRate > 10)    return { label: 'Degraded', color: '#ef4444', bg: '#450a0a' }
  if (errorRate > 3)     return { label: 'Warning',  color: '#f59e0b', bg: '#451a03' }
  return                        { label: 'Healthy',  color: '#10b981', bg: '#052e16' }
}

function ApiMonitorSection({ apps, onSelectApp }) {
  if (!apps || apps.length === 0) return null
  return (
    <>
      <h2 className={styles.sectionHeading}>API Monitor</h2>
      <div className={styles.apiMonitorTable}>
        <div className={styles.apiMonitorHead}>
          <span>Application</span>
          <span>Status</span>
          <span>Requests</span>
          <span>Error Rate</span>
          <span>P95 Latency</span>
          <span>4xx</span>
          <span>5xx</span>
        </div>
        {apps.map(app => {
          const m   = app.metrics  || {}
          const lat = m.latency_ms || {}
          const st  = apiStatus(m.error_rate_pct)
          return (
            <div key={app.id} className={styles.apiMonitorRow} onClick={() => onSelectApp(app)}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontWeight: 600, color: '#f1f5f9', fontSize: '0.875rem' }}>{app.app_name}</span>
                <span className={styles.envBadge}>{app.environment}</span>
              </div>
              <div>
                <span className={styles.apiStatusBadge} style={{ color: st.color, background: st.bg }}>
                  {st.label}
                </span>
              </div>
              <div>{fmt(m.total_requests, 0)}</div>
              <div style={{ color: errorColor(m.error_rate_pct), fontWeight: 600 }}>
                {m.error_rate_pct != null ? m.error_rate_pct + '%' : '—'}
              </div>
              <div>{fmtMs(lat.p95)}</div>
              <div style={{ color: (m.error_4xx_count || 0) > 0 ? '#f59e0b' : '#475569' }}>
                {fmt(m.error_4xx_count, 0)}
              </div>
              <div style={{ color: (m.error_5xx_count || 0) > 0 ? '#ef4444' : '#475569' }}>
                {fmt(m.error_5xx_count, 0)}
              </div>
            </div>
          )
        })}
      </div>
    </>
  )
}

// ─── Tenant charts ────────────────────────────────────────────────────────────

function TenantCharts({ tenantName, timeframe }) {
  const url = tenantName && timeframe?.start
    ? `${API}/api/timeseries/${tenantName}?${new URLSearchParams({ start: timeframe.start, end: timeframe.end })}`
    : null
  const { data, loading } = useTimeSeries(url)

  if (loading) return <div className={styles.chartLoading}>Loading charts…</div>
  if (!data)   return null

  return (
    <div className={styles.chartSection}>
      <h2 className={styles.sectionHeading}>Traffic Overview</h2>
      <div className={styles.chartGrid}>
        <Chart title="Requests"          data={data} lines={[{ key: 'requests',         name: 'Requests', color: C.requests }]} />
        <Chart title="Errors"            data={data} lines={[{ key: 'errors_5xx', name: '5xx', color: C.err5xx }, { key: 'errors_4xx', name: '4xx', color: C.err4xx }]} />
        <Chart title="Avg Latency (ms)"  data={data} lines={[{ key: 'avg_latency_ms',   name: 'Latency',  color: C.latency }]} />
        <Chart title="Workflow Requests" data={data} lines={[{ key: 'workflow_requests', name: 'Workflow', color: C.workflow }]} />
      </div>
    </div>
  )
}

// ─── Root component ───────────────────────────────────────────────────────────

export default function Insights() {
  // view: 'tenants' | 'tenant-detail' | 'app-detail'
  const [view,           setView]           = useState('tenants')
  const [selectedTenant, setSelectedTenant] = useState(null)
  const [selectedApp,    setSelectedApp]    = useState(null)

  function goToTenant(tenantName) {
    setSelectedTenant(tenantName)
    setView('tenant-detail')
  }

  function goToApp(app) {
    setSelectedApp(app)
    setView('app-detail')
  }

  function backToTenants() {
    setSelectedTenant(null)
    setSelectedApp(null)
    setView('tenants')
  }

  function backToTenant() {
    setSelectedApp(null)
    setView('tenant-detail')
  }

  if (view === 'app-detail' && selectedApp) {
    return <AppDetailView app={selectedApp} tenantName={selectedTenant} onBack={backToTenant} />
  }

  if (view === 'tenant-detail' && selectedTenant) {
    return (
      <TenantDetailView
        tenantName={selectedTenant}
        onBack={backToTenants}
        onSelectApp={goToApp}
      />
    )
  }

  return <TenantsListView onSelectTenant={goToTenant} />
}
