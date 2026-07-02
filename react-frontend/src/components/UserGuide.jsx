import { useEffect, useMemo, useRef, useState } from 'react'
import { marked } from 'marked'
import guideMd from '../../../docs/USER_GUIDE.md?raw'
import appInsightsApiEnvSvg from '../../../docs/images/app-insights-api-env.svg?raw'
import appInsightsChartViewSvg from '../../../docs/images/app-insights-chart-view.svg?raw'
import appInsightsListViewSvg from '../../../docs/images/app-insights-list-view.svg?raw'
import appInsightsSummarySvg from '../../../docs/images/app-insights-summary.svg?raw'
import chartErrorRateSvg from '../../../docs/images/chart-error-rate.svg?raw'
import chartErrorsSvg from '../../../docs/images/chart-errors.svg?raw'
import chartP95LatencySvg from '../../../docs/images/chart-p95-latency.svg?raw'
import chartRequestsSvg from '../../../docs/images/chart-requests.svg?raw'
import dashboardIncidentEvidenceSvg from '../../../docs/images/dashboard-incident-evidence.svg?raw'
import dashboardIncidentSummarySvg from '../../../docs/images/dashboard-incident-summary.svg?raw'
import dashboardLeaderboardsSvg from '../../../docs/images/dashboard-leaderboards.svg?raw'
import dashboardOverviewSvg from '../../../docs/images/dashboard-overview.svg?raw'
import dashboardPodsSvg from '../../../docs/images/dashboard-pods.svg?raw'
import dashboardTenantPopoverSvg from '../../../docs/images/dashboard-tenant-popover.svg?raw'
import dashboardTenantsGridSvg from '../../../docs/images/dashboard-tenants-grid.svg?raw'
import investigationApiEventsSvg from '../../../docs/images/investigation-api-events.svg?raw'
import investigationFailureChainSvg from '../../../docs/images/investigation-failure-chain.svg?raw'
import investigationOverviewSvg from '../../../docs/images/investigation-overview.svg?raw'
import investigationRcaFixSvg from '../../../docs/images/investigation-rca-fix.svg?raw'
import investigationRequestDetailsSvg from '../../../docs/images/investigation-request-details.svg?raw'
import investigationSubmitFixSvg from '../../../docs/images/investigation-submit-fix.svg?raw'
import investigationWorkflowFlowSvg from '../../../docs/images/investigation-workflow-flow.svg?raw'
import tenantAppsAppListSvg from '../../../docs/images/tenant-apps-app-list.svg?raw'
import tenantAppsTableSvg from '../../../docs/images/tenant-apps-table.svg?raw'
import workflow5xxTableSvg from '../../../docs/images/workflow-5xx-table.svg?raw'
import workflowDailyStatusSvg from '../../../docs/images/workflow-daily-status.svg?raw'
import workflowErrorCardsSvg from '../../../docs/images/workflow-error-cards.svg?raw'
import workflowFailedTableSvg from '../../../docs/images/workflow-failed-table.svg?raw'
import workflowSummarySvg from '../../../docs/images/workflow-summary.svg?raw'
import workflowWeeklyStatusSvg from '../../../docs/images/workflow-weekly-status.svg?raw'

// ─── Configure marked once ───────────────────────────────────────────────────
marked.setOptions({
  gfm: true,
  breaks: false,
  headerIds: true,
  mangle: false,
})

const guideImages = {
  'app-insights-api-env.svg': appInsightsApiEnvSvg,
  'app-insights-chart-view.svg': appInsightsChartViewSvg,
  'app-insights-list-view.svg': appInsightsListViewSvg,
  'app-insights-summary.svg': appInsightsSummarySvg,
  'chart-error-rate.svg': chartErrorRateSvg,
  'chart-errors.svg': chartErrorsSvg,
  'chart-p95-latency.svg': chartP95LatencySvg,
  'chart-requests.svg': chartRequestsSvg,
  'dashboard-incident-evidence.svg': dashboardIncidentEvidenceSvg,
  'dashboard-incident-summary.svg': dashboardIncidentSummarySvg,
  'dashboard-leaderboards.svg': dashboardLeaderboardsSvg,
  'dashboard-overview.svg': dashboardOverviewSvg,
  'dashboard-pods.svg': dashboardPodsSvg,
  'dashboard-tenant-popover.svg': dashboardTenantPopoverSvg,
  'dashboard-tenants-grid.svg': dashboardTenantsGridSvg,
  'investigation-api-events.svg': investigationApiEventsSvg,
  'investigation-failure-chain.svg': investigationFailureChainSvg,
  'investigation-overview.svg': investigationOverviewSvg,
  'investigation-rca-fix.svg': investigationRcaFixSvg,
  'investigation-request-details.svg': investigationRequestDetailsSvg,
  'investigation-submit-fix.svg': investigationSubmitFixSvg,
  'investigation-workflow-flow.svg': investigationWorkflowFlowSvg,
  'tenant-apps-app-list.svg': tenantAppsAppListSvg,
  'tenant-apps-table.svg': tenantAppsTableSvg,
  'workflow-5xx-table.svg': workflow5xxTableSvg,
  'workflow-daily-status.svg': workflowDailyStatusSvg,
  'workflow-error-cards.svg': workflowErrorCardsSvg,
  'workflow-failed-table.svg': workflowFailedTableSvg,
  'workflow-summary.svg': workflowSummarySvg,
  'workflow-weekly-status.svg': workflowWeeklyStatusSvg,
}

