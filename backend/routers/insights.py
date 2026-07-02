import json
import os
import re
from datetime import datetime, timezone, timedelta

import anthropic
from fastapi import APIRouter, HTTPException, Query
from opensearchpy import OpenSearch
from config import get_config
from database import get_db
from timewindow import ist_day_window, parse_iso_to_utc
from routers.temporal import workflow_counts_per_appid

router = APIRouter(prefix="/api/insights", tags=["Insights"])


# ─── Catalog cache (tenants + inst_id→tenant) ────────────────────────────────
# `distinct("tenant_name")` on the tenant_insights collection and the
# `$group` on app_insights are both expensive (the former was clocking ~4.7 s
# on a remote Mongo; the latter ~750 ms). Neither changes more than once per
# Lambda run (every 30 min when a new tenant or app appears). Cache both
# locally for a few minutes so the Tenant & Apps page doesn't pay for them
# on every click.
_CATALOG_TTL = 300.0  # 5 minutes
_catalog_cache: dict = {"ts": 0.0, "tenants": None, "inst_map": None}


def _cached_catalog(db) -> tuple[list[str], dict[str, str]]:
    """Return (sorted tenant names, inst_id → tenant map) with TTL caching."""
    import time as _t
    now = _t.time()
    if (
        _catalog_cache["tenants"] is not None
        and _catalog_cache["inst_map"] is not None
        and (now - _catalog_cache["ts"]) < _CATALOG_TTL
    ):
        age = now - _catalog_cache["ts"]
        print(
            f"    └ catalog cache HIT (age {age:.1f} s / TTL {_CATALOG_TTL:.0f} s) "
            f"→ {len(_catalog_cache['tenants'])} tenants, {len(_catalog_cache['inst_map'])} apps",
            flush=True,
        )
        return _catalog_cache["tenants"], _catalog_cache["inst_map"]

    print(f"    └ catalog cache MISS — querying Mongo", flush=True)
    t0 = _t.perf_counter()
    tenants = sorted(db["tenant_insights"].distinct("tenant_name"))
    print(
        f"      • tenant_insights.distinct(tenant_name) → {len(tenants)} tenants "
        f"in {(_t.perf_counter()-t0)*1000:.0f} ms",
        flush=True,
    )

    t0 = _t.perf_counter()
    inst_map: dict[str, str] = {}
    for d in db["app_insights"].aggregate([
        {"$group": {"_id": {"tenant": "$tenant_name", "inst_id": "$inst_id"}}}
    ]):
        iid = d["_id"].get("inst_id")
        tn  = d["_id"].get("tenant")
        if iid and tn:
            inst_map[iid] = tn
    print(
        f"      • app_insights.aggregate(group tenant+inst_id) → {len(inst_map)} apps "
        f"in {(_t.perf_counter()-t0)*1000:.0f} ms",
        flush=True,
    )

    _catalog_cache["tenants"]  = tenants
    _catalog_cache["inst_map"] = inst_map
    _catalog_cache["ts"]       = now
    return tenants, inst_map


def _os_client():
    cfg = get_config()["opensearch"]
    host = cfg["host"]
    for prefix in ("https://", "http://"):
        if host.startswith(prefix):
            host = host[len(prefix):]
    return OpenSearch(
        hosts=[{"host": host.rstrip("/"), "port": cfg.get("port", 443)}],
        http_auth=(cfg.get("username"), cfg.get("password")),
        use_ssl=cfg.get("use_ssl", True),
        verify_certs=cfg.get("verify_certs", True),
        headers={"securitytenant": "global"},
        timeout=30,
    )


def _serialize(doc: dict) -> dict:
    doc["id"] = str(doc.pop("_id"))
    # Stringify any leftover ObjectId values in nested lists
    if "app_insight_ids" in doc:
        doc["app_insight_ids"] = [str(i) for i in doc["app_insight_ids"]]
    return doc


def _aggregate_metrics(docs: list[dict]) -> dict:
    """Sum the per-doc metrics across an IST-day window of insight runs.

    Each Lambda run writes a fresh doc covering its 30-min slice; today's
    counters are the sum across all docs whose analyzed_at >= IST-midnight.
    `health_score` is a snapshot, so we keep the latest doc's value rather
    than summing.
    """
    wf_total = total_req = total_5xx = total_4xx = wf_failed = 0
    latest_health = None
    for d in docs:
        m = d.get("metrics") or {}
        wf_t = m.get("total_workflow_requests") or 0
        wf_r = m.get("workflow_error_rate_pct") or 0
        wf_total += wf_t
        wf_failed += round(wf_t * wf_r / 100)
        total_req += m.get("total_requests") or 0
        total_5xx += m.get("total_5xx") or 0
        total_4xx += m.get("total_4xx") or 0
        if latest_health is None and m.get("health_score") is not None:
            latest_health = m.get("health_score")
    wf_success = max(0, wf_total - wf_failed)
    api_total = max(0, total_req - wf_total)
    api_failed = max(0, (total_5xx + total_4xx) - wf_failed)
    api_success = max(0, api_total - api_failed)
    overall_err = (
        round((total_5xx + total_4xx) / total_req * 100, 2) if total_req else 0
    )
    return {
        "total_workflow_requests": wf_total,
        "workflow_failed":         wf_failed,
        "workflow_success":        wf_success,
        "total_requests":          total_req,
        "total_5xx":               total_5xx,
        "total_4xx":               total_4xx,
        "api_total":               api_total,
        "api_failed":              api_failed,
        "api_success":             api_success,
        "overall_error_rate_pct":  overall_err,
        "health_score":            latest_health,
    }


