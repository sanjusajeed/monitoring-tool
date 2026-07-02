"""
Global dashboard endpoints — cross-tenant leaderboards.
Reads from MongoDB `app_insights` (populated by Lambda/log_analysis.py).
"""
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Query

from database import get_db
from timewindow import ist_day_window
from routers.temporal import workflow_counts_per_appid

router = APIRouter(prefix="/api/dashboard", tags=["Dashboard"])


WORKFLOW_PATH_PREFIXES = ("/workflow", "/platform/workflow")


def _parse_iso(s: Optional[str]) -> Optional[datetime]:
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None


def _env_key(raw: str) -> str:
    e = (raw or "").strip().lower()
    if e in ("production", "prod"):              return "prod"
    if e in ("development", "develop", "dev"):   return "dev"
    if e in ("staging", "stage"):                return "stage"
    return e or "unknown"


def _latest_per_group(docs: list[dict]) -> list[dict]:
    """Pick the most recent doc per (tenant_name, app_name, environment)."""
    best: dict[tuple, dict] = {}
    for d in docs:
        key = (
            d.get("tenant_name", ""),
            d.get("app_name", ""),
            _env_key(d.get("environment", "")),
        )
        cur = best.get(key)
        if not cur or (d.get("analyzed_at") or datetime.min) > (cur.get("analyzed_at") or datetime.min):
            best[key] = d
    return list(best.values())


def _parse_ts(v) -> Optional[datetime]:
    if isinstance(v, datetime):
        return v if v.tzinfo else v.replace(tzinfo=timezone.utc)
    if isinstance(v, str):
        try:
            dt = datetime.fromisoformat(v.replace("Z", "+00:00"))
            return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
        except ValueError:
            return None
    return None


def _windowed_metrics(d: dict, start_dt: Optional[datetime], end_dt: Optional[datetime]) -> dict:
    """Slice a doc's metrics down to the [start_dt, end_dt] window using its
    timeseries buckets. Falls back to the full snapshot when no window is set."""
    m = dict(d.get("metrics") or {})
    if not (start_dt and end_dt):
        return m
    ts = m.get("timeseries") or []
    in_window = []
    for p in ts:
        pdt = _parse_ts(p.get("ts"))
        if pdt and start_dt <= pdt <= end_dt:
            in_window.append(p)
    if not in_window:
        # No buckets in window — return zeroed metrics so the row contributes nothing
        m.update({
            "total_requests":   0,
            "error_4xx_count":  0,
            "error_5xx_count":  0,
            "error_rate_pct":   0,
            "latency_ms":       {"avg": None, "p50": None, "p95": None, "p99": None, "max": None},
            "workflow":         {"total_requests": 0, "error_count": 0, "success_count": 0, "error_rate_pct": 0},
            "timeseries":       [],
        })
        return m
    win_req = sum(int(p.get("requests") or 0) for p in in_window)
    win_err = sum(int(p.get("errors")   or 0) for p in in_window)
    p95s = [p.get("p95_latency_ms") for p in in_window if p.get("p95_latency_ms") is not None]
    avgs = [p.get("avg_latency_ms") for p in in_window if p.get("avg_latency_ms") is not None]
    # Split errors into 4xx/5xx using the snapshot's overall ratio
    full_4xx = int(m.get("error_4xx_count") or 0)
    full_5xx = int(m.get("error_5xx_count") or 0)
    full_err = full_4xx + full_5xx
    ratio_4xx = (full_4xx / full_err) if full_err else 0.5
    err_4xx = round(win_err * ratio_4xx)
    err_5xx = win_err - err_4xx
    # Scale workflow figures by the ratio of windowed/total requests (timeseries
    # doesn't carry a per-bucket workflow split, so this is the best we can do)
    full_req = int(m.get("total_requests") or 0)
    wf       = m.get("workflow") or {}
    scale    = (win_req / full_req) if full_req else 0
    win_wf_total  = round(int(wf.get("total_requests") or 0) * scale)
    win_wf_failed = round(int(wf.get("error_count")    or 0) * scale)
    win_wf_succ   = max(0, win_wf_total - win_wf_failed)
    m.update({
        "total_requests":  win_req,
        "error_4xx_count": err_4xx,
        "error_5xx_count": err_5xx,
        "error_rate_pct":  round((win_err / win_req * 100), 2) if win_req else 0,
        "latency_ms": {
            **(m.get("latency_ms") or {}),
            "p95": max(p95s) if p95s else (m.get("latency_ms") or {}).get("p95"),
            "avg": round(sum(avgs) / len(avgs), 2) if avgs else (m.get("latency_ms") or {}).get("avg"),
        },
        "workflow": {
            **wf,
            "total_requests":  win_wf_total,
            "error_count":     win_wf_failed,
            "success_count":   win_wf_succ,
            "error_rate_pct":  round((win_wf_failed / win_wf_total * 100), 2) if win_wf_total else 0,
        },
        "timeseries": in_window,
    })
    return m


