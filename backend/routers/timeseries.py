from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from opensearchpy import OpenSearch

from config import get_config
from database import get_db

router = APIRouter(prefix="/api/timeseries", tags=["Time Series"])


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _get_os_client() -> OpenSearch:
    os_cfg = get_config()["opensearch"]
    host = os_cfg["host"]
    for prefix in ("https://", "http://"):
        if host.startswith(prefix):
            host = host[len(prefix):]
    host = host.rstrip("/")
    return OpenSearch(
        hosts=[{"host": host, "port": os_cfg.get("port", 443)}],
        http_auth=(os_cfg.get("username"), os_cfg.get("password")),
        use_ssl=os_cfg.get("use_ssl", True),
        verify_certs=os_cfg.get("verify_certs", True),
        headers={"securitytenant": "global"},
        timeout=30,
    )


def _auto_interval(start: str, end: str) -> str:
    """Pick a sensible fixed_interval based on the requested time range."""
    try:
        s = datetime.fromisoformat(start.replace("Z", "+00:00"))
        e = datetime.fromisoformat(end.replace("Z", "+00:00"))
        hours = (e - s).total_seconds() / 3600
        if hours <= 1:
            return "1m"
        if hours <= 6:
            return "5m"
        if hours <= 24:
            return "15m"
        return "1h"
    except ValueError:
        return "15m"


def _build_aggs() -> dict:
    """Sub-aggregations applied to every time bucket."""
    return {
        "errors_5xx": {
            "filter": {"range": {"response_code": {"gte": 500, "lt": 600}}}
        },
        "errors_4xx": {
            "filter": {"range": {"response_code": {"gte": 400, "lt": 500}}}
        },
        "avg_duration": {"avg": {"field": "duration"}},
        "workflow_reqs": {
            "filter": {
                "bool": {
                    "should": [
                        {"match_phrase_prefix": {"path": "/workflow"}},
                        {"match_phrase_prefix": {"path": "/platform/workflow"}},
                    ],
                    "minimum_should_match": 1,
                }
            }
        },
    }


def _format_buckets(response: dict) -> dict:
    buckets = (
        response.get("aggregations", {})
        .get("over_time", {})
        .get("buckets", [])
    )
    data = []
    for b in buckets:
        avg_lat = b.get("avg_duration", {}).get("value")
        data.append({
            "timestamp": b.get("key_as_string"),
            "requests": b.get("doc_count", 0),
            "errors_5xx": b.get("errors_5xx", {}).get("doc_count", 0),
            "errors_4xx": b.get("errors_4xx", {}).get("doc_count", 0),
            "avg_latency_ms": round(avg_lat, 1) if avg_lat is not None else None,
            "workflow_requests": b.get("workflow_reqs", {}).get("doc_count", 0),
        })
    return {"data": data, "bucket_count": len(data)}