@router.get("/tenants")
def list_tenants():
    """Distinct tenant names that have at least one insight run."""
    db = get_db()
    tenants = sorted(db["tenant_insights"].distinct("tenant_name"))
    return {"tenants": tenants}


@router.get("/summary")
def get_all_tenant_summaries(
    start: str | None = Query(None, description="ISO start. Default: today 12:00 AM IST"),
    end:   str | None = Query(None, description="ISO end. Default: now"),
):
    """Summary row for every tenant — used by the tenant list page.

    Window defaults to today-in-IST (counters reset at 12:00 AM IST). Pass
    explicit ISO `start` and `end` to scope to any other range — used by the
    "Last 1 hour" / "Last 24 hours" presets on the Tenant & Apps page.
    Tenants with no docs in window still appear (with zero counters) so the
    page never goes empty; analyzed_at falls back to their most recent run
    so the ANALYZED column shows when the last data arrived.
    """
    import time as _t
    from datetime import timezone, timedelta
    t_start = _t.perf_counter()
    db = get_db()
    start_dt = parse_iso_to_utc(start)
    end_dt   = parse_iso_to_utc(end)
    explicit = bool(start_dt or end_dt)
    if start_dt is None and end_dt is None:
        start_utc, end_utc = ist_day_window()
    else:
        default_start, default_end = ist_day_window()
        start_utc = start_dt or default_start
        end_utc   = end_dt   or default_end
    start_iso = start_utc.isoformat()
    end_iso   = end_utc.isoformat()
    # Also display in IST for human readability
    IST = timezone(timedelta(hours=5, minutes=30))
    span_min = (end_utc - start_utc).total_seconds() / 60.0
    print(
        f"  [/summary] window UTC: {start_iso} → {end_iso}\n"
        f"  [/summary] window IST: {start_utc.astimezone(IST).strftime('%Y-%m-%d %H:%M')} → "
        f"{end_utc.astimezone(IST).strftime('%Y-%m-%d %H:%M')}  "
        f"(span: {span_min:.0f} min, source: {'explicit query param' if explicit else 'default IST-day'})",
        flush=True,
    )

    t0 = _t.perf_counter()
    tenants, inst_id_to_tenant = _cached_catalog(db)
    print(
        f"  [/summary] steps 1+2: catalog (tenants={len(tenants)}, apps={len(inst_id_to_tenant)}) "
        f"in {(_t.perf_counter()-t0)*1000:.0f} ms",
        flush=True,
    )

    t0 = _t.perf_counter()
    per_app_counts = workflow_counts_per_appid(
        list(inst_id_to_tenant.keys()),
        start_iso=start_iso,
        end_iso=end_iso,
    )
    print(f"  [/summary] step 3: workflow_counts_per_appid (OpenSearch + Mongo failed) in {(_t.perf_counter()-t0)*1000:.0f} ms", flush=True)

    tenant_wf: dict[str, dict] = {}
    for iid, c in per_app_counts.items():
        tn = inst_id_to_tenant.get(iid)
        if not tn:
            continue
        bucket = tenant_wf.setdefault(tn, {"total": 0, "failed": 0, "completed": 0})
        bucket["total"]     += c.get("total", 0)
        bucket["failed"]    += c.get("failed", 0)
        bucket["completed"] += c.get("completed", 0)

    # Batch the per-tenant tenant_insights query into ONE round-trip instead
    # of 22 sequential find()/find_one() calls. Projection limits the doc
    # payload to ONLY the fields _aggregate_metrics + this handler actually
    # read — the full `insights` blob and any other big nested fields stay
    # on the server (cuts ~10× off the wire payload on busy tenants).
    PROJ = {
        "tenant_name":                     1,
        "analyzed_at":                     1,
        "app_count":                       1,
        "metrics.total_requests":          1,
        "metrics.total_4xx":               1,
        "metrics.total_5xx":               1,
        "metrics.total_workflow_requests": 1,
        "metrics.workflow_error_rate_pct": 1,
        "metrics.health_score":            1,
    }

    t0 = _t.perf_counter()
    by_tenant: dict[str, list[dict]] = {}
    for d in (
        db["tenant_insights"]
        .find({
            "tenant_name": {"$in": tenants},
            "analyzed_at": {"$gte": start_iso, "$lte": end_iso},
        }, PROJ)
        .sort([("tenant_name", 1), ("analyzed_at", -1)])
    ):
        by_tenant.setdefault(d["tenant_name"], []).append(d)

    # Fallback "latest doc ever" for tenants with no docs in window. One
    # aggregation instead of N find_one round-trips. Same projection.
    missing = [t for t in tenants if t not in by_tenant]
    fallback_latest: dict[str, dict] = {}
    if missing:
        for d in db["tenant_insights"].aggregate([
            {"$match":   {"tenant_name": {"$in": missing}}},
            {"$sort":    {"analyzed_at": -1}},
            {"$group":   {"_id": "$tenant_name", "doc": {"$first": "$$ROOT"}}},
            {"$project": {"_id": 1,
                          "doc.tenant_name": 1, "doc.analyzed_at": 1, "doc.app_count": 1,
                          "doc.metrics.total_requests": 1, "doc.metrics.total_4xx": 1,
                          "doc.metrics.total_5xx": 1, "doc.metrics.total_workflow_requests": 1,
                          "doc.metrics.workflow_error_rate_pct": 1, "doc.metrics.health_score": 1}},
        ]):
            fallback_latest[d["_id"]] = d.get("doc") or {}
    print(f"  [/summary] step 4a: batched fetch (window={len(by_tenant)}, fallback={len(fallback_latest)}) in {(_t.perf_counter()-t0)*1000:.0f} ms", flush=True)

    t0 = _t.perf_counter()
    rows = []
    for name in tenants:
        in_window = by_tenant.get(name, [])
        latest = in_window[0] if in_window else fallback_latest.get(name)
        if not latest:
            continue
        agg = _aggregate_metrics(in_window)
        app_count = latest.get("app_count", 0)
        wf = tenant_wf.get(name, {"total": 0, "failed": 0, "completed": 0})
        rows.append({
            "tenant_name":   name,
            "analyzed_at":   latest.get("analyzed_at"),
            "app_count":     app_count,
            "health_score":  agg["health_score"],
            "total_requests": agg["total_requests"],
            "workflow": {
                "total":   wf["total"],
                "success": wf["completed"],
                "failed":  wf["failed"],
            },
            "api": {
                "total":   agg["api_total"],
                "success": agg["api_success"],
                "failed":  agg["api_failed"],
            },
            "error_rate_pct": agg["overall_error_rate_pct"],
        })
    print(f"  [/summary] step 4b: build rows ({len(rows)}) in {(_t.perf_counter()-t0)*1000:.0f} ms", flush=True)

    # Per-row summary — sorted by total HTTP requests descending so the
    # busiest tenants surface at the top of the log.
    top_rows = sorted(rows, key=lambda r: -(r["total_requests"] or 0))
    print(f"  [/summary] response: {len(rows)} tenant rows", flush=True)
    for r in top_rows[:5]:
        print(
            f"    • {r['tenant_name']:<22} apps={r['app_count']}  "
            f"req={r['total_requests']}  err={r['error_rate_pct']}%  "
            f"wf={r['workflow']['success']}/{r['workflow']['total']} (failed {r['workflow']['failed']})  "
            f"api={r['api']['success']}/{r['api']['total']} (failed {r['api']['failed']})  "
            f"health={r['health_score']}",
            flush=True,
        )
    if len(rows) > 5:
        print(f"    • ... and {len(rows) - 5} more tenants (rendered top 5 by traffic)", flush=True)

    # Aggregate sanity check
    tot_req = sum(r["total_requests"] or 0 for r in rows)
    tot_wf  = sum(r["workflow"]["total"]  for r in rows)
    tot_wff = sum(r["workflow"]["failed"] for r in rows)
    tot_api = sum(r["api"]["total"]  for r in rows)
    tot_apf = sum(r["api"]["failed"] for r in rows)
    print(
        f"  [/summary] grand totals: req={tot_req}  "
        f"workflows={tot_wf} (failed {tot_wff})  api={tot_api} (failed {tot_apf})",
        flush=True,
    )
    print(f"  [/summary] TOTAL: {(_t.perf_counter()-t_start)*1000:.0f} ms", flush=True)
    return {"tenants": rows}