@router.get("/leaderboards")
def global_leaderboards(
    env:      Optional[str] = Query(None, description="prod|uat|qa|dev|stage|demo — omit for all"),
    start:    Optional[str] = Query(None, description="ISO start"),
    end:      Optional[str] = Query(None, description="ISO end"),
    lw_start: Optional[str] = Query(None, description="ISO start override for large-file workflows"),
    lw_end:   Optional[str] = Query(None, description="ISO end override for large-file workflows"),
    limit: int           = Query(10, ge=1, le=50),
    min_requests: int    = Query(100, ge=0, description="Traffic floor for error-rate leaderboard"),
):
    """
    Returns cross-tenant rollups for the global dashboard.
    Filters: optional env + optional [start, end] on analyzed_at.
    """
    db = get_db()
    start_dt = _parse_iso(start)
    end_dt   = _parse_iso(end)
    # Default window: today-in-IST. Counters reset at 12:00 AM IST and
    # accumulate through the day. Explicit ?start/?end query params still win.
    if start_dt is None and end_dt is None:
        start_dt, end_dt = ist_day_window()

    # Pull only the latest snapshot per (tenant, app, env). Doing this in
    # MongoDB instead of `find({})` + Python avoids dragging the entire
    # historical app_insights collection (with timeseries arrays) over the
    # wire — that was the source of the 2-minute load.
    pipeline = [
        {"$sort": {"analyzed_at": -1}},
        {"$group": {
            "_id": {
                "tenant_name": "$tenant_name",
                "app_name":    "$app_name",
                "environment": "$environment",
            },
            "doc": {"$first": "$$ROOT"},
        }},
        {"$replaceRoot": {"newRoot": "$doc"}},
    ]
    raw_docs = list(db["app_insights"].aggregate(pipeline, allowDiskUse=True))
    # Safety: collapse case-variant envs (e.g. "Production" vs "prod").
    docs_all = _latest_per_group(raw_docs)

    # Compute windowed metrics ONCE per doc (env totals + rows both consume it).
    metrics_cache: dict[int, dict] = {id(d): _windowed_metrics(d, start_dt, end_dt) for d in docs_all}

    if env:
        wanted = _env_key(env)
        docs = [d for d in docs_all if _env_key(d.get("environment", "")) == wanted]
    else:
        docs = docs_all

    # ── Build per-row metrics ──────────────────────────────────────────────
    # Workflow counts (total + failed) come from the SAME correlationId-based
    # source that the Tenant & Apps page uses (Lambda-pre-computed
    # `metrics.workflow_total` + `workflow_executions.executions[]`). Doing
    # this here keeps the two pages in sync — the Dashboard previously used
    # HTTP `/workflow*` path counts, which is a different metric entirely.
    rows = []
    for d in docs:
        m = metrics_cache[id(d)]
        wf = m.get("workflow") or {}
        total_req   = int(m.get("total_requests")    or 0)
        total_4xx   = int(m.get("error_4xx_count")   or 0)
        total_5xx   = int(m.get("error_5xx_count")   or 0)
        total_err   = total_4xx + total_5xx
        # HTTP-path workflow counts — used ONLY for the API split (same way
        # Tenant & Apps does it via _aggregate_metrics). The visible workflow
        # columns are overridden below from workflow_counts_per_appid.
        wf_http_total  = int(wf.get("total_requests") or 0)
        wf_http_failed = int(wf.get("error_count")    or 0)
        api_total   = max(0, total_req - wf_http_total)
        api_failed  = max(0, total_err - wf_http_failed)
        p95         = (m.get("latency_ms") or {}).get("p95")
        avg_lat     = (m.get("latency_ms") or {}).get("avg")
        err_rate    = (total_err / total_req * 100) if total_req else 0
        rows.append({
            "tenant":        d.get("tenant_name", ""),
            "app":           d.get("app_name", ""),
            "environment":   d.get("environment", ""),
            "env_key":       _env_key(d.get("environment", "")),
            "inst_id":       d.get("inst_id") or "",
            "health_score":  m.get("health_score"),
            "total_requests": total_req,
            "total_errors":  total_err,
            "error_rate_pct": round(err_rate, 2),
            # Placeholders — overwritten below from workflow_counts_per_appid
            "workflow_total":   0,
            "workflow_failed":  0,
            "workflow_error_rate_pct": wf.get("error_rate_pct"),
            "api_total":     api_total,
            "api_failed":    api_failed,
            "api_error_rate_pct": round((api_failed / api_total * 100), 2) if api_total else 0,
            "p95_latency_ms": p95,
            "avg_latency_ms": avg_lat,
            "analyzed_at":   d.get("analyzed_at"),
            "pod_stats":     m.get("pod_stats") or [],
        })

    # Override workflow_total / workflow_failed per row with the Temporal-
    # correlationId-based counts so this page matches Tenant & Apps exactly.
    # Query spans every inst_id in docs_all (not just env-filtered rows) so
    # env_totals below can use the same per_app_wf map for its rollup.
    all_inst_ids = sorted({d.get("inst_id") for d in docs_all if d.get("inst_id")})
    wf_window_start = (start_dt or ist_day_window()[0]).isoformat()
    wf_window_end   = (end_dt   or ist_day_window()[1]).isoformat()
    per_app_wf = workflow_counts_per_appid(
        all_inst_ids, start_iso=wf_window_start, end_iso=wf_window_end,
    ) if all_inst_ids else {}
    for r in rows:
        wfc = per_app_wf.get(r["inst_id"]) or {}
        wt = int(wfc.get("total")  or 0)
        wff = int(wfc.get("failed") or 0)
        r["workflow_total"]  = wt
        r["workflow_failed"] = wff
        r["workflow_error_rate_pct"] = round((wff / wt * 100), 2) if wt else 0

    # ── Leaderboards ───────────────────────────────────────────────────────
    by_workflow = sorted(
        [r for r in rows if r["workflow_failed"] > 0],
        key=lambda r: r["workflow_failed"], reverse=True,
    )[:limit]
    by_api = sorted(
        [r for r in rows if r["api_failed"] > 0],
        key=lambda r: r["api_failed"], reverse=True,
    )[:limit]
    by_latency = sorted(
        [r for r in rows if r["p95_latency_ms"] is not None],
        key=lambda r: r["p95_latency_ms"] or 0, reverse=True,
    )[:limit]
    by_err_rate = sorted(
        [r for r in rows if r["total_requests"] >= min_requests],
        key=lambda r: r["error_rate_pct"], reverse=True,
    )[:limit]

    # ── Environment totals (always compute across all envs, pre-env-filter) ─
    env_totals: dict[str, dict] = defaultdict(lambda: {
        "requests": 0, "errors": 0, "workflow_failed": 0, "apps": 0,
    })
    for d in docs_all:
        m = metrics_cache[id(d)]
        ek = _env_key(d.get("environment", ""))
        env_totals[ek]["requests"]        += int(m.get("total_requests") or 0)
        env_totals[ek]["errors"]          += int(m.get("error_4xx_count") or 0) + int(m.get("error_5xx_count") or 0)
        # Use the Temporal-correlationId source (same as the tenant tiles)
        # rather than HTTP-path workflow failures so the env breakdown stays
        # consistent with the rest of the page.
        wfc = per_app_wf.get(d.get("inst_id") or "") or {}
        env_totals[ek]["workflow_failed"] += int(wfc.get("failed") or 0)
        env_totals[ek]["apps"]            += 1
    by_env_totals = [
        {"env": k, **v, "error_rate_pct": round(v["errors"] / v["requests"] * 100, 2) if v["requests"] else 0}
        for k, v in env_totals.items()
    ]
    by_env_totals.sort(key=lambda x: x["requests"], reverse=True)

    # ── Tenant grid with top contributing apps ─────────────────────────────
    by_tenant: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        by_tenant[r["tenant"]].append(r)
    tenants = []
    for name, apps in by_tenant.items():
        total_req = sum(a["total_requests"] for a in apps)
        total_err = sum(a["total_errors"]   for a in apps)
        wf_total  = sum(a.get("workflow_total", 0)  for a in apps)
        wf_failed = sum(a.get("workflow_failed", 0) for a in apps)
        scores = [a["health_score"] for a in apps if a["health_score"] is not None]
        avg_health = round(sum(scores) / len(scores), 1) if scores else None
        top_apps = sorted(apps, key=lambda a: a["total_errors"], reverse=True)[:5]
        tenants.append({
            "tenant":          name,
            "app_count":       len(apps),
            "total_requests":  total_req,
            "total_errors":    total_err,
            "error_rate_pct":  round(total_err / total_req * 100, 2) if total_req else 0,
            "workflow_total":  wf_total,
            "workflow_failed": wf_failed,
            "avg_health_score": avg_health,
            "top_apps":        [
                {
                    "app": a["app"], "environment": a["environment"],
                    "env_key": a["env_key"],
                    "total_requests": a["total_requests"],
                    "total_errors": a["total_errors"],
                    "error_rate_pct": a["error_rate_pct"],
                    "workflow_total":  a.get("workflow_total", 0),
                    "workflow_failed": a.get("workflow_failed", 0),
                    "p95_latency_ms": a["p95_latency_ms"],
                } for a in top_apps
            ],
        })
    tenants.sort(key=lambda t: t["total_errors"], reverse=True)

    # ── Pod leaderboards: aggregate across app docs ────────────────────────
    # Each pod_stat is already per-pod within a single app — collect globally,
    # tagging each pod occurrence with its (tenant, app, env).
    pod_agg: dict[tuple, dict] = {}
    for r in rows:
        for p in r["pod_stats"]:
            key = (p.get("pod") or "", p.get("namespace") or "")
            cur = pod_agg.get(key)
            owner_entry = {
                "tenant": r["tenant"], "app": r["app"],
                "environment": r["environment"], "env_key": r["env_key"],
                "requests": int(p.get("requests") or 0),
                "errors":   int(p.get("errors")   or 0),
            }
            if not cur:
                pod_agg[key] = {
                    "pod":            p.get("pod"),
                    "namespace":      p.get("namespace"),
                    "requests":       int(p.get("requests") or 0),
                    "errors":         int(p.get("errors")   or 0),
                    "errors_4xx":     int(p.get("errors_4xx") or 0),
                    "errors_5xx":     int(p.get("errors_5xx") or 0),
                    "p95_latency_ms": p.get("p95_latency_ms"),
                    "avg_latency_ms": p.get("avg_latency_ms"),
                    "owners":         [owner_entry],
                }
            else:
                cur["requests"]   += int(p.get("requests") or 0)
                cur["errors"]     += int(p.get("errors")   or 0)
                cur["errors_4xx"] += int(p.get("errors_4xx") or 0)
                cur["errors_5xx"] += int(p.get("errors_5xx") or 0)
                # Keep max p95 across overlaps
                if p.get("p95_latency_ms") and (cur["p95_latency_ms"] is None or p["p95_latency_ms"] > cur["p95_latency_ms"]):
                    cur["p95_latency_ms"] = p["p95_latency_ms"]
                cur["owners"].append(owner_entry)

    pod_list = []
    for p in pod_agg.values():
        p["error_rate_pct"] = round(p["errors"] / p["requests"] * 100, 2) if p["requests"] else 0
        pod_list.append(p)

    by_pod_failures = sorted(
        [p for p in pod_list if p["errors"] > 0],
        key=lambda p: p["errors"], reverse=True,
    )[:limit]
    by_pod_latency = sorted(
        [p for p in pod_list if p.get("p95_latency_ms") is not None],
        key=lambda p: p["p95_latency_ms"] or 0, reverse=True,
    )[:limit]

    # ── Global totals ──────────────────────────────────────────────────────
    global_totals = {
        "tenants":       len(by_tenant),
        "apps":          len(rows),
        "total_requests": sum(r["total_requests"] for r in rows),
        "total_errors":   sum(r["total_errors"]   for r in rows),
        "workflow_failed": sum(r["workflow_failed"] for r in rows),
    }
    global_totals["error_rate_pct"] = round(
        global_totals["total_errors"] / global_totals["total_requests"] * 100, 2
    ) if global_totals["total_requests"] else 0

    # Latest analyzer run timestamp (across every snapshot, regardless of env/window)
    last_analyzed_at = None
    for d in docs_all:
        ts = d.get("analyzed_at")
        if ts and (last_analyzed_at is None or ts > last_analyzed_at):
            last_analyzed_at = ts

    # Large file workflows (populated by the K8s CronJob detector). Tight read —
    # single indexed find limited to 50 rows, costs ~10 ms even on a slow Mongo.
    settings_doc = db["monitoring_settings"].find_one({"_id": "large_workflow_detector"}) or {}
    threshold_bytes = int(settings_doc.get("threshold_bytes") or 30_000_000)
    # lw_start/lw_end let the frontend pass a narrower window for large-file
    # workflows independently of the main date range (e.g. cap at "Today" even
    # when the rest of the dashboard shows 7d/30d).
    lw_start_dt = _parse_iso(lw_start) or start_dt
    lw_end_dt   = _parse_iso(lw_end)   or end_dt
    lw_query: dict = {}
    if lw_start_dt and lw_end_dt:
        lw_query["analyzed_at"] = {"$gte": lw_start_dt.isoformat(), "$lte": lw_end_dt.isoformat()}
    large_file_workflows = []
    for r in (
        db["large_file_workflows"]
        .find(lw_query)
        .sort([("history_size_bytes", -1)])
        .limit(50)
    ):
        r["id"] = str(r.pop("_id"))
        large_file_workflows.append(r)

    # App publish / app start failures from Temporal (default namespace).
    # Live query, cached server-side for 60 s per (start, end). Honors the same
    # date filter as the rest of the Dashboard — "Today" = 12 AM IST → now,
    # because `start_dt` / `end_dt` are resolved by `ist_day_window()` above
    # when no explicit range is passed. Wrapped in try so a Temporal outage
    # never breaks the dashboard.
    _start_iso = start_dt.strftime("%Y-%m-%dT%H:%M:%SZ") if start_dt else None
    _end_iso   = end_dt.strftime("%Y-%m-%dT%H:%M:%SZ")   if end_dt   else None
    app_lifecycle = {"failures": [], "fetched_at": None, "start": _start_iso, "end": _end_iso}
    try:
        from routers.temporal import fetch_app_lifecycle_failures
        app_lifecycle = fetch_app_lifecycle_failures(start_iso=_start_iso, end_iso=_end_iso)
    except Exception:
        pass

    return {
        "env_filter":          env,
        "global_totals":       global_totals,
        "last_analyzed_at":    last_analyzed_at,
        "by_workflow_failures": by_workflow,
        "by_api_failures":     by_api,
        "by_latency":          by_latency,
        "by_error_rate":       by_err_rate,
        "by_env_totals":       by_env_totals,
        "tenants":             tenants,
        "by_pod_failures":     by_pod_failures,
        "by_pod_latency":      by_pod_latency,
        "large_file_workflows":         large_file_workflows,
        "large_file_threshold_bytes":   threshold_bytes,
        "large_file_last_run_at":       settings_doc.get("last_run_at"),
        "large_file_last_match_count":  settings_doc.get("last_match_count"),
        "app_lifecycle_failures":       app_lifecycle.get("failures", []),
        "app_lifecycle_fetched_at":     app_lifecycle.get("fetched_at"),
        "app_lifecycle_start":          app_lifecycle.get("start"),
        "app_lifecycle_end":            app_lifecycle.get("end"),
    }