const inlineGuideImages = (md) => md.replace(
  /\]\(images\/([^)]+\.svg)\)/g,
  (match, fileName) => {
    const svg = guideImages[fileName]
    if (!svg) return match
    return `](data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)})`
  },
)

// Pre-render the guide HTML at module load (cheap — runs once per session).
const GUIDE_HTML = marked.parse(inlineGuideImages(guideMd))

// Slugify identical to GitHub's algorithm (lowercase, drop punctuation, dash-join).
const slug = (s) => s
  .toLowerCase()
  .replace(/[^\w\s-]/g, '')
  .trim()
  .replace(/\s+/g, '-')

// Pull h1/h2/h3 out of the parsed HTML for the side TOC.
function buildToc(html) {
  if (typeof window === 'undefined') return []
  const tmp = document.createElement('div')
  tmp.innerHTML = html
  const out = []
  tmp.querySelectorAll('h1, h2, h3').forEach((el) => {
    const level = Number(el.tagName[1])
    const text = el.textContent.trim()
    out.push({ level, text, id: slug(text) })
  })
  return out
}

// ─── Modal ───────────────────────────────────────────────────────────────────
export default function UserGuide({ open, onClose }) {
  const bodyRef = useRef(null)
  const [query, setQuery] = useState('')

  const toc = useMemo(() => buildToc(GUIDE_HTML), [])

  // Inject IDs on the rendered headings so anchor scrolling works. We always
  // overwrite — if marked or anything else set an ID with a different slug
  // algorithm, the TOC would otherwise miss its target.
  useEffect(() => {
    if (!open || !bodyRef.current) return
    bodyRef.current.querySelectorAll('h1, h2, h3, h4').forEach((el) => {
      el.id = slug(el.textContent.trim())
    })
  }, [open])

  // Close on Escape
  useEffect(() => {
    if (!open) return
    const onKey = (e) => { if (e.key === 'Escape') onClose?.() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // Lock background scroll while open
  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [open])

  if (!open) return null

  const filteredToc = query
    ? toc.filter(t => t.text.toLowerCase().includes(query.toLowerCase()))
    : toc

  const onTocClick = (e, id) => {
    e.preventDefault()
    e.stopPropagation()
    const body = bodyRef.current
    if (!body) return
    // Find the heading by its injected id. Avoid querySelector('#...') because
    // many of our slugs start with digits ("1-dashboard-page") which makes
    // them invalid CSS selectors without escape gymnastics.
    let target = null
    body.querySelectorAll('h1, h2, h3, h4').forEach((h) => {
      if (h.id === id) target = h
    })
    if (!target) return
    // Manually scroll the body container — scrollIntoView is unreliable when
    // the scroll container is a non-document element with overflow:auto.
    body.scrollTo({ top: target.offsetTop - 8, behavior: 'smooth' })
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 10000,
        background: 'rgba(15, 23, 42, 0.55)',
        backdropFilter: 'blur(2px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 24,
        fontFamily: "'Inter', -apple-system, system-ui, sans-serif",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#fff',
          width: 'min(1180px, 100%)',
          height: 'min(900px, 92vh)',
          borderRadius: 16,
          display: 'grid',
          gridTemplateColumns: '260px 1fr',
          overflow: 'hidden',
          boxShadow: '0 24px 60px rgba(15, 23, 42, 0.35)',
        }}
      >
        {/* ── Sidebar (TOC) ── */}
        <aside
          style={{
            background: '#f8fafc',
            borderRight: '1px solid #e5e7eb',
            display: 'flex', flexDirection: 'column',
            overflow: 'hidden',
          }}
        >
          <div style={{ padding: '18px 18px 12px', borderBottom: '1px solid #eef2f7' }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#9ca3af',
              textTransform: 'uppercase', letterSpacing: '0.08em' }}>User guide</div>
            <div style={{ fontSize: 15, fontWeight: 700, color: '#111827', marginTop: 2 }}>
              APM Tenant Monitor
            </div>
          </div>
          <div style={{ padding: '10px 14px', borderBottom: '1px solid #eef2f7' }}>
            <input
              type="text"
              placeholder="Search sections…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              style={{
                width: '100%', padding: '7px 10px', fontSize: 12,
                border: '1px solid #e5e7eb', borderRadius: 8,
                background: '#fff', outline: 'none', color: '#111827',
              }}
            />
          </div>
          <nav style={{ flex: 1, overflowY: 'auto', padding: '8px 6px 16px' }}>
            {filteredToc.map((t, i) => (
              <a
                key={`${t.id}-${i}`}
                href={`#${t.id}`}
                onClick={(e) => onTocClick(e, t.id)}
                style={{
                  display: 'block',
                  padding: '5px 10px',
                  paddingLeft: 10 + (t.level - 1) * 12,
                  fontSize: t.level === 1 ? 13 : 12,
                  fontWeight: t.level === 1 ? 700 : t.level === 2 ? 600 : 500,
                  color: t.level === 1 ? '#111827' : t.level === 2 ? '#374151' : '#6b7280',
                  textDecoration: 'none',
                  borderRadius: 6,
                  margin: '1px 4px',
                  lineHeight: 1.35,
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = '#eef2f7' }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
              >
                {t.text}
              </a>
            ))}
            {filteredToc.length === 0 && (
              <div style={{ padding: '10px 14px', fontSize: 12, color: '#9ca3af' }}>
                No matching sections.
              </div>
            )}
          </nav>
        </aside>

        {/* ── Main pane ── */}
        <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {/* Pane header */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '14px 22px', borderBottom: '1px solid #eef2f7', background: '#fff',
          }}>
            <div style={{ fontSize: 13, color: '#6b7280' }}>
              Press <kbd style={kbdStyle}>Esc</kbd> or click outside to close
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              style={{
                width: 32, height: 32, border: 'none', background: '#f3f4f6',
                borderRadius: 8, cursor: 'pointer', color: '#374151', fontSize: 18,
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = '#e5e7eb' }}
              onMouseLeave={(e) => { e.currentTarget.style.background = '#f3f4f6' }}
            >
              ×
            </button>
          </div>

          {/* Body */}
          <div
            ref={bodyRef}
            className="user-guide-body"
            style={{
              flex: 1, overflowY: 'auto',
              padding: '20px 32px 60px',
              fontSize: 14, color: '#1f2937', lineHeight: 1.65,
              background: '#fff',
            }}
            dangerouslySetInnerHTML={{ __html: GUIDE_HTML }}
          />
          <style>{guideStyles}</style>
        </div>
      </div>
    </div>
  )
}