@router.get("/{tenant_name}")
def get_tenant_insight(tenant_name: str):
    """Today-in-IST tenant-level insight for the given tenant.

    Aggregates every tenant_insights doc since 12:00 AM IST. Falls back to
    the most recent doc when the IST window is empty so the tenant detail
    page still loads in the early morning.
    """
    db = get_db()
    start_utc, _ = ist_day_window()
    start_iso = start_utc.isoformat()

    in_window = list(
        db["tenant_insights"]
        .find({"tenant_name": tenant_name, "analyzed_at": {"$gte": start_iso}})
        .sort("analyzed_at", -1)
    )
    latest = in_window[0] if in_window else db["tenant_insights"].find_one(
        {"tenant_name": tenant_name}, sort=[("analyzed_at", -1)]
    )
    if not latest:
        raise HTTPException(status_code=404, detail="No insights found for this tenant")

    agg = _aggregate_metrics(in_window)
    base_metrics = dict(latest.get("metrics") or {})
    base_metrics.update({
        "total_workflow_requests": agg["total_workflow_requests"],
        "workflow_error_rate_pct": (
            round(agg["workflow_failed"] / agg["total_workflow_requests"] * 100, 2)
            if agg["total_workflow_requests"] else 0
        ),
        "total_requests":          agg["total_requests"],
        "total_5xx":               agg["total_5xx"],
        "total_4xx":               agg["total_4xx"],
        "overall_error_rate_pct":  agg["overall_error_rate_pct"],
        "health_score":            agg["health_score"],
    })
    flat_app_ids: list = []
    for d in in_window:
        flat_app_ids.extend(d.get("app_insight_ids") or [])

    synth = {
        "_id":              latest["_id"],
        "tenant_name":      tenant_name,
        "analyzed_at":      latest.get("analyzed_at"),
        "app_count":        latest.get("app_count", 0),
        "app_names":        latest.get("app_names", []),
        "app_insight_ids":  flat_app_ids,
        "metrics":          base_metrics,
        "insights":         latest.get("insights"),
        "timeframe":        {
            "start": start_iso,
            "end":   datetime.now(timezone.utc).isoformat(),
        },
    }
    return _serialize(synth)