@router.get("/fleet-timeseries")
def fleet_timeseries(
    env:   str = Query("",   description="prod|uat|qa|dev|demo — empty for all"),
    hours: int = Query(24,   ge=1, le=24 * 30, description="Look-back window in hours"),
):
    """Return hourly fleet-wide request/error totals aggregated across all apps.
    Used by the Fleet Traffic area chart on the dashboard."""
    db = get_db()
    now = datetime.now(timezone.utc)
    window_start = now - timedelta(hours=hours)
    # Use 1-hour buckets for ≤24h, 6-hour for ≤7d, 24-hour for wider ranges
    bucket_hours = 1 if hours <= 24 else (6 if hours <= 168 else 24)
    wanted_env = _env_key(env) if env else None

    # Pull latest snapshot per (tenant, app, env) — same pattern as leaderboards
    # but project only what we need to keep it lean.
    pipeline = [
        {"$sort": {"analyzed_at": -1}},
        {"$group": {
            "_id": {
                "tenant_name": "$tenant_name",
                "app_name":    "$app_name",
                "environment": "$environment",
            },
            "doc": {"$first": "$$ROOT"},
        }},
        {"$replaceRoot": {"newRoot": "$doc"}},
        {"$project": {"metrics.timeseries": 1, "environment": 1}},
    ]
    raw_docs = list(db["app_insights"].aggregate(pipeline, allowDiskUse=True))

    bucket_totals: dict[str, dict] = {}
    for d in raw_docs:
        doc_env = _env_key(d.get("environment", ""))
        if wanted_env and doc_env != wanted_env:
            continue
        ts_list = (d.get("metrics") or {}).get("timeseries") or []
        for point in ts_list:
            pt = _parse_ts(point.get("ts"))
            if pt is None or pt < window_start:
                continue
            bucket_h = (pt.hour // bucket_hours) * bucket_hours
            bucket_ts = pt.replace(hour=bucket_h, minute=0, second=0, microsecond=0)
            key = bucket_ts.isoformat()
            if key not in bucket_totals:
                bucket_totals[key] = {"requests": 0, "errors": 0}
            bucket_totals[key]["requests"] += int(point.get("requests") or 0)
            bucket_totals[key]["errors"]   += int(point.get("errors")   or 0)

    buckets = []
    for ts_key in sorted(bucket_totals):
        req = bucket_totals[ts_key]["requests"]
        err = bucket_totals[ts_key]["errors"]
        buckets.append({
            "ts":             ts_key,
            "requests":       req,
            "errors":         err,
            "error_rate_pct": round(err / req * 100, 2) if req else 0,
        })

    return {"buckets": buckets, "env": env or "all", "hours": hours}