const kbdStyle = {
  padding: '2px 6px', borderRadius: 4, background: '#f3f4f6',
  border: '1px solid #e5e7eb', fontSize: 11, fontFamily: 'ui-monospace, monospace',
  color: '#374151',
}

// ─── Markdown rendering styles ──────────────────────────────────────────────
const guideStyles = `
.user-guide-body h1, .user-guide-body h2, .user-guide-body h3, .user-guide-body h4 {
  color: #111827; line-height: 1.25; margin: 1.6em 0 0.5em; font-weight: 700;
  scroll-margin-top: 8px;
}
.user-guide-body h1 { font-size: 26px; border-bottom: 1px solid #eef2f7; padding-bottom: 8px; margin-top: 0.6em; }
.user-guide-body h2 { font-size: 20px; border-bottom: 1px solid #f3f4f6; padding-bottom: 6px; }
.user-guide-body h3 { font-size: 16px; }
.user-guide-body h4 { font-size: 14px; color: #374151; }
.user-guide-body p { margin: 0.6em 0; }
.user-guide-body a { color: #2563eb; text-decoration: none; }
.user-guide-body a:hover { text-decoration: underline; }
.user-guide-body strong { color: #111827; }
.user-guide-body code { background: #f3f4f6; color: #be185d; padding: 1px 6px; border-radius: 4px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; }
.user-guide-body pre { background: #0f172a; color: #e2e8f0; padding: 14px 16px; border-radius: 10px;
  overflow-x: auto; margin: 0.8em 0; font-size: 12.5px; line-height: 1.55; }
.user-guide-body pre code { background: transparent; color: inherit; padding: 0; font-size: inherit; }
.user-guide-body ul, .user-guide-body ol { margin: 0.5em 0 0.5em 1.4em; padding: 0; }
.user-guide-body li { margin: 0.25em 0; }
.user-guide-body blockquote { margin: 0.8em 0; padding: 8px 16px; background: #fef9c3;
  border-left: 4px solid #f59e0b; color: #78350f; border-radius: 0 8px 8px 0; }
.user-guide-body blockquote p { margin: 0.3em 0; }
.user-guide-body hr { border: none; border-top: 1px solid #e5e7eb; margin: 2em 0; }
.user-guide-body table { border-collapse: collapse; width: 100%; margin: 0.8em 0; font-size: 13px; }
.user-guide-body th, .user-guide-body td { border: 1px solid #e5e7eb; padding: 8px 12px; text-align: left; }
.user-guide-body th { background: #f9fafb; font-weight: 700; color: #374151; }
.user-guide-body td code { font-size: 12px; }
.user-guide-body img { max-width: 100%; }
`