@router.get("/{tenant_name}/apps/{app_name}")
def get_app_detail(
    tenant_name: str,
    app_name: str,
    limit: int = 20,
    start: str = Query(None, description="ISO start filter on analyzed_at"),
    end:   str = Query(None, description="ISO end filter on analyzed_at"),
):
    """Insight runs for a specific app, newest first.

    When `start`/`end` are provided we return every doc whose `analyzed_at`
    falls in the window (no `limit` cap), so the AppDetailPage can aggregate
    across an arbitrary date range. Without those params we fall back to the
    most recent `limit` docs — used by code paths that just need the latest
    snapshot per environment.
    """
    db = get_db()
    q: dict = {"tenant_name": tenant_name, "app_name": app_name}
    if start and end:
        q["analyzed_at"] = {"$gte": start, "$lte": end}
        cursor = db["app_insights"].find(q).sort("analyzed_at", -1)
    else:
        cursor = (
            db["app_insights"].find(q)
            .sort("analyzed_at", -1)
            .limit(limit)
        )
    docs = list(cursor)
    if not docs:
        # Empty window is a normal, expected state (e.g. user picked a date
        # range with no analyzed runs). Return [] rather than 404 so the
        # frontend can render zeros instead of an error state.
        if start and end:
            return []
        raise HTTPException(status_code=404, detail="No insights found for this app")
    return [_serialize(doc) for doc in docs]


@router.get("/{tenant_name}/apps")
def get_app_insights(
    tenant_name: str,
    start: str | None = Query(None, description="ISO start. Default: today 12:00 AM IST"),
    end:   str | None = Query(None, description="ISO end. Default: now"),
):
    """Per-app insight record for each app in this tenant.

    Window defaults to today-in-IST. Pass explicit ISO `start`/`end` to scope
    to any other range (used by the "Last 1 hour" / "Today" toggle on the
    Applications-in-tenant page). Falls back to the most recent doc per app
    when the window has no docs so the page still loads.
    """
    db = get_db()
    start_dt = parse_iso_to_utc(start)
    end_dt   = parse_iso_to_utc(end)
    if start_dt is None and end_dt is None:
        start_utc, end_utc = ist_day_window()
    else:
        default_start, default_end = ist_day_window()
        start_utc = start_dt or default_start
        end_utc   = end_dt   or default_end
    start_iso = start_utc.isoformat()
    end_iso   = end_utc.isoformat()

    app_names = db["app_insights"].distinct("app_name", {"tenant_name": tenant_name})
    if not app_names:
        raise HTTPException(status_code=404, detail="No insights found for this tenant")

    # Per-inst_id Temporal-backed workflow counts for the window, sourced
    # from OpenSearch correlationId logs (Temporal itself has no tenant
    # scoping). Computed once for the whole tenant.
    tenant_inst_ids = [
        i for i in db["app_insights"].distinct("inst_id", {"tenant_name": tenant_name})
        if i
    ]
    wf_counts_by_inst = workflow_counts_per_appid(
        tenant_inst_ids, start_iso=start_iso, end_iso=end_iso,
    )

    out = []
    for name in app_names:
        in_window = list(
            db["app_insights"]
            .find({
                "tenant_name": tenant_name,
                "app_name":    name,
                "analyzed_at": {"$gte": start_iso, "$lte": end_iso},
            })
            .sort("analyzed_at", -1)
        )
        latest = in_window[0] if in_window else db["app_insights"].find_one(
            {"tenant_name": tenant_name, "app_name": name},
            sort=[("analyzed_at", -1)],
        )
        if not latest:
            continue

        agg = _aggregate_metrics(in_window)
        base_metrics = dict(latest.get("metrics") or {})
        base_metrics.update({
            "total_workflow_requests": agg["total_workflow_requests"],
            "workflow_error_rate_pct": (
                round(agg["workflow_failed"] / agg["total_workflow_requests"] * 100, 2)
                if agg["total_workflow_requests"] else 0
            ),
            "total_requests":          agg["total_requests"],
            "total_5xx":               agg["total_5xx"],
            "total_4xx":               agg["total_4xx"],
            "overall_error_rate_pct":  agg["overall_error_rate_pct"],
            "health_score":            agg["health_score"],
        })
        # Temporal workflow counts for THIS app's inst_id (OpenSearch-derived).
        wfc = wf_counts_by_inst.get(latest.get("inst_id") or "", {})
        base_metrics["workflow_total"]  = wfc.get("total", 0)
        base_metrics["workflow_failed"] = wfc.get("failed", 0)

        synth = dict(latest)
        synth["metrics"] = base_metrics
        out.append(_serialize(synth))
    return out