def _search(must_clauses: list, start: str, end: str, interval: str) -> dict:
    os_cfg = get_config()["opensearch"]
    client = _get_os_client()

    query = {
        "size": 0,
        "query": {"bool": {"must": must_clauses}},
        "aggs": {
            "over_time": {
                "date_histogram": {
                    "field": "@timestamp",
                    "fixed_interval": interval,
                    "min_doc_count": 0,
                    "extended_bounds": {"min": start, "max": end},
                },
                "aggs": _build_aggs(),
            }
        },
    }
    response = client.search(index=os_cfg.get("index_pattern", "platform-*"), body=query)
    return _format_buckets(response)


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("/{tenant_name}/app/errors")
def app_error_samples(
    tenant_name: str,
    authority: str = Query(..., description="App instance authority (used as Mongo fallback key)"),
    start: str = Query(..., description="ISO-8601 bucket start"),
    end: str = Query(..., description="ISO-8601 bucket end"),
    size: int = Query(50, ge=1, le=200, description="Maximum live error samples to return"),
    inst_id: str | None = Query(
        None,
        description="App instance UUID. When provided, the live OpenSearch query filters by "
                    "appId + istio-ingress pod (the same filter shape the Lambda batch uses). "
                    "More accurate than authority filtering when several apps share a tenant URL.",
    ),
):
    """
    Sample error documents for a given bucket range.
    Reads pre-computed error_samples from MongoDB (stored by log_analysis.py).
    """
    def _parse(iso: str) -> datetime:
        return datetime.fromisoformat(iso.replace("Z", "+00:00"))

    try:
        start_dt = _parse(start)
        end_dt = _parse(end)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid ISO-8601 start/end")

    # Prefer appId filter when caller supplies inst_id (matches Lambda's
    # _fetch_istio_logs filter exactly). Falls back to authority match_phrase
    # for older callers that don't have inst_id at hand.
    if inst_id:
        app_filter = [
            {"term":     {"appId.keyword": inst_id}},
            {"wildcard": {"kubernetes.pod_name.keyword": "istio-ingress*"}},
        ]
    else:
        app_filter = [{"match_phrase": {"authority": authority}}]

    os_cfg = get_config()["opensearch"]
    live_query = {
        "size": size,
        "sort": [{"@timestamp": {"order": "desc"}}],
        "_source": [
            "@timestamp",
            "response_code",
            "response_code_details",
            "response_flags",
            "duration",
            "authority",
            "path",
            "method",
            "upstream_cluster",
            "request_id",
            "kubernetes.pod_name",
        ],
        "query": {
            "bool": {
                "must": [
                    {"range": {"@timestamp": {"gte": start, "lt": end}}},
                    *app_filter,
                    {"range": {"response_code": {"gte": 400, "lt": 600}}},
                ]
            }
        },
    }

    try:
        live_resp = _get_os_client().search(
            index=os_cfg.get("index_pattern", "platform-*"),
            body=live_query,
        )
        # OpenSearch responded successfully — trust this as the source of truth
        # even when zero hits. Falling through to MongoDB on empty samples
        # incorrectly 404s for windows that genuinely have no errors.
        hits = live_resp.get("hits", {}).get("hits", [])
        samples = [h.get("_source", {}) for h in hits]
        status_counts: dict = {}
        path_counts: dict = {}
        for s in samples:
            code = s.get("response_code")
            status_counts[code] = status_counts.get(code, 0) + 1
            path = s.get("path")
            if path:
                path_counts[path] = path_counts.get(path, 0) + 1

        total = live_resp.get("hits", {}).get("total", 0)
        if isinstance(total, dict):
            total = total.get("value", len(samples))

        return {
            "total": total,
            "errors": samples,
            "by_status": sorted(
                [{"status": k, "count": v} for k, v in status_counts.items()],
                key=lambda x: -x["count"],
            ),
            "by_path": sorted(
                [{"path": p, "count": c} for p, c in path_counts.items()],
                key=lambda x: -x["count"],
            )[:10],
            "source": "opensearch",
        }
    except Exception:
        # OpenSearch query failed — fall back to MongoDB precomputed buckets so
        # the drilldown stays usable while OS is unreachable.
        pass

    db = get_db()
    doc = db["app_insights"].find_one(
        {"tenant_name": tenant_name, "authority": authority},
        sort=[("analyzed_at", -1)],
    )
    if not doc:
        raise HTTPException(status_code=404, detail="No insights found for this app")

    ts = (doc.get("metrics") or {}).get("timeseries") or []
    matched_buckets = []
    for b in ts:
        ts_raw = b.get("ts")
        if not ts_raw:
            continue
        try:
            b_dt = _parse(str(ts_raw))
        except ValueError:
            continue
        # Bucket start is inside [start, end)
        if start_dt <= b_dt < end_dt:
            matched_buckets.append(b)

    all_samples: list = []
    status_counts: dict = {}
    path_counts: dict = {}
    total_errors = 0
    for b in matched_buckets:
        total_errors += b.get("errors", 0)
        for s in b.get("error_samples", []) or []:
            all_samples.append(s)
        for code, c in (b.get("error_status_counts") or {}).items():
            status_counts[code] = status_counts.get(code, 0) + c
        for entry in (b.get("error_top_paths") or []):
            p = entry.get("path")
            if p:
                path_counts[p] = path_counts.get(p, 0) + entry.get("count", 0)

    return {
        "total": total_errors,
        "errors": all_samples,
        "by_status": sorted(
            [{"status": int(k) if str(k).isdigit() else k, "count": v} for k, v in status_counts.items()],
            key=lambda x: -x["count"],
        ),
        "by_path": sorted(
            [{"path": p, "count": c} for p, c in path_counts.items()],
            key=lambda x: -x["count"],
        )[:10],
    }


@router.get("/{tenant_name}/app")
def app_timeseries(
    tenant_name: str,
    authority: str = Query(..., description="App instance authority (legacy fallback)"),
    start: str = Query(..., description="ISO-8601 start time"),
    end: str = Query(..., description="ISO-8601 end time"),
    interval: Optional[str] = Query(None, description="Fixed interval e.g. 1m, 5m, 15m, 1h"),
    inst_id: Optional[str] = Query(
        None,
        description="App instance UUID. When provided, filter by appId + istio-ingress pod "
                    "(matches the Lambda's filter shape) instead of authority. More accurate "
                    "when several apps share a tenant URL.",
    ),
):
    """Time-bucketed metrics for a single app instance."""
    interval = interval or _auto_interval(start, end)
    must_clauses = [
        {"range": {"@timestamp": {"gte": start, "lte": end}}},
    ]
    if inst_id:
        must_clauses.append({"term":     {"appId.keyword": inst_id}})
        must_clauses.append({"wildcard": {"kubernetes.pod_name.keyword": "istio-ingress*"}})
    else:
        must_clauses.append({"match_phrase": {"authority": authority}})
    return _search(must_clauses, start, end, interval)


@router.get("/{tenant_name}")
def tenant_timeseries(
    tenant_name: str,
    start: str = Query(..., description="ISO-8601 start time"),
    end: str = Query(..., description="ISO-8601 end time"),
    interval: Optional[str] = Query(None, description="Fixed interval e.g. 1m, 5m, 15m, 1h"),
):
    """Time-bucketed metrics aggregated across all apps in a tenant."""
    db = get_db()

    # Resolve the app authorities for this tenant from the latest analysis run
    latest = db["tenant_insights"].find_one(
        {"tenant_name": tenant_name}, sort=[("analyzed_at", -1)]
    )
    if not latest:
        raise HTTPException(status_code=404, detail="No insights found for this tenant")

    authorities = [
        doc["authority"]
        for doc in db["app_insights"].find({
            "tenant_name": tenant_name,
            "analyzed_at": latest["analyzed_at"],
        })
        if doc.get("authority")
    ]

    if not authorities:
        raise HTTPException(status_code=404, detail="No app authorities found for this tenant")

    interval = interval or _auto_interval(start, end)
    must_clauses = [
        {"range": {"@timestamp": {"gte": start, "lte": end}}},
        {
            "bool": {
                "should": [{"match_phrase": {"authority": a}} for a in authorities],
                "minimum_should_match": 1,
            }
        },
    ]
    return _search(must_clauses, start, end, interval)