@router.get("/{tenant_name}/apps/{app_name}/executions")
def get_app_executions(
    tenant_name: str,
    app_name: str,
    limit: int = 20,
    offset: int = 0,
    status: str = "",
    search: str = Query("", description="Search by process name or workflow ID"),
    start: str = Query(None, description="ISO start date filter for execution start_time"),
    end: str = Query(None, description="ISO end date filter for execution start_time"),
):
    """Workflow execution history stored from the last analysis run."""
    db = get_db()
    docs = list(
        db["workflow_executions"].find(
            {"tenant_name": tenant_name, "app_name": app_name}
        ).sort("analyzed_at", -1)
    )
    if not docs:
        raise HTTPException(status_code=404, detail="No execution data found for this app")

    # Merge executions from all environments, tagging each with its environment label
    all_executions = []
    total_failed = 0
    total_running = 0
    total_completed = 0
    latest_analyzed_at = None

    for d in docs:
        env = str(d.get("environment") or "").strip()
        summary = d.get("summary") or {}
        analyzed_at = d.get("analyzed_at")
        if analyzed_at and (latest_analyzed_at is None or analyzed_at > latest_analyzed_at):
            latest_analyzed_at = analyzed_at
        for exe in (d.get("executions") or []):
            all_executions.append({**exe, "environment": env})

    # Date-range filter on start_time
    if start and end:
        filtered = []
        for exe in all_executions:
            st = exe.get("start_time") or ""
            if isinstance(st, str) and st:
                if start <= st <= end:
                    filtered.append(exe)
            else:
                filtered.append(exe)
        all_executions = filtered

    # Search filter — match process_name, workflow_name, or workflow_id (case-insensitive)
    if search:
        q = search.lower()
        all_executions = [
            e for e in all_executions
            if q in str(e.get("process_name", "")).lower()
            or q in str(e.get("workflow_name", "")).lower()
            or q in str(e.get("workflow_id", "")).lower()
        ]

    # Recount statuses after date/search filter
    for exe in all_executions:
        s = str(exe.get("status", "")).lower()
        if s == "failed":
            total_failed += 1
        elif s == "running":
            total_running += 1
        else:
            total_completed += 1

    if status:
        all_executions = [e for e in all_executions if str(e.get("status", "")).lower() == status.lower()]

    total = len(all_executions)
    page  = all_executions[offset: offset + limit]

    return {
        "results":   page,
        "totalSize": total,
        "running":   total_running,
        "completed": total_completed,
        "failed":    total_failed,
        "analyzed_at": latest_analyzed_at,
    }


@router.get("/{tenant_name}/apps/{app_name}/failed-workflows")
def get_failed_workflows_live(
    tenant_name: str,
    app_name: str,
    hours: int = 1,
    start: str = Query(None, description="ISO start date e.g. 2026-04-01T00:00:00Z"),
    end: str = Query(None, description="ISO end date e.g. 2026-04-13T23:59:59Z"),
):
    """
    Query OpenSearch directly for failed workflows.
    If start/end are provided, uses those; otherwise falls back to last N hours.
    """
    db = get_db()
    doc = db["app_insights"].find_one(
        {"tenant_name": tenant_name, "app_name": app_name},
        sort=[("analyzed_at", -1)],
    )
    inst_id = (doc or {}).get("inst_id") or (doc or {}).get("app_id", "")

    now = datetime.now(timezone.utc)
    if start and end:
        ts_start = start
        ts_end = end
    else:
        ts_start = (now - timedelta(hours=hours)).strftime("%Y-%m-%dT%H:%M:%SZ")
        ts_end = now.strftime("%Y-%m-%dT%H:%M:%SZ")

    must: list = [{"range": {"@timestamp": {"gte": ts_start, "lte": ts_end}}}]
    if inst_id:
        must.append({"term": {"appId.keyword": inst_id}})

    query = {
        "size": 200,
        "sort": [{"@timestamp": {"order": "desc"}}],
        "_source": ["@timestamp", "message", "level", "correlationId",
                    "workflowName", "processName", "appId", "tenantId", "stack_trace"],
        "query": {
            "bool": {
                "must": must,
                "should": [
                    {"term":         {"status.keyword": "Failed"}},
                    {"match_phrase": {"message": "WORKFLOW_EXECUTION_FAILED"}},
                    {"match_phrase": {"message": "Workflow execution failed"}},
                    {"match_phrase": {"message": "Workflow execution failure"}},
                    {"match_phrase": {"message": "Work FLow execution Failed"}},
                    {"term":         {"level.keyword": "ERROR"}},
                    {"match_phrase": {"message": "JOB UNEXPECTED ERROR"}},
                    {"match_phrase": {"message": "WorkflowException"}},
                    {"match_phrase": {"message": "Failed to execute"}},
                ],
                "minimum_should_match": 1,
            }
        },
    }

    try:
        client = _os_client()
        resp = client.search(index="platform-*", body=query)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"OpenSearch error: {e}")

    _wf_re = re.compile(r"((?:Jiffy|JM)_\d+)")
    _uuid_re = re.compile(r"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})", re.IGNORECASE)
    results, seen = [], set()
    for hit in resp.get("hits", {}).get("hits", []):
        src = hit["_source"]
        msg = src.get("message", "")
        wf_id = str(src.get("correlationId") or "")
        # Try Jiffy/JM_ format first, then UUID format
        if not _wf_re.match(wf_id) and not _uuid_re.match(wf_id):
            m = _wf_re.search(msg)
            if m:
                wf_id = m.group(1)
            else:
                m2 = _uuid_re.search(msg)
                wf_id = m2.group(1) if m2 else ""
        if not wf_id or wf_id in seen:
            continue
        seen.add(wf_id)
        results.append({
            "workflowId":   wf_id,
            "status":       "FAILED",
            "processName":  src.get("processName") or "",
            "workflowName": src.get("workflowName") or "",
            "reason":       msg[:300].strip(),
            "stack_trace":  (src.get("stack_trace") or "")[:2000],
            "timestamp":    src.get("@timestamp") or "",
            "appId":        src.get("appId") or inst_id,
        })

    return results


@router.get("/{tenant_name}/history")
def get_tenant_history(tenant_name: str, limit: int = 10):
    """Historical tenant insight runs, newest first."""
    db = get_db()
    docs = list(
        db["tenant_insights"]
        .find({"tenant_name": tenant_name}, sort=[("analyzed_at", -1)])
        .limit(limit)
    )
    return [_serialize(doc) for doc in docs]


# ── AI tenant investigation ─────────────────────────────────────────────────

EMPTY_INVESTIGATE = {
    "error_summary":       "",
    "root_cause":          "",
    "evidence":            [],
    "impact":              "",
    "what_to_check":       [],
    "suggested_fix":       "",
    "confidence_score":    0,
    "worst_app":           {"app": "", "environment": ""},
    "failure_details":     [],
    "sample_logs":         [],
    "correlated_signals":  [],
    "failed_workflows":    0,
}


def _get_anthropic_key() -> str | None:
    try:
        key = (get_config().get("anthropic") or {}).get("api_key")
        if key and key != "YOUR_ANTHROPIC_API_KEY_HERE":
            return key
    except Exception:
        pass
    return os.environ.get("ANTHROPIC_API_KEY")


@router.post("/{tenant_name}/investigate")
def investigate_tenant(tenant_name: str):
    """Run a live AI investigation across every app in the given tenant.

    Returns the seven structured fields the modal renders. On AI/parse error
    we still return HTTP 200 with empty fields plus an `error` key so the
    modal can show a degraded state.
    """
    db = get_db()

    # Latest snapshot per (app_name, environment) for this tenant
    raw_docs = list(
        db["app_insights"]
        .find({"tenant_name": tenant_name})
        .sort("analyzed_at", -1)
    )
    if not raw_docs:
        raise HTTPException(status_code=404, detail="No insights found for this tenant")

    latest_by_key = {}
    for d in raw_docs:
        k = (d.get("app_name", ""), (d.get("environment") or "").lower())
        if k not in latest_by_key:
            latest_by_key[k] = d
    docs = list(latest_by_key.values())

    # Tenant-wide aggregates + raw evidence collected from per-app docs
    total_req = total_err = wf_total = wf_failed = 0
    apps_ctx = []
    raw_failure_rows: list[dict] = []   # path, status, count, app, env
    raw_log_samples:  list[dict] = []   # timestamp, method, path, status, code_details, app, env
    raw_pod_signals:  list[dict] = []   # pod, errors, errors_5xx, app, env
    raw_failed_wfs:   list[dict] = []   # process_name, error, app, env
    window_start_str: str | None = None
    window_end_str:   str | None = None
    analyzed_at_latest: str | None = None

    for d in docs:
        m   = d.get("metrics")  or {}
        wf  = m.get("workflow") or {}
        ins = d.get("insights") or {}
        app_name = d.get("app_name", "")
        env_name = d.get("environment", "")

        req = int(m.get("total_requests")    or 0)
        e4  = int(m.get("error_4xx_count")   or 0)
        e5  = int(m.get("error_5xx_count")   or 0)
        wfr = int(wf.get("total_requests")   or 0)
        wfe = int(wf.get("error_count")      or 0)
        total_req += req
        total_err += e4 + e5
        wf_total  += wfr
        wf_failed += wfe
        err_rate  = (e4 + e5) / req * 100 if req else 0

        lat = m.get("latency_ms") or {}
        avg_lat = lat.get("avg")
        p95_lat = lat.get("p95")

        # ── Failing endpoints — prefer error_analysis.endpoint_failures, fall
        #    back to insights.endpoint_analysis.most_error_prone.
        ep_failures = (ins.get("error_analysis") or {}).get("endpoint_failures") or []
        if not ep_failures:
            for ep in (ins.get("endpoint_analysis") or {}).get("most_error_prone") or []:
                ep_failures.append({
                    "path":          ep.get("path", ""),
                    "error_count":   int(ep.get("errors") or 0),
                    "dominant_code": 0,
                })
        for ep in ep_failures[:5]:
            if ep.get("path"):
                raw_failure_rows.append({
                    "path":   ep["path"],
                    "status": ep.get("dominant_code") or 0,
                    "count":  int(ep.get("error_count") or 0),
                    "app":    app_name,
                    "env":    env_name,
                })

        # ── Sample error logs from timeseries.error_samples ──
        ts_buckets = m.get("timeseries") or []
        if ts_buckets:
            first_ts = ts_buckets[0].get("ts")
            last_ts  = ts_buckets[-1].get("ts")
            if first_ts and (window_start_str is None or first_ts < window_start_str):
                window_start_str = first_ts
            if last_ts and (window_end_str is None or last_ts > window_end_str):
                window_end_str = last_ts
        doc_analyzed = d.get("analyzed_at")
        if doc_analyzed:
            iso = doc_analyzed.isoformat() if hasattr(doc_analyzed, "isoformat") else str(doc_analyzed)
            if analyzed_at_latest is None or iso > analyzed_at_latest:
                analyzed_at_latest = iso
        for bucket in ts_buckets[-12:]:  # last 12 buckets is plenty
            for s in (bucket.get("error_samples") or [])[:3]:
                raw_log_samples.append({
                    "timestamp":     s.get("timestamp") or "",
                    "method":        s.get("method") or "",
                    "path":          s.get("path") or "",
                    "status":        s.get("response_code"),
                    "code_details":  (s.get("response_code_details") or s.get("response_flags") or "")[:160],
                    "duration_ms":   s.get("duration"),
                    "app":           app_name,
                    "env":           env_name,
                })

        # ── Pod-level signals ──
        for p in (m.get("pod_stats") or [])[:6]:
            errs = int(p.get("errors") or 0)
            if errs <= 0:
                continue
            raw_pod_signals.append({
                "pod":         p.get("pod") or "",
                "errors":      errs,
                "errors_5xx":  int(p.get("errors_5xx") or 0),
                "requests":    int(p.get("requests") or 0),
                "app":         app_name,
                "env":         env_name,
            })

        # ── Workflow failures (process names with errors) ──
        for st in (wf.get("steps") or [])[:6]:
            err_cnt = int(st.get("error_count") or 0)
            if err_cnt > 0:
                raw_failed_wfs.append({
                    "process_name": st.get("name") or st.get("step_name") or "",
                    "error_count":  err_cnt,
                    "error_message": (st.get("last_error") or st.get("error_message") or "")[:240],
                    "app":          app_name,
                    "env":          env_name,
                })

        apps_ctx.append({
            "app":             app_name,
            "env":             env_name,
            "total_requests":  req,
            "errors":          e4 + e5,
            "error_rate_pct":  round(err_rate, 2),
            "avg_latency_ms":  avg_lat,
            "p95_latency_ms":  p95_lat,
            "workflow_failed": wfe,
            "primary_issue":   ((ins.get("root_cause") or {}).get("primary_issue") or "")[:200],
            "top_issue":       ((ins.get("top_issues") or [None])[0] or "")[:200] if ins.get("top_issues") else "",
        })

    apps_ctx.sort(key=lambda a: a["error_rate_pct"], reverse=True)
    top_apps = apps_ctx[:5]
    worst    = apps_ctx[0] if apps_ctx else None

    # Sort raw evidence
    raw_failure_rows.sort(key=lambda r: r["count"], reverse=True)
    raw_failure_rows = raw_failure_rows[:8]
    raw_log_samples.sort(key=lambda r: r["timestamp"], reverse=True)
    raw_log_samples  = raw_log_samples[:10]
    raw_pod_signals.sort(key=lambda r: r["errors"], reverse=True)
    raw_pod_signals  = raw_pod_signals[:5]
    raw_failed_wfs.sort(key=lambda r: r["error_count"], reverse=True)
    raw_failed_wfs   = raw_failed_wfs[:6]

    overall_err_rate = round(total_err / total_req * 100, 2) if total_req else 0

    api_key = _get_anthropic_key()
    if not api_key:
        raise HTTPException(status_code=503, detail="Anthropic API key not configured")

    tenant_ctx = {
        "tenant":              tenant_name,
        "app_count":           len(docs),
        "analysis_window": {
            "start":              window_start_str,
            "end":                window_end_str,
            "analyzed_at_latest": analyzed_at_latest,
        },
        "total_requests":      total_req,
        "total_errors":        total_err,
        "overall_error_rate":  overall_err_rate,
        "workflow_total":      wf_total,
        "workflow_failed":     wf_failed,
        "worst_app":           worst,
        "top_apps_by_error":   top_apps,
        "endpoint_failures":   raw_failure_rows,
        "log_samples":         raw_log_samples,
        "pod_signals":         raw_pod_signals,
        "workflow_failures":   raw_failed_wfs,
    }

    prompt = f"""You are an expert SRE investigating the health of the Jiffy tenant "{tenant_name}".
You have access to the latest analyzed metrics across every app in this tenant, plus
raw failure-evidence (failing endpoints, sample error logs, pod-level errors, failed
workflows). Use ALL of it to produce a concrete, evidence-driven diagnosis.

## Tenant context (raw evidence)
```json
{json.dumps(tenant_ctx, indent=2, default=str)[:12000]}
```

Respond with ONLY a valid JSON object (no markdown, no code fences) with EXACTLY these keys:

{{
  "error_summary":     "<1-2 sentences naming the worst app+env and the dominant error class>",
  "root_cause":        "<2-4 sentences. Be SPECIFIC: cite metrics from the context (P95, error counts, percentages, pod names, deploy timing if you can infer it). Do NOT speak in generalities.>",
  "evidence":          ["<bullet citing real numbers/apps>", "..."],
  "impact":            "<1-2 sentences quantifying user/business impact with real numbers>",
  "what_to_check":     ["<actionable, specific check tied to the evidence — e.g. 'DB connection-pool saturation on eclose-prod-xyz pod'>", "..."],
  "suggested_fix":     "<2-3 sentences with concrete fixes — name pods, services, scaling actions, rollback candidates>",
  "confidence_score":  <integer 0-100>,
  "worst_app":         {{"app": "<app name>", "environment": "<prod|dev|uat|...>"}},
  "failure_details": [
    {{"path": "<route>", "status": <int http status>, "count": <int>, "cause_hint": "<short, e.g. 'DB timeout' or 'upstream 504'>", "app": "<app name>"}},
    ...
  ],
  "sample_logs": [
    {{"timestamp": "<HH:MM:SS or ISO>", "method": "<GET|POST|...>", "path": "<route>", "status": <int>, "cause_hint": "<short>", "app": "<app name>"}},
    ...
  ],
  "correlated_signals": [
    {{"entity": "<e.g. Pod eclose-prod-xyz>", "detail": "<e.g. 48 errors / 12 5xx>", "note": "<short hint>"}},
    ...
  ],
  "failed_workflows":  <int — total failed workflow executions across all apps in window>
}}

Rules:
- failure_details must be 3-6 rows drawn from the `endpoint_failures` array in context, with cause_hint informed by status codes and path.
- sample_logs must be 3-6 rows drawn from the `log_samples` array in context. Convert timestamps to "HH:MM:SS" when possible.
- correlated_signals must be 2-5 rows drawn from `pod_signals`, `worst_app`, or workflow_failures.
- what_to_check items must be SPECIFIC (mention pod, DB, deploy, env). NEVER generic like "check logs" or "check metrics".
- suggested_fix must be SPECIFIC actions a human can run today.
- root_cause MUST reference the `analysis_window` (start -> end) so the reader can correlate against pod-restart times and recent deploys.
- Include a "what_to_check" item that says: "Confirm whether the listed pods were restarted between <window_start> and <window_end>" (use the actual values from analysis_window).
- Output raw JSON only, no markdown, no code fences."""

    # Deterministic evidence we can always show, even if the AI call fails.
    deterministic_failures = [
        {"path": r["path"], "status": r["status"], "count": r["count"],
         "cause_hint": "", "app": r["app"]}
        for r in raw_failure_rows[:6]
    ]
    deterministic_samples = [
        {"timestamp": r["timestamp"], "method": r["method"], "path": r["path"],
         "status": r["status"], "cause_hint": r["code_details"], "app": r["app"]}
        for r in raw_log_samples[:6]
    ]
    deterministic_signals = [
        {"entity": f"Pod {p['pod']}", "detail": f"{p['errors']} errors / {p['errors_5xx']} 5xx",
         "note": f"{p['app']} ({p['env']})"}
        for p in raw_pod_signals[:5]
    ]
    deterministic_worst = (
        {"app": worst["app"], "environment": worst["env"]} if worst else EMPTY_INVESTIGATE["worst_app"]
    )

    try:
        client = anthropic.Anthropic(api_key=api_key)
        message = client.messages.create(
            model="claude-opus-4-8",
            max_tokens=4000,
            temperature=0.2,
            messages=[{"role": "user", "content": prompt}],
        )
        ai_text = (message.content[0].text if message.content else "").strip()
        if ai_text.startswith("```"):
            ai_text = re.sub(r"^```(?:json)?\s*", "", ai_text)
            ai_text = re.sub(r"\s*```$", "", ai_text)
        try:
            parsed = json.loads(ai_text)
        except json.JSONDecodeError as e:
            return {
                **EMPTY_INVESTIGATE,
                "tenant":             tenant_name,
                "analyzed_at":        datetime.now(timezone.utc).isoformat(),
                "window_start":       window_start_str,
                "window_end":         window_end_str,
                "error":              f"Failed to parse AI response: {e}",
                "raw":                ai_text[:1000],
                "worst_app":          deterministic_worst,
                "failure_details":    deterministic_failures,
                "sample_logs":        deterministic_samples,
                "correlated_signals": deterministic_signals,
                "failed_workflows":   wf_failed,
            }

        result = {**EMPTY_INVESTIGATE, **{k: parsed.get(k, EMPTY_INVESTIGATE[k]) for k in EMPTY_INVESTIGATE}}
        try:
            result["confidence_score"] = int(result["confidence_score"])
        except Exception:
            result["confidence_score"] = 0
        try:
            result["failed_workflows"] = int(result["failed_workflows"])
        except Exception:
            result["failed_workflows"] = wf_failed
        if not isinstance(result.get("worst_app"), dict):
            result["worst_app"] = EMPTY_INVESTIGATE["worst_app"]
        for k in ("failure_details", "sample_logs", "correlated_signals", "evidence", "what_to_check"):
            if not isinstance(result.get(k), list):
                result[k] = []
        # Fall back to raw deterministic evidence if Claude returned empty arrays.
        if not result["failure_details"]:
            result["failure_details"] = deterministic_failures
        if not result["sample_logs"]:
            result["sample_logs"] = deterministic_samples
        if not result["correlated_signals"]:
            result["correlated_signals"] = deterministic_signals
        if not (result.get("worst_app") or {}).get("app"):
            result["worst_app"] = deterministic_worst
        result["tenant"]       = tenant_name
        result["analyzed_at"]  = datetime.now(timezone.utc).isoformat()
        result["window_start"] = window_start_str
        result["window_end"]   = window_end_str
        return result
    except Exception as e:
        return {
            **EMPTY_INVESTIGATE,
            "tenant":             tenant_name,
            "analyzed_at":        datetime.now(timezone.utc).isoformat(),
            "window_start":       window_start_str,
            "window_end":         window_end_str,
            "error":              str(e),
            "worst_app":          deterministic_worst,
            "failure_details":    deterministic_failures,
            "sample_logs":        deterministic_samples,
            "correlated_signals": deterministic_signals,
            "failed_workflows":   wf_failed,
        }
