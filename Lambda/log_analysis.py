"""
Tenant log analysis: fetches Istio logs from OpenSearch, analyses with Claude,
stores insights in MongoDB.

Usage (CLI):
    python log_analysis.py <tenant_name> <start_iso> <end_iso>
    python log_analysis.py acme-corp 2026-03-25T00:00:00Z 2026-03-26T00:00:00Z

AWS Lambda entry point: lambda_handler(event, context)
    event = {
        "tenant_name": "acme-corp",
        "timeframe": {"start": "2026-03-25T00:00:00Z", "end": "2026-03-26T00:00:00Z"}
    }
"""

import json
import logging
import re
import sys
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import httpx
import yaml
from opensearchpy import OpenSearch
from pymongo import MongoClient

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

def _load_config() -> dict:
    config_path = Path(__file__).parent / "config.yml"
    with open(config_path) as f:
        return yaml.safe_load(f)


# ---------------------------------------------------------------------------
# Jiffy helpers
# ---------------------------------------------------------------------------

_token_cache: dict = {}  # { jiffy_url: { "token": str, "expires_at": float } }


def _get_jiffy_token(jiffy_cfg: dict) -> str:
    """Obtain (or return cached) OAuth2 access token from Jiffy."""
    cache_key = jiffy_cfg["url"]
    cached = _token_cache.get(cache_key)
    if cached and cached["expires_at"] > time.time() + 30:
        return cached["token"]

    token_url = f"{jiffy_cfg['url'].rstrip('/')}/apexiam/v1/auth/token"
    response = httpx.post(
        token_url,
        params={"tenantId": "jiffy"},
        data={
            "grant_type": "client_credentials",
            "client_id": jiffy_cfg["client_id"],
            "client_secret": jiffy_cfg["client_secret"],
            "scope": "openid",
        },
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        timeout=10,
    )
    response.raise_for_status()
    token_data = response.json()
    token = token_data.get("access_token") or token_data.get("token")
    expires_in = token_data.get("expires_in", 3600)
    _token_cache[cache_key] = {"token": token, "expires_at": time.time() + expires_in}
    return token


def _fetch_all_tenant_names(jiffy_cfg: dict, token: str) -> list[str]:
    """Return sorted list of all tenant names from the Jiffy tenant list API."""
    base  = jiffy_cfg["url"].rstrip("/")
    limit = 100
    offset = 0
    names: list[str] = []

    while True:
        response = httpx.get(
            f"{base}/pam/tenant/list",
            params={"offset": offset, "limit": limit},
            headers={"Authorization": f"Bearer {token}", "Origin": "jiffy.ai"},
            timeout=15,
        )
        response.raise_for_status()
        data = response.json()
        rows: list = data if isinstance(data, list) else (
            data.get("tenants") or data.get("data") or data.get("results") or []
        )
        for row in rows:
            name = str(row.get("name") or "").strip()
            if name:
                names.append(name)
        if len(rows) < limit:
            break
        offset += limit

    return sorted(names)



def _classify_root_cause(error_msg: str, exception: str) -> tuple[str, str]:
    """Pattern-match error text → (root_cause, suggested_fix)."""
    combined = (error_msg + " " + exception).lower()
    # Jiffy-specific: workflow expression / variable errors
    if any(x in combined for x in ["variable does not exist", "nonexistingliteral", "is unsupported",
                                    "evaluating expression", "workflowexception"]):
        return ("Workflow expression/variable error — a referenced variable or expression is undefined or has an unsupported type",
                "Check the workflow step configuration: verify all variables are mapped correctly and expressions use supported types")
    if any(x in combined for x in ["nullpointer", "null pointer", " null ", "nonetype", "none type", "is null"]):
        return ("Null/None reference — a required value was not initialised",
                "Validate all required inputs are non-null before processing")
    if any(x in combined for x in ["timeout", "timed out", "time out", "socket timeout", "read timeout"]):
        return ("Timeout — operation exceeded the allowed time limit",
                "Increase the timeout threshold or optimise the slow operation/query")
    if any(x in combined for x in ["connection refused", "connection reset", "connect timeout",
                                    "unreachable", "no route", "econnrefused"]):
        return ("Connection failure — could not reach a required service",
                "Verify endpoint URL, check network/firewall rules and confirm the service is running")
    if any(x in combined for x in ["401", "403", "unauthorized", "forbidden",
                                    "access denied", "authentication failed"]):
        return ("Authentication or Authorisation failure",
                "Verify API credentials, refresh tokens and check user/role permissions")
    if any(x in combined for x in ["500", "502", "503", "504", "internal server error",
                                    "bad gateway", "service unavailable"]):
        return ("Upstream service error (HTTP 5xx)",
                "Check the backend service availability, health and its own error logs")
    if any(x in combined for x in ["sql", "database", "jdbc", "query failed",
                                    "constraint violation", "duplicate key"]):
        return ("Database error",
                "Review database query syntax, connection settings and data constraints")
    if any(x in combined for x in ["classnotfound", "nosuchmethod", "classcast", "instantiation"]):
        return ("Application code / configuration error",
                "Check deployment configuration and class/library versions")
    return ("Application error — see error message for details",
            "Review application and service logs for a full stack trace")


def _score_error_log(log: dict) -> int:
    """
    Score a log entry — higher = more informative for root cause analysis.
    Used to pick the single best log to display per failed workflow.
    """
    msg = str(log.get("message") or "")
    st  = str(log.get("stack_trace") or "")
    lvl = str(log.get("level") or "").upper()
    s = 0
    # Specific Jiffy error patterns in the message — most informative
    if any(x in msg for x in [
        "Variable does not exist", "Error while evaluating expression",
        "with temporal exception", "is unsupported", "WorkflowException",
    ]):
        s += 100
    # Temporal worker WARN with actual cause in stack_trace
    if "Workflow execution failure" in msg and st:
        s += 90
    # Stack trace starting with io.jiffy = actual application exception
    if st.lstrip().startswith("io.jiffy"):
        s += 75
    elif "io.jiffy" in st:
        s += 60
    # Any stack trace
    if st:
        s += 40
    if log.get("exception"):
        s += 30
    if lvl == "ERROR":
        s += 10
    return s


_WF_RE = re.compile(r"((?:Jiffy|JM)_\d+)")
_UUID_RE = re.compile(r"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})", re.IGNORECASE)


def _extract_wf_id(corr_id: str, msg: str) -> str:
    """Extract workflow ID — supports both Jiffy_123 and UUID formats."""
    if _WF_RE.match(corr_id) or _UUID_RE.match(corr_id):
        return corr_id
    m = _WF_RE.search(msg)
    if m:
        return m.group(1)
    m2 = _UUID_RE.search(corr_id)
    if m2:
        return m2.group(1)
    m3 = _UUID_RE.search(msg)
    return m3.group(1) if m3 else ""


def _fetch_workflow_executions(
    client: OpenSearch,
    inst_id: str,
    start: str,
    end: str,
    max_hits: int = 500,
) -> dict:
    """
    Three-step process:
      Step 1 — find failed workflow IDs from ERROR logs filtered by appId.
      Step 2 — re-query ALL logs for those IDs without appId restriction,
               capturing WARN/ERROR logs that have the actual root-cause.
      Step 3 — heuristic enrichment: fills error_summary from log content.
    """
    # ── Step 1a: find failed workflow IDs from logs WITH appId ─────────────────
    must1: list = [{"range": {"@timestamp": {"gte": start, "lte": end}}}]
    if inst_id:
        must1.append({"term": {"appId.keyword": inst_id}})

    try:
        r1 = client.search(index="platform-*", body={
            "size": max_hits,
            "sort": [{"@timestamp": {"order": "asc"}}],
            "_source": ["@timestamp", "message", "level", "correlationId",
                        "workflowName", "processName"],
            "query": {
                "bool": {
                    "must": must1,
                    "should": [
                        {"match_phrase": {"message": "Workflow execution failed"}},
                        {"match_phrase": {"message": "Workflow execution failure"}},
                        {"match_phrase": {"message": "Work FLow execution Failed"}},
                        {"match_phrase": {"message": "WORKFLOW_EXECUTION_FAILED"}},
                        {"match_phrase": {"message": "WorkflowException"}},
                    ],
                    "minimum_should_match": 1,
                }
            },
        })
    except Exception as e:
        logger.warning(f"  Workflow executions step1a error: {e}")
        return {"results": [], "running": 0, "completed": 0, "failed": 0, "totalSize": 0}

    # Collect unique workflow IDs + base metadata from step 1a
    wf_meta: dict[str, dict] = {}
    for hit in r1.get("hits", {}).get("hits", []):
        src = hit["_source"]
        msg = str(src.get("message") or "")
        corr_id = _extract_wf_id(str(src.get("correlationId") or ""), msg)
        if not corr_id:
            continue
        proc  = str(src.get("processName") or "")
        wname = str(src.get("workflowName") or "")
        if not proc:
            pm = re.search(r"processName[=:\s]+([^\s,]+)", msg)
            if pm:
                proc = pm.group(1)
        if corr_id not in wf_meta:
            wf_meta[corr_id] = {
                "process_name":  proc,
                "workflow_name": wname,
                "start_time":    str(src.get("@timestamp") or ""),
                "end_time":      str(src.get("@timestamp") or ""),
            }
        else:
            wf_meta[corr_id]["end_time"] = str(src.get("@timestamp") or "")
            if not wf_meta[corr_id]["process_name"] and proc:
                wf_meta[corr_id]["process_name"] = proc
            if not wf_meta[corr_id]["workflow_name"] and wname:
                wf_meta[corr_id]["workflow_name"] = wname

    # ── Step 1b: find orphan failures (WARN logs WITHOUT appId) ──────────────
    # Some workflow failure logs (e.g. from io.temporal WorkflowExecutionHandler)
    # have NO appId field. Find them, then verify they belong to this app by
    # checking if any OTHER log for the same workflow ID has this appId.
    if inst_id:
        try:
            r1b = client.search(index="platform-*", body={
                "size": max_hits,
                "sort": [{"@timestamp": {"order": "asc"}}],
                "_source": ["@timestamp", "message", "level", "correlationId",
                            "workflowName", "processName"],
                "query": {
                    "bool": {
                        "must": [{"range": {"@timestamp": {"gte": start, "lte": end}}}],
                        "must_not": [{"exists": {"field": "appId"}}],
                        "should": [
                            {"match_phrase": {"message": "Workflow execution failure"}},
                            {"match_phrase": {"message": "Workflow execution failed"}},
                            {"match_phrase": {"message": "WorkflowException"}},
                            {"match_phrase": {"message": "WORKFLOW_EXECUTION_FAILED"}},
                        ],
                        "minimum_should_match": 1,
                    }
                },
            })

            # Extract workflow IDs not already found in step 1a
            orphan_wf_ids: set[str] = set()
            orphan_meta: dict[str, dict] = {}
            for hit in r1b.get("hits", {}).get("hits", []):
                src = hit["_source"]
                msg = str(src.get("message") or "")
                corr_id = str(src.get("correlationId") or "")
                wf_id = _extract_wf_id(corr_id, msg)
                if not wf_id:
                    continue
                if wf_id in wf_meta:
                    continue  # already found in step 1a
                orphan_wf_ids.add(wf_id)
                if wf_id not in orphan_meta:
                    orphan_meta[wf_id] = {
                        "process_name":  str(src.get("processName") or ""),
                        "workflow_name": str(src.get("workflowName") or ""),
                        "start_time":    str(src.get("@timestamp") or ""),
                        "end_time":      str(src.get("@timestamp") or ""),
                    }

            # Verify ownership: check if any log for these orphan workflows has this appId
            if orphan_wf_ids:
                verify_should: list = []
                for wf_id in list(orphan_wf_ids)[:200]:
                    verify_should.append({"match_phrase": {"correlationId": wf_id}})
                    verify_should.append({"match_phrase": {"message": wf_id}})
                try:
                    rv = client.search(index="platform-*", body={
                        "size": len(orphan_wf_ids) * 5,
                        "_source": ["correlationId", "appId", "message",
                                    "processName", "workflowName", "@timestamp"],
                        "query": {
                            "bool": {
                                "must": [
                                    {"range": {"@timestamp": {"gte": start, "lte": end}}},
                                    {"term": {"appId.keyword": inst_id}},
                                ],
                                "should": verify_should,
                                "minimum_should_match": 1,
                            }
                        },
                    })
                    verified: set[str] = set()
                    for hit in rv.get("hits", {}).get("hits", []):
                        src = hit["_source"]
                        corr_id = str(src.get("correlationId") or "")
                        msg = str(src.get("message") or "")
                        wf_id = _extract_wf_id(corr_id, msg)
                        if wf_id and wf_id in orphan_wf_ids:
                            verified.add(wf_id)
                            # Enrich metadata from the verified log
                            meta = orphan_meta.get(wf_id, {})
                            if not meta.get("process_name") and src.get("processName"):
                                meta["process_name"] = str(src["processName"])
                            if not meta.get("workflow_name") and src.get("workflowName"):
                                meta["workflow_name"] = str(src["workflowName"])

                    # Merge verified orphans into wf_meta
                    for wf_id in verified:
                        if wf_id not in wf_meta:
                            wf_meta[wf_id] = orphan_meta.get(wf_id, {
                                "process_name": "", "workflow_name": "",
                                "start_time": "", "end_time": "",
                            })
                    if verified:
                        logger.info(f"    Step 1b: recovered {len(verified)} orphan workflow(s) without appId")
                except Exception as e:
                    logger.warning(f"  Workflow executions step1b verify error: {e}")

        except Exception as e:
            logger.warning(f"  Workflow executions step1b error: {e}")

    if not wf_meta:
        logger.info(f"    → 0 failed execution(s)")
        return {"results": [], "running": 0, "completed": 0, "failed": 0, "totalSize": 0}

    # ── Step 2: fetch ALL logs for these workflow IDs (no appId restriction) ──
    wf_ids = list(wf_meta.keys())
    should2: list = [{"terms": {"correlationId.keyword": wf_ids}}]
    for wf_id in wf_ids[:60]:
        should2.append({"match_phrase": {"message": wf_id}})

    try:
        r2 = client.search(index="platform-*", body={
            "size": min(len(wf_ids) * 15, 3000),
            "sort": [{"@timestamp": {"order": "asc"}}],
            "_source": ["@timestamp", "message", "level", "correlationId",
                        "workflowName", "processName", "stack_trace", "exception"],
            "query": {
                "bool": {
                    "must": [{"range": {"@timestamp": {"gte": start, "lte": end}}}],
                    "should": should2,
                    "minimum_should_match": 1,
                }
            },
        })
    except Exception as e:
        logger.warning(f"  Workflow executions step2 error: {e}")
        r2 = {"hits": {"hits": []}}

    # Group step2 logs by workflow ID
    detail: dict[str, list] = {wf_id: [] for wf_id in wf_ids}
    for hit in r2.get("hits", {}).get("hits", []):
        src = hit["_source"]
        corr_id = _extract_wf_id(str(src.get("correlationId") or ""), str(src.get("message") or ""))
        if corr_id in detail:
            detail[corr_id].append(src)

    # ── Step 3: fetch child workflow logs for ChildWorkflowFailure cases ──────
    # When a WARN log's stack_trace starts with ChildWorkflowFailure, the real
    # error may be in the child workflow's own logs. Extract child UUID and fetch.
    _CHILD_UUID_RE = re.compile(
        r"ChildWorkflowFailure[^']*workflowId='([a-f0-9\-]{36})'", re.IGNORECASE
    )
    child_to_parent: dict[str, str] = {}   # child_uuid → parent wf_id
    for wf_id in wf_ids:
        for log in detail.get(wf_id, []):
            st = str(log.get("stack_trace") or "")
            if "ChildWorkflowFailure" in st:
                m = _CHILD_UUID_RE.search(st)
                if m:
                    child_id = m.group(1)
                    if child_id not in child_to_parent:
                        child_to_parent[child_id] = wf_id
                    break   # one child per parent is enough

    if child_to_parent:
        child_ids = list(child_to_parent.keys())
        logger.info(f"    Fetching {len(child_ids)} child workflow log(s)...")
        child_should: list = [{"terms": {"correlationId.keyword": child_ids}}]
        for cid in child_ids[:30]:
            child_should.append({"match_phrase": {"message": cid}})
        try:
            r3 = client.search(index="platform-*", body={
                "size": min(len(child_ids) * 10, 1000),
                "sort": [{"@timestamp": {"order": "asc"}}],
                "_source": ["@timestamp", "message", "level", "correlationId",
                            "workflowName", "processName", "stack_trace", "exception"],
                "query": {
                    "bool": {
                        "must": [{"range": {"@timestamp": {"gte": start, "lte": end}}}],
                        "should": child_should,
                        "minimum_should_match": 1,
                    }
                },
            })
            for hit in r3.get("hits", {}).get("hits", []):
                src = hit["_source"]
                # Match hit to child_id by correlationId or message text
                matched_child = None
                corr = str(src.get("correlationId") or "")
                if corr in child_to_parent:
                    matched_child = corr
                else:
                    msg = str(src.get("message") or "")
                    for cid in child_ids:
                        if cid in msg:
                            matched_child = cid
                            break
                if matched_child:
                    parent_id = child_to_parent[matched_child]
                    src["_from_child_workflow"] = matched_child
                    detail[parent_id].append(src)
        except Exception as e:
            logger.warning(f"  Child workflow step3 error: {e}")

    # ── Build results using score-based best-log selection ────────────────────
    results: list[dict] = []
    for wf_id, meta in wf_meta.items():
        logs = detail.get(wf_id, [])

        # Pick the single most informative log using scoring
        best = max(logs, key=_score_error_log) if logs else {}

        # error_message: prefer the best-scored log's message (most specific error)
        error_msg = str(best.get("message") or "")[:500]

        # exception: prefer stack_trace, fall back to exception field
        exception_raw = str(best.get("stack_trace") or best.get("exception") or "")[:1500]

        # Extract the most specific cause line for classification.
        # When the exception is ChildWorkflowFailure or WorkflowFailedException,
        # the outer line is just a wrapper — find the innermost "Caused by:" instead.
        cause_line = ""
        if any(x in exception_raw for x in ["ChildWorkflowFailure", "WorkflowFailedException"]):
            for line in reversed(exception_raw.split("\n")):
                stripped = line.strip()
                if stripped.startswith("Caused by:"):
                    cause_line = stripped[len("Caused by:"):].strip()
                    break
        if not cause_line:
            for line in exception_raw.split("\n"):
                stripped = line.strip()
                if stripped and not stripped.startswith("at ") and not stripped.startswith("..."):
                    cause_line = stripped
                    break

        root_cause, suggested_fix = _classify_root_cause(error_msg, cause_line or exception_raw)

        # Fill processName / workflowName from detail logs if still empty
        pname = meta["process_name"]
        wname = meta["workflow_name"]
        for log in logs:
            if not pname and log.get("processName"):
                pname = str(log["processName"])
            if not wname and log.get("workflowName"):
                wname = str(log["workflowName"])
            if pname and wname:
                break

        results.append({
            "workflow_id":    wf_id,
            "process_name":   pname,
            "workflow_name":  wname,
            "start_time":     meta["start_time"],
            "startDateUtc":   None,
            "end_time":       meta["end_time"],
            "duration_ms":    None,
            "failed_step":    wname or "",
            "error_message":  error_msg,
            "exception":      exception_raw,
            "root_cause":     root_cause,
            "suggested_fix":  suggested_fix,
            "error_summary":  "",   # filled by Claude below if available
            "status":         "FAILED",
        })

    # ── Step 3: heuristic enrichment (fills error_summary from logs) ──────────
    if results:
        _heuristic_enrich_workflows(results, detail)

    failed = len(results)
    logger.info(f"    → {failed} failed execution(s)")
    return {
        "results":   results,
        "running":   0,
        "completed": 0,
        "failed":    failed,
        "totalSize": failed,
    }


def _heuristic_enrich_workflows(results: list[dict], detail: dict[str, list]) -> None:
    """
    Fill `error_summary` from the first meaningful line of the error/stack trace.
    `root_cause` and `suggested_fix` are already set by _classify_root_cause.
    """
    for r in results:
        if r.get("error_summary"):
            continue
        # Prefer a 'Caused by:' line (innermost real error). Fall back to the
        # first non-'at ' line of exception, then the first log message.
        summary = ""
        exc = str(r.get("exception") or "")
        for line in reversed(exc.split("\n")):
            s = line.strip()
            if s.startswith("Caused by:"):
                summary = s[len("Caused by:"):].strip()
                break
        if not summary:
            for line in exc.split("\n"):
                s = line.strip()
                if s and not s.startswith("at ") and not s.startswith("..."):
                    summary = s
                    break
        if not summary:
            for log in detail.get(r["workflow_id"], []):
                msg = str(log.get("message") or "").strip()
                if msg:
                    summary = msg
                    break
        if not summary:
            summary = str(r.get("error_message") or "Workflow execution failed")
        r["error_summary"] = summary[:240]


def _fetch_tenant_applications(jiffy_cfg: dict, token: str, tenant_name: str) -> list[dict]:
    """
    Return a list of application objects for the given tenant from the Jiffy API.
    Paginates through /pam/tenant/{tenantName}/app/list until all apps are fetched.
    """
    base = jiffy_cfg["url"].rstrip("/")
    limit = 20
    offset = 0
    all_apps: list[dict] = []

    while True:
        response = httpx.get(
            f"{base}/pam/tenant/{tenant_name}/app/list",
            params={"offset": offset, "limit": limit, "inst": "true"},
            headers={"Authorization": f"Bearer {token}", "Origin": "jiffy.ai"},
            timeout=15,
        )
        response.raise_for_status()
        data = response.json()

        # Normalise various response shapes the API might return
        rows: list = data if isinstance(data, list) else (
            data.get("apps") or data.get("applications") or data.get("data") or []
        )

        all_apps.extend(rows)

        # Stop if we received fewer items than the page size (last page)
        if len(rows) < limit:
            break
        offset += limit

    return all_apps


# ---------------------------------------------------------------------------
# OpenSearch helpers
# ---------------------------------------------------------------------------

def _build_opensearch_client(os_cfg: dict) -> OpenSearch:
    # Strip scheme if the host was configured as a full URL (e.g. https://host.example.com)
    host = os_cfg["host"]
    for prefix in ("https://", "http://"):
        if host.startswith(prefix):
            host = host[len(prefix):]
            break
    host = host.rstrip("/")

    return OpenSearch(
        hosts=[{"host": host, "port": os_cfg.get("port", 443)}],
        http_auth=(os_cfg.get("username"), os_cfg.get("password")),
        use_ssl=os_cfg.get("use_ssl", True),
        verify_certs=os_cfg.get("verify_certs", True),
        headers={"securitytenant": "global"},
        timeout=30,
    )


def _fetch_istio_logs(
    client: OpenSearch,
    os_cfg: dict,
    inst_id: Optional[str],
    start: str,
    end: str,
) -> dict:
    """
    Fetch ingress access logs for one application instance.

    Filter shape: appId (instance UUID) + kubernetes.pod_name LIKE 'istio-ingress*'.
    This isolates external user-facing traffic to a single app instance even when
    multiple apps share the same tenant authority (e.g. dev.axosclearing.jiffy.ai
    serves several apps; the access log carries the per-request appId so we can
    split them). The istio-ingress pod filter excludes service-mesh sidecar logs
    where the same authority/appId combination shows up for internal calls.

    Returns:
        {
            "logs":          up to max_logs_per_query sample for path / latency /
                             pod analysis,
            "total_count":   accurate total via track_total_hits,
            "status_counts": {response_code: count} via aggregation — accurate
                             across the whole window, not just the sample.
        }
    """
    if not inst_id:
        return {"logs": [], "total_count": 0, "status_counts": {}}

    index_pattern = os_cfg.get("index_pattern", "platform-*")
    max_logs = os_cfg.get("max_logs_per_query", 1000)
    source_fields = os_cfg.get("source_fields", [
        "@timestamp", "start_time", "response_code", "response_code_details",
        "response_flags", "duration", "bytes_received", "bytes_sent",
        "upstream_cluster", "authority", "path", "method", "protocol",
        "user_agent", "x_forwarded_for", "request_id",
        "downstream_remote_address", "downstream_local_address",
        "kubernetes.namespace_name", "kubernetes.pod_name",
    ])

    must_clauses: list = [
        {"range":    {"@timestamp": {"gte": start, "lte": end}}},
        {"term":     {"appId.keyword": inst_id}},
        {"wildcard": {"kubernetes.pod_name.keyword": "istio-ingress*"}},
    ]

    query = {
        "size": max_logs,
        "track_total_hits": True,
        "sort": [{"@timestamp": {"order": "asc"}}],
        "query": {"bool": {"must": must_clauses}},
        "_source": source_fields,
        "aggs": {
            "by_status": {"terms": {"field": "response_code", "size": 50}},
        },
    }

    logger.debug(f"OpenSearch query: {json.dumps(query)}")
    response = client.search(index=index_pattern, body=query)
    total = response.get("hits", {}).get("total", {}).get("value", 0)
    logs = [hit["_source"] for hit in response.get("hits", {}).get("hits", [])]
    status_counts = {
        str(b["key"]): b["doc_count"]
        for b in response.get("aggregations", {}).get("by_status", {}).get("buckets", [])
    }
    logger.info(
        f"  Ingress access logs: total={total}  sampled={len(logs)}  "
        f"status={status_counts}"
    )
    return {"logs": logs, "total_count": total, "status_counts": status_counts}


# ---------------------------------------------------------------------------
# Platform application logs (non-Istio: workhorse, Java, etc.)
# ---------------------------------------------------------------------------

def _fetch_platform_app_logs(
    client: OpenSearch,
    inst_id: str,
    start: str,
    end: str,
    max_hits: int = 500,
) -> list[dict]:
    """
    Fetch platform-level application logs (from workhorse, Java SDK, etc.)
    filtered by appId. These are NOT Istio ingress logs — they contain
    workflow execution messages, stack traces, and application-level errors
    that Istio logs miss because they lack the 'authority' field.
    """
    if not inst_id:
        return []

    query = {
        "size": max_hits,
        "sort": [{"@timestamp": {"order": "desc"}}],
        "_source": [
            "@timestamp", "message", "level", "correlationId",
            "workflowName", "processName", "appId", "tenantId",
            "logger_name", "stack_trace", "exception",
            "authority", "response_code",
        ],
        "query": {
            "bool": {
                "must": [
                    {"range": {"@timestamp": {"gte": start, "lte": end}}},
                    {"term": {"appId.keyword": inst_id}},
                ],
                "should": [
                    {"term":         {"level.keyword": "ERROR"}},
                    {"term":         {"level.keyword": "WARN"}},
                    {"match_phrase": {"message": "Workflow execution failed"}},
                    {"match_phrase": {"message": "Workflow execution failure"}},
                    {"match_phrase": {"message": "WorkflowException"}},
                    {"match_phrase": {"message": "Exception"}},
                    {"exists":       {"field": "stack_trace"}},
                ],
                "minimum_should_match": 1,
            }
        },
    }

    try:
        response = client.search(index="platform-*", body=query)
    except Exception as e:
        logger.warning(f"  Platform app logs query error: {e}")
        return []

    hits = response.get("hits", {}).get("hits", [])
    logger.info(f"  Platform app logs: {len(hits)} error/warn entries found")
    return [hit["_source"] for hit in hits]


# ---------------------------------------------------------------------------
# Failed workflow extraction
# ---------------------------------------------------------------------------

def _fetch_workflow_total(
    client: OpenSearch,
    inst_id: str,
    start: str,
    end: str,
) -> int:
    """Cardinality of correlationId for this app's appId in [start, end].

    Pre-computed at batch time so the Tenant & Apps page can read it from
    Mongo (sum across runs in window) instead of running a live OpenSearch
    aggregation across every inst_id on each page load. Each Lambda run
    analyses a non-overlapping 30-min window so simple `$sum` across runs
    gives the exact unique workflow count for any longer window.
    """
    if not inst_id:
        return 0
    try:
        r = client.search(index="platform-*", body={
            "size": 0,
            "query": {"bool": {"must": [
                {"range":  {"@timestamp": {"gte": start, "lte": end}}},
                {"term":   {"appId.keyword": inst_id}},
                {"exists": {"field": "correlationId"}},
            ]}},
            "aggs": {"wf": {"cardinality": {
                "field": "correlationId.keyword",
                "precision_threshold": 40000,
            }}},
        })
        return int(r.get("aggregations", {}).get("wf", {}).get("value", 0) or 0)
    except Exception as e:
        logger.warning(f"  workflow_total query error: {e}")
        return 0


def _fetch_failed_workflows(
    client: OpenSearch,
    inst_id: str,
    start: str,
    end: str,
    max_hits: int = 200,
) -> list[dict]:
    """
    Query the platform-* index for workflow execution failures for a given app instance.
    Uses inst_id (instance UUID) as the appId filter — this matches the appId field
    in OpenSearch platform logs.
    """
    index_pattern = "platform-*"

    must_clauses: list = [
        {"range": {"@timestamp": {"gte": start, "lte": end}}},
    ]
    if inst_id:
        must_clauses.append({"term": {"appId.keyword": inst_id}})

    should_clauses = [
        # Primary conditions
        {"term":         {"status.keyword": "Failed"}},
        {"match_phrase": {"message": "WORKFLOW_EXECUTION_FAILED"}},
        {"match_phrase": {"message": "Workflow execution failed"}},
        {"match_phrase": {"message": "Workflow execution failure"}},
        {"match_phrase": {"message": "Work FLow execution Failed"}},
        # Error conditions
        {"term":         {"level.keyword": "ERROR"}},
        {"match_phrase": {"message": "JOB UNEXPECTED ERROR"}},
        {"terms":        {"httpCode": [500, 502, 503, 504]}},
        # Supporting conditions
        {"match_phrase": {"message": "Failed to execute"}},
        {"match_phrase": {"message": "WorkflowException"}},
        {"match_phrase": {"message": "Exception"}},
        {"match_phrase": {"message": "exception"}},
    ]

    query = {
        "size": max_hits,
        "sort": [{"@timestamp": {"order": "desc"}}],
        "_source": [
            "@timestamp", "message", "level", "correlationId",
            "workflowName", "processName", "appId", "tenantId", "logger_name",
        ],
        "query": {
            "bool": {
                "must": must_clauses,
                "should": should_clauses,
                "minimum_should_match": 1,
            }
        },
    }

    try:
        response = client.search(index=index_pattern, body=query)
    except Exception as e:
        logger.warning(f"  Failed workflow query error: {e}")
        return []

    _wf_re = re.compile(r"((?:Jiffy|JM)_\d+)")
    results: list[dict] = []
    seen_ids: set = set()

    for hit in response.get("hits", {}).get("hits", []):
        src = hit["_source"]
        msg = src.get("message", "")

        # Resolve workflow ID — prefer correlationId field, fall back to regex on message
        wf_id = str(src.get("correlationId") or "")
        if not _wf_re.match(wf_id):
            m = _wf_re.search(msg)
            wf_id = m.group(1) if m else ""

        if not wf_id:
            continue
        if wf_id in seen_ids:
            continue
        seen_ids.add(wf_id)

        # Determine reason — first 300 chars of message
        reason = msg[:300].strip()

        results.append({
            "workflowId":   wf_id,
            "status":       "FAILED",
            "processName":  src.get("processName") or "",
            "workflowName": src.get("workflowName") or "",
            "reason":       reason,
            "timestamp":    src.get("@timestamp") or "",
            "appId":        src.get("appId") or inst_id,
        })

    # ── Orphan recovery: find failure logs WITHOUT appId and verify ownership ──
    if inst_id:
        try:
            r_orphan = client.search(index=index_pattern, body={
                "size": max_hits,
                "sort": [{"@timestamp": {"order": "desc"}}],
                "_source": ["@timestamp", "message", "level", "correlationId",
                            "workflowName", "processName"],
                "query": {
                    "bool": {
                        "must": [{"range": {"@timestamp": {"gte": start, "lte": end}}}],
                        "must_not": [{"exists": {"field": "appId"}}],
                        "should": [
                            {"match_phrase": {"message": "Workflow execution failure"}},
                            {"match_phrase": {"message": "Workflow execution failed"}},
                            {"match_phrase": {"message": "WorkflowException"}},
                            {"match_phrase": {"message": "WORKFLOW_EXECUTION_FAILED"}},
                        ],
                        "minimum_should_match": 1,
                    }
                },
            })
            orphan_ids: set[str] = set()
            orphan_data: dict[str, dict] = {}
            for hit in r_orphan.get("hits", {}).get("hits", []):
                src = hit["_source"]
                msg = str(src.get("message") or "")
                corr = str(src.get("correlationId") or "")
                m = _wf_re.search(corr) or _wf_re.search(msg)
                if not m:
                    continue
                wf_id = m.group(1)
                if wf_id in seen_ids:
                    continue
                orphan_ids.add(wf_id)
                if wf_id not in orphan_data:
                    orphan_data[wf_id] = {
                        "msg": msg[:300].strip(),
                        "ts": src.get("@timestamp") or "",
                        "proc": src.get("processName") or "",
                        "wname": src.get("workflowName") or "",
                    }

            # Verify orphans belong to this app
            if orphan_ids:
                verify_should = []
                for wf_id in list(orphan_ids)[:200]:
                    verify_should.append({"match_phrase": {"correlationId": wf_id}})
                rv = client.search(index=index_pattern, body={
                    "size": len(orphan_ids) * 3,
                    "_source": ["correlationId", "appId"],
                    "query": {
                        "bool": {
                            "must": [
                                {"range": {"@timestamp": {"gte": start, "lte": end}}},
                                {"term": {"appId.keyword": inst_id}},
                            ],
                            "should": verify_should,
                            "minimum_should_match": 1,
                        }
                    },
                })
                for hit in rv.get("hits", {}).get("hits", []):
                    corr = str(hit["_source"].get("correlationId") or "")
                    m = _wf_re.search(corr)
                    if m and m.group(1) in orphan_ids:
                        wf_id = m.group(1)
                        if wf_id not in seen_ids:
                            seen_ids.add(wf_id)
                            d = orphan_data.get(wf_id, {})
                            results.append({
                                "workflowId":   wf_id,
                                "status":       "FAILED",
                                "processName":  d.get("proc", ""),
                                "workflowName": d.get("wname", ""),
                                "reason":       d.get("msg", ""),
                                "timestamp":    d.get("ts", ""),
                                "appId":        inst_id,
                            })
        except Exception as e:
            logger.warning(f"  Failed workflow orphan recovery error: {e}")

    return results


# ---------------------------------------------------------------------------
# Sweep: discover ALL failed workflows via master "failure" pattern
# ---------------------------------------------------------------------------

def _sweep_all_failed_workflows(
    client: OpenSearch,
    start: str,
    end: str,
    inst_id_to_label: dict[str, str],
    max_hits: int = 3000,
) -> dict[str, list[dict]]:
    """
    Two-query sweep that discovers ALL failed workflows in the time range:

      Query A — "Workflow execution failure WorkflowId=" → master list of
                all failed workflow IDs + stack_trace / error details.
      Query B — "Work Flow execution Failed" → corresponding logs that embed
                tenantId and AppId in the message text.

    Returns {inst_id: [workflow_dict, ...]} only for inst_ids present
    in *inst_id_to_label* (i.e. belonging to the tenant being analysed).
    """
    _WF_RE     = re.compile(r"((?:Jiffy|JM)_\d+)")
    _TENANT_RE = re.compile(r"tenantId[:\s]+([a-f0-9\-]{36})", re.IGNORECASE)
    _APPID_RE  = re.compile(r"AppId[:\s]+([a-f0-9\-]{36})", re.IGNORECASE)

    # ── Query A: all "Workflow execution failure" logs ───────────────────────
    try:
        rA = client.search(index="platform-*", body={
            "size": max_hits,
            "sort": [{"@timestamp": {"order": "desc"}}],
            "_source": ["@timestamp", "message", "level", "correlationId",
                        "processName", "workflowName", "stack_trace"],
            "query": {
                "bool": {
                    "must": [
                        {"range": {"@timestamp": {"gte": start, "lte": end}}},
                        {"match_phrase": {"message": "Workflow execution failure WorkflowId="}},
                    ],
                }
            },
        })
    except Exception as e:
        logger.warning(f"  Sweep query A error: {e}")
        return {}

    # Extract workflow IDs + error info from query A
    wf_info: dict[str, dict] = {}   # wf_id → {ts, process, wf_name, stack, msg}
    for hit in rA.get("hits", {}).get("hits", []):
        src = hit["_source"]
        msg = str(src.get("message") or "")
        wf_id = _extract_wf_id(str(src.get("correlationId") or ""), msg)
        if not wf_id:
            continue
        if wf_id not in wf_info:
            wf_info[wf_id] = {
                "timestamp":     src.get("@timestamp") or "",
                "process_name":  str(src.get("processName") or ""),
                "workflow_name": str(src.get("workflowName") or ""),
                "stack_trace":   str(src.get("stack_trace") or "")[:1500],
                "error_message": msg[:500],
            }

    if not wf_info:
        return {}

    logger.info(f"  Sweep query A: {len(wf_info)} unique failed workflow(s) discovered")

    # ── Query B: "Work Flow execution Failed" logs with appId/tenantId ───────
    try:
        rB = client.search(index="platform-*", body={
            "size": max_hits,
            "sort": [{"@timestamp": {"order": "desc"}}],
            "_source": ["@timestamp", "message", "correlationId", "appId",
                        "tenantId", "processName"],
            "query": {
                "bool": {
                    "must": [
                        {"range": {"@timestamp": {"gte": start, "lte": end}}},
                    ],
                    "should": [
                        {"match_phrase": {"message": "Work Flow execution Failed"}},
                        {"match_phrase": {"message": "Workflow execution failed"}},
                    ],
                    "minimum_should_match": 1,
                }
            },
        })
    except Exception as e:
        logger.warning(f"  Sweep query B error: {e}")
        return {}

    # Map workflow ID → appId  (from structured field OR message text)
    wf_ownership: dict[str, str] = {}   # wf_id → appId
    for hit in rB.get("hits", {}).get("hits", []):
        src = hit["_source"]
        msg = str(src.get("message") or "")
        corr = str(src.get("correlationId") or "")
        wf_id = _extract_wf_id(corr, msg)
        if not wf_id:
            continue
        if wf_id in wf_ownership:
            continue

        # Try structured appId field first
        app_id = str(src.get("appId") or "").strip()
        if not app_id:
            # Parse from message text: "... AppId: <uuid>"
            am = _APPID_RE.search(msg)
            app_id = am.group(1) if am else ""

        if not app_id:
            continue

        # Enrich process name from query B if missing from query A
        if wf_id in wf_info and not wf_info[wf_id]["process_name"]:
            proc = str(src.get("processName") or "")
            if proc:
                wf_info[wf_id]["process_name"] = proc

        wf_ownership[wf_id] = app_id

    logger.info(f"  Sweep query B: resolved appId for {len(wf_ownership)}/{len(wf_info)} workflow(s)")

    # ── Build per-inst_id results, only for the tenant being analysed ────────
    per_inst: dict[str, list[dict]] = {}
    for wf_id, info in wf_info.items():
        app_id = wf_ownership.get(wf_id)
        if not app_id or app_id not in inst_id_to_label:
            continue  # belongs to a different tenant

        # Build root_cause from stack_trace
        st = info.get("stack_trace") or ""
        cause = ""
        for line in st.split("\n"):
            stripped = line.strip()
            if stripped and not stripped.startswith("at ") and not stripped.startswith("..."):
                cause = stripped
                break

        root_cause, suggested_fix = _classify_root_cause(info["error_message"], cause or st)

        entry = {
            "workflow_id":    wf_id,
            "process_name":   info["process_name"],
            "workflow_name":  info["workflow_name"],
            "start_time":     info["timestamp"],
            "startDateUtc":   None,
            "end_time":       info["timestamp"],
            "duration_ms":    None,
            "failed_step":    info["workflow_name"] or "",
            "error_message":  info["error_message"],
            "exception":      info["stack_trace"],
            "root_cause":     root_cause,
            "suggested_fix":  suggested_fix,
            "error_summary":  "",
            "status":         "FAILED",
        }
        per_inst.setdefault(app_id, []).append(entry)

    for iid, wfs in per_inst.items():
        logger.info(f"  Sweep: {inst_id_to_label.get(iid, iid)} → {len(wfs)} workflow(s)")

    return per_inst


# ---------------------------------------------------------------------------
# Claude prompt builders
# ---------------------------------------------------------------------------

def _pct(lst: list, p: int) -> Optional[float]:
    if not lst:
        return None
    idx = int(len(lst) * p / 100)
    return round(lst[min(idx, len(lst) - 1)], 2)


def _compute_timeseries(logs: list[dict], bucket_mins: int = 15, max_error_samples: int = 20) -> list[dict]:
    """
    Bucket logs into fixed-width time intervals and compute per-bucket
    request count, error count, avg latency, p95 latency, and a capped
    list of error sample documents for drill-down from the UI.
    Returns a list of dicts sorted by timestamp ascending.
    """
    buckets: dict[str, dict] = {}
    for log in logs:
        ts_raw = log.get("@timestamp")
        if not ts_raw:
            continue
        try:
            dt = datetime.fromisoformat(str(ts_raw).replace("Z", "+00:00"))
        except ValueError:
            continue
        # Round down to the nearest bucket boundary
        floored_min = (dt.minute // bucket_mins) * bucket_mins
        bucket_dt = dt.replace(minute=floored_min, second=0, microsecond=0)
        key = bucket_dt.isoformat()
        if key not in buckets:
            buckets[key] = {
                "ts": key, "requests": 0, "errors": 0, "durations": [],
                "error_samples": [], "status_counts": Counter(), "path_error_counts": Counter(),
            }
        b = buckets[key]
        b["requests"] += 1
        code = str(log.get("response_code") or "")
        if code.startswith("4") or code.startswith("5"):
            b["errors"] += 1
            b["status_counts"][code] += 1
            path = log.get("path") or ""
            if path:
                b["path_error_counts"][path] += 1
            if len(b["error_samples"]) < max_error_samples:
                b["error_samples"].append({
                    "timestamp": str(ts_raw),
                    "path": path,
                    "method": log.get("method"),
                    "response_code": log.get("response_code"),
                    "response_flags": log.get("response_flags"),
                    "response_code_details": log.get("response_code_details"),
                    "duration": log.get("duration"),
                    "upstream_cluster": log.get("upstream_cluster"),
                    "request_id": log.get("request_id"),
                })
        dur = log.get("duration")
        if dur is not None:
            try:
                b["durations"].append(float(dur))
            except (TypeError, ValueError):
                pass

    result = []
    for key in sorted(buckets):
        b = buckets[key]
        durs = sorted(b["durations"])
        n = len(durs)
        result.append({
            "ts": b["ts"],
            "requests": b["requests"],
            "errors": b["errors"],
            "avg_latency_ms": round(sum(durs) / n, 1) if n else None,
            "p95_latency_ms": round(durs[min(int(n * 0.95), n - 1)], 1) if n else None,
            "error_samples": b["error_samples"],
            "error_status_counts": dict(b["status_counts"].most_common()),
            "error_top_paths": [
                {"path": p, "count": c} for p, c in b["path_error_counts"].most_common(10)
            ],
        })
    return result


def _compute_metrics(logs: list[dict]) -> dict:
    """
    Compute comprehensive app-level metrics covering:
    traffic, availability, errors, latency, endpoints, workflow,
    bandwidth, upstream health, pod distribution, and who (client) data.
    """
    total = len(logs)
    if not total:
        return {"total_requests": 0}

    # ── Time range & request rate ──────────────────────────────────────────
    timestamps: list[datetime] = []
    for log in logs:
        ts = log.get("@timestamp")
        if ts:
            try:
                timestamps.append(datetime.fromisoformat(str(ts).replace("Z", "+00:00")))
            except ValueError:
                pass
    timestamps.sort()

    duration_mins = 0.0
    if len(timestamps) >= 2:
        duration_mins = (timestamps[-1] - timestamps[0]).total_seconds() / 60

    req_per_min = round(total / duration_mins, 2) if duration_mins > 0 else float(total)

    # ── Availability: gaps > 5 min with no traffic ─────────────────────────
    downtime_gaps = []
    for i in range(1, len(timestamps)):
        gap_mins = (timestamps[i] - timestamps[i - 1]).total_seconds() / 60
        if gap_mins > 5:
            downtime_gaps.append({
                "from": timestamps[i - 1].isoformat(),
                "to": timestamps[i].isoformat(),
                "gap_mins": round(gap_mins, 1),
            })

    # ── Response codes & errors ────────────────────────────────────────────
    status_counts: Counter = Counter()
    failure_reasons: Counter = Counter()
    flag_counts: Counter = Counter()
    for log in logs:
        status_counts[str(log.get("response_code") or "unknown")] += 1
        detail = log.get("response_code_details")
        if detail and detail not in ("-", None, ""):
            failure_reasons[str(detail)] += 1
        flag = log.get("response_flags")
        if flag and flag not in ("-", None, ""):
            flag_counts[str(flag)] += 1

    errors_4xx = sum(v for k, v in status_counts.items() if k.startswith("4"))
    errors_5xx = sum(v for k, v in status_counts.items() if k.startswith("5"))

    # ── Latency ────────────────────────────────────────────────────────────
    durations: list[float] = []
    upstream_times: list[float] = []
    for log in logs:
        for val, target in ((log.get("duration"), durations),
                            (log.get("upstream_service_time"), upstream_times)):
            if val is not None:
                try:
                    target.append(float(val))
                except (TypeError, ValueError):
                    pass
    durations.sort()
    upstream_times.sort()

    # ── Top endpoints ──────────────────────────────────────────────────────
    path_counts: Counter = Counter()
    path_errors: Counter = Counter()
    path_durations: dict[str, list[float]] = {}
    for log in logs:
        path = str(log.get("path") or "").split("?")[0]
        if not path:
            continue
        path_counts[path] += 1
        if str(log.get("response_code", "")).startswith(("4", "5")):
            path_errors[path] += 1
        d = log.get("duration")
        if d is not None:
            try:
                path_durations.setdefault(path, []).append(float(d))
            except (TypeError, ValueError):
                pass

    top_by_traffic = [
        {"path": p, "count": c,
         "avg_duration_ms": round(sum(path_durations.get(p, [0])) / len(path_durations.get(p, [1])), 2)}
        for p, c in path_counts.most_common(10)
    ]
    top_by_errors = [
        {"path": p, "error_count": c,
         "error_rate_pct": round(c / path_counts[p] * 100, 2)}
        for p, c in path_errors.most_common(10)
    ]

    # ── Workflow ───────────────────────────────────────────────────────────
    workflow_prefixes = ("/workflow", "/platform/workflow")
    wf_logs = [l for l in logs if str(l.get("path") or "").startswith(workflow_prefixes)]
    wf_errors = sum(1 for l in wf_logs if str(l.get("response_code", "")).startswith(("4", "5")))
    wf_durations = sorted(
        float(l["duration"]) for l in wf_logs
        if l.get("duration") is not None
        and str(l["duration"]).replace(".", "", 1).isdigit()
    )

    # Per-step workflow breakdown: group by path, track upstreams/pods/timing
    wf_step_map: dict[str, dict] = {}
    for l in wf_logs:
        path = str(l.get("path") or "").split("?")[0]
        code = str(l.get("response_code", ""))
        uc   = str(l.get("upstream_cluster") or "")
        uh   = str(l.get("upstream_host")    or "")
        ts   = str(l.get("@timestamp")       or "")
        k8s  = l.get("kubernetes") or {}
        pod  = str(k8s.get("pod_name") or "") if isinstance(k8s, dict) else ""
        dur  = l.get("duration")
        if path not in wf_step_map:
            wf_step_map[path] = {
                "path": path, "calls": 0, "errors": 0, "durations": [],
                "upstreams": set(), "upstream_hosts": set(), "pods": set(),
                "failure_reasons": Counter(),
                "first_seen": ts, "last_seen": ts,
            }
        s = wf_step_map[path]
        s["calls"] += 1
        if code.startswith(("4", "5")):
            s["errors"] += 1
            reason = str(l.get("response_code_details") or "")
            if reason and reason not in ("-", ""):
                s["failure_reasons"][reason] += 1
        if uc:  s["upstreams"].add(uc)
        if uh:  s["upstream_hosts"].add(uh)
        if pod: s["pods"].add(pod)
        if dur is not None:
            try: s["durations"].append(float(dur))
            except (TypeError, ValueError): pass
        if ts:
            if not s["first_seen"] or ts < s["first_seen"]: s["first_seen"] = ts
            if ts > s["last_seen"]: s["last_seen"] = ts

    wf_steps = []
    for path, s in sorted(wf_step_map.items(), key=lambda x: x[1].get("first_seen") or ""):
        durs = sorted(s["durations"])
        n = len(durs)
        wf_steps.append({
            "path":             s["path"],
            "calls":            s["calls"],
            "errors":           s["errors"],
            "error_rate_pct":   round(s["errors"] / s["calls"] * 100, 2) if s["calls"] else 0,
            "avg_duration_ms":  round(sum(durs) / n, 1) if n else None,
            "p95_duration_ms":  round(durs[min(int(n * 0.95), n - 1)], 1) if n else None,
            "upstreams":        sorted(s["upstreams"]),
            "upstream_hosts":   sorted(s["upstream_hosts"]),
            "pods":             sorted(s["pods"]),
            "failure_reasons":  dict(s["failure_reasons"].most_common(5)),
            "first_seen":       s["first_seen"],
            "last_seen":        s["last_seen"],
        })

    # ── Bandwidth ──────────────────────────────────────────────────────────
    bytes_sent = sum(int(l.get("bytes_sent") or 0) for l in logs)
    bytes_received = sum(int(l.get("bytes_received") or 0) for l in logs)

    # ── Upstream service health ────────────────────────────────────────────
    upstream_req: Counter = Counter()
    upstream_err: Counter = Counter()
    for log in logs:
        uc = log.get("upstream_cluster")
        if uc:
            upstream_req[uc] += 1
            if str(log.get("response_code", "")).startswith(("4", "5")):
                upstream_err[uc] += 1

    upstream_deps = [
        {
            "cluster": uc,
            "requests": upstream_req[uc],
            "errors": upstream_err.get(uc, 0),
            "error_rate_pct": round(upstream_err.get(uc, 0) / upstream_req[uc] * 100, 2),
        }
        for uc, _ in upstream_req.most_common(10)
    ]

    # ── Pod distribution ───────────────────────────────────────────────────
    pod_counts: Counter = Counter()
    pod_stats_map: dict[str, dict] = {}
    for log in logs:
        k8s = log.get("kubernetes")
        pod = k8s.get("pod_name") if isinstance(k8s, dict) else None
        if not pod:
            continue
        pod_counts[pod] += 1
        s = pod_stats_map.setdefault(pod, {
            "requests": 0, "errors_4xx": 0, "errors_5xx": 0,
            "durations": [], "authorities": set(),
            "namespace": (k8s.get("namespace_name") if isinstance(k8s, dict) else None) or "",
        })
        s["requests"] += 1
        code = str(log.get("response_code", ""))
        if code.startswith("4"):   s["errors_4xx"] += 1
        elif code.startswith("5"): s["errors_5xx"] += 1
        dur = log.get("duration")
        if dur is not None:
            try: s["durations"].append(float(dur))
            except (TypeError, ValueError): pass
        auth = log.get("authority")
        if auth: s["authorities"].add(str(auth))

    pod_stats = []
    for pod, s in pod_stats_map.items():
        durs = sorted(s["durations"])
        n = len(durs)
        errors = s["errors_4xx"] + s["errors_5xx"]
        pod_stats.append({
            "pod":            pod,
            "namespace":      s["namespace"],
            "requests":       s["requests"],
            "errors_4xx":     s["errors_4xx"],
            "errors_5xx":     s["errors_5xx"],
            "errors":         errors,
            "error_rate_pct": round(errors / s["requests"] * 100, 2) if s["requests"] else 0,
            "avg_latency_ms": round(sum(durs) / n, 1) if n else None,
            "p95_latency_ms": round(durs[min(int(n * 0.95), n - 1)], 1) if n else None,
            "authorities":    sorted(s["authorities"]),
        })
    pod_stats.sort(key=lambda p: p["requests"], reverse=True)

    # ── WHO: client IPs ────────────────────────────────────────────────────
    ip_counts: Counter = Counter()
    for log in logs:
        xff = str(log.get("x_forwarded_for") or "")
        ip = xff.split(",")[0].strip()
        if ip:
            ip_counts[ip] += 1

    # ── WHO: user agents & bot detection ───────────────────────────────────
    ua_counts: Counter = Counter()
    bot_keywords = ("bot", "crawler", "spider", "python-httpx", "python-requests",
                    "curl", "wget", "go-http-client", "java", "okhttp", "postman")
    bot_count = 0
    for log in logs:
        ua = str(log.get("user_agent") or "unknown")
        ua_counts[ua] += 1
        if any(kw in ua.lower() for kw in bot_keywords):
            bot_count += 1

    # ── WHO: user-id & tenant-id (populated when IAM enriches logs) ────────
    user_id_counts: Counter = Counter()
    tenant_id_counts: Counter = Counter()
    for log in logs:
        uid = log.get("user-id")
        if uid:
            user_id_counts[str(uid)] += 1
        tid = log.get("tenant-id")
        if tid:
            tenant_id_counts[str(tid)] += 1

    # ── Peak hours (UTC) ───────────────────────────────────────────────────
    hour_counts: Counter = Counter(ts.hour for ts in timestamps)

    return {
        # Traffic
        "total_requests": total,
        "request_rate_per_min": req_per_min,
        "time_range_mins": round(duration_mins, 1),

        # Availability
        "downtime_gap_count": len(downtime_gaps),
        "downtime_gaps": downtime_gaps,

        # Errors
        "response_code_distribution": dict(status_counts.most_common()),
        "error_4xx_count": errors_4xx,
        "error_5xx_count": errors_5xx,
        "error_rate_pct": round((errors_4xx + errors_5xx) / total * 100, 2),
        "failure_reasons": dict(failure_reasons.most_common(10)),
        "response_flags": dict(flag_counts.most_common(10)),

        # Latency
        "latency_ms": {
            "avg": round(sum(durations) / len(durations), 2) if durations else None,
            "p50": _pct(durations, 50),
            "p95": _pct(durations, 95),
            "p99": _pct(durations, 99),
            "max": round(max(durations), 2) if durations else None,
        },
        "upstream_processing_ms": {
            "avg": round(sum(upstream_times) / len(upstream_times), 2) if upstream_times else None,
            "p95": _pct(upstream_times, 95),
        },

        # Endpoints
        "top_endpoints_by_traffic": top_by_traffic,
        "top_endpoints_by_errors": top_by_errors,

        # Workflow
        "workflow": {
            "total_requests": len(wf_logs),
            "error_count":    wf_errors,
            "success_count":  len(wf_logs) - wf_errors,
            "error_rate_pct": round(wf_errors / len(wf_logs) * 100, 2) if wf_logs else 0,
            "latency_ms": {
                "avg": round(sum(wf_durations) / len(wf_durations), 2) if wf_durations else None,
                "p95": _pct(wf_durations, 95),
            },
            "steps": wf_steps,
        },

        # Bandwidth
        "bandwidth": {
            "total_bytes_sent": bytes_sent,
            "total_bytes_received": bytes_received,
            "avg_response_bytes": round(bytes_sent / total, 2) if total else 0,
        },

        # Upstream dependencies
        "upstream_dependencies": upstream_deps,

        # Pod distribution (request counts only — legacy)
        "pod_distribution": [{"pod": p, "requests": c} for p, c in pod_counts.most_common()],

        # Per-pod stats: requests, 4xx/5xx, latency, served authorities
        "pod_stats": pod_stats,

        # Who
        "who": {
            "unique_client_ips": len(ip_counts),
            "top_clients_by_requests": [{"ip": ip, "requests": c} for ip, c in ip_counts.most_common(10)],
            "top_user_agents": [{"user_agent": ua[:120], "count": c} for ua, c in ua_counts.most_common(5)],
            "bot_request_count": bot_count,
            "bot_rate_pct": round(bot_count / total * 100, 2),
            "unique_users": len(user_id_counts),
            "top_users": [{"user_id": u, "requests": c} for u, c in user_id_counts.most_common(10)],
            "unique_tenant_ids": len(tenant_id_counts),
        },

        # Peak usage
        "peak_hours_utc": [{"hour": h, "requests": c} for h, c in hour_counts.most_common(5)],

        # Time-series: requests + latency bucketed every 15 minutes
        "timeseries": _compute_timeseries(logs, bucket_mins=15),
    }


def _compute_tenant_metrics(app_metrics_list: list[dict]) -> dict:
    """
    Aggregate app-level metrics into a single tenant-level view.
    All values are derived from already-computed app metrics — no raw logs needed.
    """
    if not app_metrics_list:
        return {}

    total_requests = sum(m.get("total_requests", 0) for m in app_metrics_list)
    total_4xx = sum(m.get("error_4xx_count", 0) for m in app_metrics_list)
    total_5xx = sum(m.get("error_5xx_count", 0) for m in app_metrics_list)
    total_errors = total_4xx + total_5xx
    total_workflow = sum(m.get("workflow", {}).get("total_requests", 0) for m in app_metrics_list)
    total_workflow_errors = sum(m.get("workflow", {}).get("error_count", 0) for m in app_metrics_list)
    total_bytes_sent = sum(m.get("bandwidth", {}).get("total_bytes_sent", 0) for m in app_metrics_list)
    total_bytes_received = sum(m.get("bandwidth", {}).get("total_bytes_received", 0) for m in app_metrics_list)

    # Most problematic app by error rate
    most_errors_app = max(
        app_metrics_list, key=lambda m: m.get("error_rate_pct", 0), default={}
    )

    # Most requested app
    most_requested_app = max(
        app_metrics_list, key=lambda m: m.get("total_requests", 0), default={}
    )

    # Cross-app upstream failures
    upstream_failures: Counter = Counter()
    for m in app_metrics_list:
        for dep in m.get("upstream_dependencies", []):
            if dep.get("errors", 0) > 0:
                upstream_failures[dep["cluster"]] += dep["errors"]

    # Peak hours across all apps
    peak_hours: Counter = Counter()
    for m in app_metrics_list:
        for ph in m.get("peak_hours_utc", []):
            peak_hours[ph["hour"]] += ph["requests"]

    # Who: aggregate unique IPs and users
    total_unique_ips = sum(m.get("who", {}).get("unique_client_ips", 0) for m in app_metrics_list)
    total_unique_users = sum(m.get("who", {}).get("unique_users", 0) for m in app_metrics_list)
    total_bots = sum(m.get("who", {}).get("bot_request_count", 0) for m in app_metrics_list)

    # Health score: weighted penalty on error rate + upstream failures
    overall_error_rate = round(total_errors / total_requests * 100, 2) if total_requests else 0
    failure_penalty = min(len(upstream_failures) * 2, 20)
    health_score = max(0, round(100 - (overall_error_rate * 0.7) - failure_penalty))

    return {
        "total_requests": total_requests,
        "overall_error_rate_pct": overall_error_rate,
        "total_4xx": total_4xx,
        "total_5xx": total_5xx,
        "total_workflow_requests": total_workflow,
        "workflow_error_rate_pct": round(total_workflow_errors / total_workflow * 100, 2) if total_workflow else 0,
        "bandwidth": {
            "total_bytes_sent": total_bytes_sent,
            "total_bytes_received": total_bytes_received,
        },
        "most_requested_app": most_requested_app.get("_app_label", ""),
        "most_errors_app": most_errors_app.get("_app_label", ""),
        "cross_app_upstream_failures": [
            {"cluster": c, "total_errors": e}
            for c, e in upstream_failures.most_common(10)
        ],
        "peak_hours_utc": [{"hour": h, "requests": c} for h, c in peak_hours.most_common(5)],
        "who": {
            "total_unique_client_ips": total_unique_ips,
            "total_unique_users": total_unique_users,
            "total_bot_requests": total_bots,
        },
        "health_score": health_score,
    }


# ---------------------------------------------------------------------------
# Heuristic analysis (replaces Claude for the scheduled batch runs)
# ---------------------------------------------------------------------------
def _heuristic_app_insights(logs: list[dict], metrics: dict) -> dict:
    """
    Build the per-app insight JSON (same shape the Claude prompt produced) from
    pre-computed metrics + raw logs. Uses threshold-based rules, not an LLM.
    """
    total = int(metrics.get("total_requests") or 0)
    err4 = int(metrics.get("error_4xx_count") or 0)
    err5 = int(metrics.get("error_5xx_count") or 0)
    err_rate = float(metrics.get("error_rate_pct") or 0)
    lat = metrics.get("latency") or {}
    p95 = float(lat.get("p95_ms") or 0)
    p99 = float(lat.get("p99_ms") or 0)
    avg_lat = float(lat.get("avg_ms") or 0)
    top_traffic = metrics.get("top_endpoints_by_traffic") or []
    top_errors  = metrics.get("top_endpoints_by_errors") or []
    status_dist = metrics.get("status_distribution") or {}

    # ── Request classification (by path heuristics) ──────────────────────────
    api_paths, ws_paths, internal_paths = [], [], []
    api_cnt = ws_cnt = internal_cnt = 0
    for log in logs:
        path = str(log.get("path") or "").split("?")[0]
        dur = 0.0
        try:
            dur = float(log.get("duration") or 0)
        except (TypeError, ValueError):
            pass
        upgrade = str(log.get("upgrade") or "").lower()
        if "websocket" in upgrade or dur > 30000:
            ws_cnt += 1
            if path and len(ws_paths) < 5 and path not in ws_paths:
                ws_paths.append(path)
        elif path.startswith(("/internal", "/svc", "/service")):
            internal_cnt += 1
            if path and len(internal_paths) < 5 and path not in internal_paths:
                internal_paths.append(path)
        else:
            api_cnt += 1
            if path and len(api_paths) < 5 and path not in api_paths:
                api_paths.append(path)

    request_classification = {
        "api_calls":              {"count": api_cnt, "sample_paths": api_paths},
        "websocket_connections":  {"count": ws_cnt,
                                   "note": "Long-lived connections; high duration is expected." if ws_cnt else ""},
        "internal_service_calls": {"count": internal_cnt, "services": internal_paths},
        "summary": f"{api_cnt} API calls, {ws_cnt} WebSocket connections, {internal_cnt} internal calls.",
    }

    # ── Latency breakdown ────────────────────────────────────────────────────
    hotspots = []
    for ep in top_traffic[:5]:
        avg = float(ep.get("avg_duration_ms") or 0)
        if avg >= 1000:
            hotspots.append({
                "path": ep.get("path", ""),
                "total_ms": round(avg, 1),
                "proxy_ms": 0.0, "backend_ms": round(avg, 1),
                "bottleneck": "backend",
            })
    if p95 >= 2000:
        lat_summary = f"High P95 latency ({p95:.0f}ms) — backend-dominated."
        backend_dom, ingress_dom = True, False
    elif p95 >= 500:
        lat_summary = f"Moderate P95 latency ({p95:.0f}ms)."
        backend_dom, ingress_dom = False, False
    else:
        lat_summary = f"Latency healthy (P95 {p95:.0f}ms, avg {avg_lat:.0f}ms)."
        backend_dom, ingress_dom = False, False
    latency_breakdown = {
        "summary": lat_summary,
        "ingress_dominated": ingress_dom,
        "backend_dominated": backend_dom,
        "hotspots": hotspots,
    }

    # ── Slowness analysis ────────────────────────────────────────────────────
    slow_issues = []
    for ep in top_traffic[:10]:
        avg = float(ep.get("avg_duration_ms") or 0)
        path = ep.get("path", "")
        if avg > 30000:
            slow_issues.append({"path": path, "category": "websocket_expected",
                                "evidence": f"Very long duration ({avg:.0f}ms) — likely long-lived connection"})
        elif avg > 2000:
            slow_issues.append({"path": path, "category": "backend_slowness",
                                "evidence": f"Avg {avg:.0f}ms exceeds 2s threshold"})
    slowness_analysis = {
        "summary": f"{len(slow_issues)} endpoint(s) exceed latency thresholds." if slow_issues
                   else "No endpoints show systemic slowness.",
        "issues": slow_issues[:5],
    }

    # ── Error analysis ───────────────────────────────────────────────────────
    top_4xx, top_5xx = [], []
    for code, cnt in sorted(status_dist.items(), key=lambda kv: -kv[1]):
        c = str(code)
        if c.startswith("4") and len(top_4xx) < 5:
            paths_for_code = [ep["path"] for ep in top_errors if ep.get("path")][:3]
            try:
                top_4xx.append({"code": int(c), "count": cnt, "sample_paths": paths_for_code})
            except ValueError:
                pass
        elif c.startswith("5") and len(top_5xx) < 5:
            paths_for_code = [ep["path"] for ep in top_errors if ep.get("path")][:3]
            try:
                top_5xx.append({"code": int(c), "count": cnt, "sample_paths": paths_for_code})
            except ValueError:
                pass
    endpoint_failures = [
        {"path": ep.get("path", ""), "error_count": int(ep.get("error_count") or 0),
         "dominant_code": int((top_5xx[0]["code"] if top_5xx else (top_4xx[0]["code"] if top_4xx else 0)))}
        for ep in top_errors[:5]
    ]
    if err5 and err5 / max(total, 1) > 0.05:
        err_patterns = f"Elevated 5xx rate: {err5}/{total} requests ({err5/max(total,1)*100:.1f}%)."
        err_summary  = "Server-side failures dominate — investigate backend health."
    elif err4 and err4 / max(total, 1) > 0.10:
        err_patterns = f"High 4xx rate: {err4}/{total} requests — client/config issues."
        err_summary  = "Client errors dominate — check auth, payload validation, routing."
    elif err4 + err5 == 0:
        err_patterns = "No HTTP errors observed."
        err_summary  = "Error profile healthy."
    else:
        err_patterns = f"{err4} 4xx + {err5} 5xx across {total} requests."
        err_summary  = f"Overall error rate {err_rate}% within acceptable bounds."
    error_analysis = {
        "summary": err_summary,
        "client_errors_4xx": {"count": err4, "top_codes": top_4xx},
        "server_errors_5xx": {"count": err5, "top_codes": top_5xx},
        "patterns": err_patterns,
        "endpoint_failures": endpoint_failures,
    }

    # ── Endpoint analysis ────────────────────────────────────────────────────
    slowest = [
        {"path": ep.get("path", ""),
         "avg_ms": float(ep.get("avg_duration_ms") or 0),
         "p95_ms": float(ep.get("avg_duration_ms") or 0),  # per-endpoint P95 not pre-computed
         "requests": int(ep.get("count") or 0)}
        for ep in sorted(top_traffic, key=lambda e: -float(e.get("avg_duration_ms") or 0))[:5]
    ]
    most_error_prone = [
        {"path": ep.get("path", ""),
         "error_rate_pct": float(ep.get("error_rate_pct") or 0),
         "errors": int(ep.get("error_count") or 0),
         "total": 0}
        for ep in top_errors[:5]
    ]
    endpoint_analysis = {
        "summary": f"{len(slowest)} slowest and {len(most_error_prone)} most error-prone endpoints identified.",
        "slowest": slowest,
        "most_error_prone": most_error_prone,
    }

    # ── Root cause classification ────────────────────────────────────────────
    if total < 5:
        category, primary = "low_traffic", f"Low traffic: only {total} request(s) in this window."
    elif err5 and err5 / max(total, 1) > 0.05:
        category, primary = "external_dependency", f"Server-side failures at {err5/max(total,1)*100:.1f}% — upstream/backend issue."
    elif p95 >= 2000 and ws_cnt < api_cnt:
        category, primary = "backend_slowness", f"Backend-dominated latency — P95 {p95:.0f}ms."
    elif ws_cnt > api_cnt:
        category, primary = "websocket_expected", f"Traffic is mostly WebSocket ({ws_cnt} vs {api_cnt} API) — high duration is normal."
    elif err4 and err4 / max(total, 1) > 0.10:
        category, primary = "configuration", f"High 4xx rate ({err4/max(total,1)*100:.1f}%) — likely auth/routing/config."
    else:
        category, primary = "healthy", "No critical issues detected."
    evidence = [f"total_requests={total}", f"error_rate={err_rate}%", f"p95={p95:.0f}ms", f"p99={p99:.0f}ms"]
    affected = [ep.get("path", "") for ep in top_errors[:3] if ep.get("path")]
    root_cause = {
        "primary_issue": primary, "category": category,
        "evidence": evidence, "affected_services": affected,
    }

    # ── Top issues + recommendations ─────────────────────────────────────────
    top_issues, recs = [], []
    if err5:
        top_issues.append(f"{err5} server error(s) (5xx) observed")
        recs.append("Inspect backend error logs for the failing endpoints and check upstream dependencies.")
    if err4 and err4 / max(total, 1) > 0.10:
        top_issues.append(f"High 4xx rate ({err4/max(total,1)*100:.1f}%)")
        recs.append("Audit auth tokens, payload validation and URL routing for 4xx-heavy endpoints.")
    if p95 >= 2000:
        top_issues.append(f"P95 latency {p95:.0f}ms exceeds 2s")
        recs.append("Profile the slow endpoints — add indexes, cache hot queries, or parallelise I/O.")
    if metrics.get("workflow", {}).get("error_count"):
        wfc = int(metrics["workflow"]["error_count"])
        top_issues.append(f"{wfc} failed workflow execution(s) in window")
        recs.append("Review workflow failure stack traces and recent deploys touching those workflows.")
    if total < 5:
        top_issues.append("Very low traffic — metrics may not be representative")
    if not top_issues:
        top_issues.append("All key indicators within healthy thresholds")

    upstream_services = [u.get("service", "") for u in (metrics.get("upstream_dependencies") or [])[:5]]

    return {
        "request_classification": request_classification,
        "latency_breakdown":      latency_breakdown,
        "slowness_analysis":      slowness_analysis,
        "error_analysis":         error_analysis,
        "endpoint_analysis":      endpoint_analysis,
        "correlation_analysis":   {"summary": "Derived from status + latency correlation.", "findings": evidence},
        "root_cause":             root_cause,
        "top_issues":             top_issues[:6],
        "recommendations":        recs[:6],
        "service_dependencies":   upstream_services,
        "security_observations":  "No authentication anomalies detected in this window." if err4 < 10
                                   else f"{err4} 4xx responses — review for credential / permission failures.",
    }


def _heuristic_platform_insights(platform_logs: list[dict], wf_total: int, wf_failed: int) -> dict:
    """Pattern-match platform-level Java/workhorse logs. No LLM."""
    if not platform_logs and wf_total == 0:
        return {"note": "No platform logs or workflow activity in window."}

    # Count error patterns by root-cause bucket
    pattern_counts: Counter = Counter()
    root_causes_seen: set[str] = set()
    for log in platform_logs:
        msg = str(log.get("message") or "")
        st  = str(log.get("stack_trace") or "")
        rc, _ = _classify_root_cause(msg, st)
        pattern_counts[rc] += 1
        root_causes_seen.add(rc)

    error_patterns = []
    for rc, cnt in pattern_counts.most_common(6):
        severity = "critical" if cnt >= 10 else ("warning" if cnt >= 3 else "info")
        error_patterns.append({
            "type": rc.split(" — ")[0][:60],
            "count": cnt,
            "severity": severity,
            "description": rc,
        })

    key_issues = []
    if wf_failed:
        key_issues.append(f"{wf_failed} failed workflow execution(s) out of {wf_total}")
    for p in error_patterns[:3]:
        key_issues.append(f"{p['type']} — {p['count']} occurrence(s)")
    if not key_issues:
        key_issues.append("No critical errors identified in platform logs.")

    recs = []
    for rc in list(root_causes_seen)[:4]:
        _, fix = _classify_root_cause(rc, "")
        if fix:
            recs.append(fix)
    if not recs:
        recs.append("Continue monitoring — no actionable patterns found.")

    summary = (
        f"{len(platform_logs)} platform log entries analysed; "
        f"{wf_failed}/{wf_total} workflow(s) failed."
        if platform_logs else
        f"{wf_failed}/{wf_total} workflow(s) failed; no platform error logs captured."
    )

    return {
        "summary":         summary,
        "key_issues":      key_issues[:5],
        "error_patterns":  error_patterns,
        "root_causes":     list(root_causes_seen)[:5],
        "recommendations": recs[:5],
    }


def _heuristic_tenant_summary(app_insights: list[dict], app_metrics: list[dict]) -> dict:
    """Aggregate per-app insights into a tenant-level rollup. No LLM."""
    if not app_insights:
        return {
            "health_score": 100, "health_score_reason": "No apps with data in this window.",
            "cross_app_patterns": "", "critical_issues": [], "traffic_trends": "",
            "top_recommendations": [], "risk_level": "Low",
            "risk_reason": "No activity to assess.",
        }

    # Score each app based on its insight category + error rate
    app_scores = []
    critical_issues: list[str] = []
    category_counts: Counter = Counter()
    all_recs: list[str] = []
    total_traffic = 0
    total_errors = 0

    for item, mets in zip(app_insights, app_metrics):
        ins = item.get("insights") or {}
        rc = (ins.get("root_cause") or {})
        category = rc.get("category", "healthy")
        category_counts[category] += 1

        req = int(mets.get("total_requests") or 0)
        errs = int(mets.get("error_4xx_count") or 0) + int(mets.get("error_5xx_count") or 0)
        total_traffic += req
        total_errors += errs

        if category == "external_dependency":
            score = 40
        elif category == "backend_slowness":
            score = 55
        elif category == "configuration":
            score = 65
        elif category == "low_traffic":
            score = 85
        else:
            score = 95
        # Penalise by error rate
        if req:
            score -= min(30, int(errs / req * 100))
        app_scores.append(max(0, score))

        for ti in (ins.get("top_issues") or [])[:2]:
            label = item.get("app_name", "")
            critical_issues.append(f"[{label}] {ti}")
        all_recs.extend(ins.get("recommendations") or [])

    health_score = int(sum(app_scores) / len(app_scores))
    overall_err_rate = (total_errors / total_traffic * 100) if total_traffic else 0

    # Risk level
    if health_score < 50 or category_counts.get("external_dependency", 0) >= 2:
        risk = "High"
        risk_reason = f"{category_counts.get('external_dependency', 0)} app(s) with external-dependency failures; health {health_score}."
    elif health_score < 75:
        risk = "Medium"
        risk_reason = f"Overall health {health_score}; some apps showing degradation."
    else:
        risk = "Low"
        risk_reason = f"Overall health {health_score}; no widespread issues."

    # Cross-app patterns
    patterns = []
    if category_counts.get("external_dependency", 0) >= 2:
        patterns.append(f"{category_counts['external_dependency']} apps share upstream/backend failures.")
    if category_counts.get("backend_slowness", 0) >= 2:
        patterns.append(f"{category_counts['backend_slowness']} apps show elevated backend latency.")
    if category_counts.get("configuration", 0) >= 2:
        patterns.append(f"{category_counts['configuration']} apps show high 4xx — likely config/auth drift.")
    cross_app_patterns = " ".join(patterns) if patterns else "No shared failure patterns across apps."

    # Dedupe top recommendations preserving order
    seen_recs: set[str] = set()
    top_recs: list[str] = []
    for r in all_recs:
        if r and r not in seen_recs:
            seen_recs.add(r)
            top_recs.append(r)
        if len(top_recs) >= 5:
            break

    traffic_trends = (
        f"Total traffic {total_traffic} requests; overall error rate {overall_err_rate:.1f}%."
        if total_traffic else "No traffic observed in this window."
    )

    reason_bits = []
    if category_counts.get("external_dependency"):
        reason_bits.append(f"{category_counts['external_dependency']} app(s) with 5xx failures")
    if category_counts.get("backend_slowness"):
        reason_bits.append(f"{category_counts['backend_slowness']} slow app(s)")
    if not reason_bits:
        reason_bits.append(f"Error rate {overall_err_rate:.1f}%")
    health_score_reason = f"Health {health_score}: " + ", ".join(reason_bits) + "."

    return {
        "health_score":        health_score,
        "health_score_reason": health_score_reason,
        "cross_app_patterns":  cross_app_patterns,
        "critical_issues":     critical_issues[:6],
        "traffic_trends":      traffic_trends,
        "top_recommendations": top_recs,
        "risk_level":          risk,
        "risk_reason":         risk_reason,
    }


# ---------------------------------------------------------------------------
# Core analysis function
# ---------------------------------------------------------------------------

def analyze_tenant_logs(tenant_name: str, timeframe: dict) -> dict:
    """
    Main entry point. Orchestrates the full pipeline:
      1. Fetch application list for the tenant from Jiffy
      2. Download Istio logs from OpenSearch per application
      3. Analyse each application's logs with heuristic rules
      4. Generate a tenant-level summary with heuristic rules
      5. Persist all insights to MongoDB (collection: log_insights)

    Args:
        tenant_name: Tenant identifier (matches Istio namespace in OpenSearch).
        timeframe:   {"start": "<ISO-8601>", "end": "<ISO-8601>"}

    Returns:
        {
            "tenant_name": str,
            "timeframe": dict,
            "apps_analyzed": list[str],
            "tenant_insight_id": str | None,
            "app_insight_ids": list[str],
        }
    """
    config = _load_config()
    start_time: str = timeframe["start"]
    end_time: str = timeframe["end"]
    analyzed_at = datetime.now(timezone.utc).isoformat()

    logger.info("=== Tenant log analysis started ===")
    logger.info(f"Tenant:    {tenant_name}")
    logger.info(f"Timeframe: {start_time} → {end_time}")

    # 1. Fetch application list
    logger.info("Step 1/4 – Fetching application list from Jiffy...")
    jiffy_cfg = config["jiffy"]
    token = _get_jiffy_token(jiffy_cfg)
    applications = _fetch_tenant_applications(jiffy_cfg, token, tenant_name)

    # Flatten apps → instances. Use inst url (without scheme) as the authority filter value.
    app_list: list[dict] = []
    for app in applications:
        app_name = str(app.get("displayName") or app.get("name") or "").strip()
        app_id   = str(app.get("id") or app.get("appId") or "").strip()
        for inst in app.get("insts") or []:
            url = str(inst.get("url") or "").strip()
            authority = url.removeprefix("https://").removeprefix("http://").rstrip("/")
            inst_name = str(inst.get("name") or app_name).strip()
            environment = str(inst.get("environment") or "").strip()
            inst_id = str(inst.get("id") or "").strip()
            if authority:
                app_list.append({
                    "authority": authority,
                    "app_name": app_name,
                    "app_id":   app_id,
                    "inst_id":  inst_id,
                    "inst_name": inst_name,
                    "environment": environment,
                })

    logger.info(f"  Found {len(app_list)} instance(s) across all applications:")
    for a in app_list:
        logger.info(f"    {a['app_name']} / {a['environment']}  (authority: {a['authority']})")

    # Shared clients. Claude is NOT used in the scheduled batch run any more —
    # heuristic analysis covers the per-app / per-tenant / failed-workflow
    # insight shapes. Claude is reserved for the on-demand "Investigate
    # Further" endpoint in backend/routers/temporal.py.
    os_client = _build_opensearch_client(config["opensearch"])
    db = MongoClient(config["mongodb"]["uri"], tlsAllowInvalidCertificates=True)[config["mongodb"]["database"]]

    # Ensure indexes exist for fast lookups
    db["app_insights"].create_index([("tenant_name", 1), ("app_name", 1)])
    db["app_insights"].create_index([("tenant_name", 1), ("environment", 1)])
    db["app_insights"].create_index([("analyzed_at", -1)])
    db["tenant_insights"].create_index([("tenant_name", 1)])
    db["tenant_insights"].create_index([("analyzed_at", -1)])
    db["workflow_executions"].create_index([("tenant_name", 1), ("app_name", 1), ("environment", 1)], unique=True)

    # 2 & 3. Per-application: fetch logs → analyse → store
    logger.info("Step 2/4 – Fetching Istio logs and analysing per application...")
    app_insights: list[dict] = []
    app_insight_ids: list[str] = []
    app_metrics_list: list[dict] = []   # collected for tenant aggregation

    for app in app_list:
        authority: str = app["authority"]
        app_name: str = app["app_name"]
        inst_name: str = app["inst_name"]
        environment: str = app["environment"]
        label = f"{app_name}/{environment}"

        logger.info(
            f"  [{label}] Fetching ingress logs from OpenSearch "
            f"(appId={app['inst_id'] or 'none'}, authority hint={authority})..."
        )
        fetched = _fetch_istio_logs(
            os_client, config["opensearch"], app["inst_id"], start_time, end_time
        )
        logs = fetched["logs"]
        true_total    = fetched["total_count"]
        status_counts = fetched["status_counts"]
        logger.info(
            f"  [{label}] {true_total} ingress request(s) total, sampled {len(logs)} for analysis"
        )

        # Always fetch and save workflow executions, even if Istio logs are absent
        logger.info(f"  [{label}] Fetching workflow executions from OpenSearch (inst_id={app['inst_id'] or 'none'})...")
        exec_data = _fetch_workflow_executions(
            os_client, app["inst_id"], start_time, end_time,
        )
        exec_results = exec_data.get("results") or []
        logger.info(f"  [{label}] {len(exec_results)} failed execution(s) fetched")

        # Merge into existing doc by workflow_id so history accumulates across
        # the 30-min scheduled runs instead of getting wiped each cycle. New
        # results for the same workflow_id replace the old entry.
        existing_doc = db["workflow_executions"].find_one(
            {"tenant_name": tenant_name, "app_name": app_name, "environment": environment}
        )
        existing_execs = (existing_doc or {}).get("executions") or []
        new_ids = {e.get("workflow_id") for e in exec_results if e.get("workflow_id")}
        merged_execs = [e for e in existing_execs if e.get("workflow_id") not in new_ids] + exec_results
        merged_failed = sum(1 for e in merged_execs if str(e.get("status", "")).lower() == "failed")

        db["workflow_executions"].replace_one(
            {"tenant_name": tenant_name, "app_name": app_name, "environment": environment},
            {
                "tenant_name": tenant_name,
                "app_name":    app_name,
                "app_id":      app["app_id"],
                "inst_id":     app["inst_id"],
                "environment": environment,
                "analyzed_at": analyzed_at,
                "executions":  merged_execs,
                "summary": {
                    "total":     len(merged_execs),
                    "running":   0,
                    "completed": 0,
                    "failed":    merged_failed,
                },
            },
            upsert=True,
        )

        if not logs:
            logger.warning(f"  [{label}] No Istio logs found – trying platform app logs")
            # Fetch platform-level logs (workhorse, Java errors) by appId
            platform_logs = _fetch_platform_app_logs(
                os_client, app["inst_id"], start_time, end_time
            )

            wf_exec = exec_data
            wf_failed_count = wf_exec.get("failed", 0)
            wf_total = wf_exec.get("totalSize") or len(exec_results)

            if wf_total > 0 or wf_failed_count > 0 or platform_logs:
                # Pre-compute the same correlationId-cardinality total used on
                # the Istio-logs-present path so this branch is also fast to
                # read from Mongo.
                no_log_workflow_total = _fetch_workflow_total(
                    os_client, app["inst_id"], start_time, end_time,
                )
                no_log_metrics = {
                    "total_requests": len(platform_logs), "total_5xx": 0, "total_4xx": 0,
                    "error_4xx_count": 0,
                    "error_5xx_count": sum(1 for l in platform_logs if l.get("level") == "ERROR"),
                    "error_rate_pct": 0, "overall_error_rate_pct": 0,
                    "health_score": max(0, 100 - (wf_failed_count * 5)),
                    "workflow_total": no_log_workflow_total,
                    "total_workflow_requests": wf_total,
                    "workflow_error_rate_pct": round(wf_failed_count / max(wf_total, 1) * 100, 1),
                    "workflow": {"total_requests": wf_total, "error_count": wf_failed_count},
                    "bandwidth": {"total_bytes_sent": 0, "total_bytes_received": 0},
                    "upstream_dependencies": [], "peak_hours_utc": [],
                    "who": {"unique_client_ips": 0, "unique_users": 0, "bot_request_count": 0},
                    "_app_label": label,
                }

                failed_workflows = _fetch_failed_workflows(
                    os_client, app["inst_id"], start_time, end_time
                )
                logger.info(f"  [{label}] {len(failed_workflows)} failed workflow(s) found in platform logs")

                # Heuristic analysis on platform logs
                logger.info(f"  [{label}] Analysing {len(platform_logs)} platform log(s) heuristically...")
                platform_insights = _heuristic_platform_insights(
                    platform_logs, wf_total, wf_failed_count
                )

                no_log_doc = {
                    "tenant_name": tenant_name,
                    "app_name": app_name,
                    "app_id": app["app_id"],
                    "inst_id": app["inst_id"],
                    "inst_name": inst_name,
                    "environment": environment,
                    "authority": authority,
                    "timeframe": {"start": start_time, "end": end_time},
                    "metrics": no_log_metrics,
                    "insights": platform_insights,
                    "failed_workflows": failed_workflows,
                    "platform_logs_count": len(platform_logs),
                    "analyzed_at": analyzed_at,
                }
                result = db["app_insights"].insert_one(no_log_doc)
                app_insight_ids.append(str(result.inserted_id))
                app_insights.append({"app_name": label, "insights": platform_insights})
                app_metrics_list.append(no_log_metrics)
                logger.info(f"  [{label}] Platform-log insight stored → {result.inserted_id}")
            continue

        metrics = _compute_metrics(logs)
        metrics["_app_label"] = label   # used by tenant aggregation

        # Pre-compute total workflow count via correlationId cardinality so the
        # Tenant & Apps page reads from Mongo instead of querying OpenSearch
        # live on every load.
        metrics["workflow_total"] = _fetch_workflow_total(
            os_client, app["inst_id"], start_time, end_time,
        )

        # Override sample-derived counts with the OpenSearch-aggregated truth.
        # _compute_metrics computes total_requests / 4xx / 5xx from the (capped)
        # sample; with the per-app filter those samples can hit the size cap and
        # under-count. status_counts comes from a terms aggregation that scans
        # the whole window, so it is authoritative.
        true_4xx = sum(c for code, c in status_counts.items() if code.startswith("4"))
        true_5xx = sum(c for code, c in status_counts.items() if code.startswith("5"))
        metrics["total_requests"]  = true_total
        metrics["error_4xx_count"] = true_4xx
        metrics["error_5xx_count"] = true_5xx
        metrics["error_rate_pct"]  = round(
            (true_4xx + true_5xx) / true_total * 100, 2
        ) if true_total else 0
        metrics["response_code_distribution"] = dict(
            sorted(status_counts.items(), key=lambda kv: kv[1], reverse=True)
        )

        wf = metrics.get("workflow", {})
        logger.info(
            f"  [{label}] requests={metrics['total_requests']}  "
            f"workflow={wf.get('total_requests', 0)}  "
            f"errors={metrics['error_4xx_count'] + metrics['error_5xx_count']}  "
            f"error_rate={metrics['error_rate_pct']}%"
        )

        logger.info(f"  [{label}] Computing heuristic app insights...")
        claude_insights: dict = _heuristic_app_insights(logs, metrics)

        failed_workflows = _fetch_failed_workflows(
            os_client, app["inst_id"], start_time, end_time
        )
        logger.info(f"  [{label}] {len(failed_workflows)} failed workflow(s) found in platform logs")

        app_doc = {
            "tenant_name": tenant_name,
            "app_name": app_name,
            "app_id": app["app_id"],
            "inst_id": app["inst_id"],
            "inst_name": inst_name,
            "environment": environment,
            "authority": authority,
            "timeframe": {"start": start_time, "end": end_time},
            "metrics": metrics,
            "insights": claude_insights,
            "failed_workflows": failed_workflows,
            "analyzed_at": analyzed_at,
        }
        result = db["app_insights"].insert_one(app_doc)
        app_insight_ids.append(str(result.inserted_id))
        app_insights.append({"app_name": label, "insights": claude_insights})
        app_metrics_list.append(metrics)
        logger.info(f"  [{label}] Insight stored → {result.inserted_id}")

    # 3b. Sweep: discover additional failed workflows via master failure pattern
    logger.info("Step 2b/4 – Sweep: discovering ALL failed workflows via master pattern...")
    inst_id_to_label = {a["inst_id"]: f"{a['app_name']}/{a['environment']}" for a in app_list if a["inst_id"]}
    sweep_results = _sweep_all_failed_workflows(
        os_client, start_time, end_time, inst_id_to_label
    )

    if sweep_results:
        # Merge sweep discoveries into existing workflow_executions
        for inst_id, sweep_wfs in sweep_results.items():
            label = inst_id_to_label.get(inst_id, inst_id)
            # Find the matching app entry
            matching_app = next((a for a in app_list if a["inst_id"] == inst_id), None)
            if not matching_app:
                continue
            app_name = matching_app["app_name"]
            environment = matching_app["environment"]

            # Load existing executions from DB
            existing_doc = db["workflow_executions"].find_one(
                {"tenant_name": tenant_name, "app_name": app_name, "environment": environment}
            )
            existing_wf_ids = set()
            existing_execs = []
            if existing_doc:
                existing_execs = existing_doc.get("executions") or []
                existing_wf_ids = {e.get("workflow_id") for e in existing_execs}

            # Add only genuinely new workflows
            new_wfs = [w for w in sweep_wfs if w["workflow_id"] not in existing_wf_ids]
            if new_wfs:
                merged = existing_execs + new_wfs
                total_failed = sum(1 for e in merged if e.get("status") == "FAILED")
                db["workflow_executions"].replace_one(
                    {"tenant_name": tenant_name, "app_name": app_name, "environment": environment},
                    {
                        "tenant_name": tenant_name,
                        "app_name":    app_name,
                        "app_id":      matching_app["app_id"],
                        "inst_id":     inst_id,
                        "environment": environment,
                        "analyzed_at": analyzed_at,
                        "executions":  merged,
                        "summary": {
                            "total":     len(merged),
                            "running":   0,
                            "completed": 0,
                            "failed":    total_failed,
                        },
                    },
                    upsert=True,
                )
                logger.info(f"  Sweep merged {len(new_wfs)} new workflow(s) into [{label}] (total now: {len(merged)})")

                # Also update app_insights failed_workflows list
                app_doc = db["app_insights"].find_one(
                    {"tenant_name": tenant_name, "app_name": app_name, "environment": environment},
                    sort=[("analyzed_at", -1)],
                )
                if app_doc:
                    existing_fw = app_doc.get("failed_workflows") or []
                    existing_fw_ids = {fw.get("workflowId") for fw in existing_fw}
                    new_fw_entries = [
                        {
                            "workflowId":   w["workflow_id"],
                            "status":       "FAILED",
                            "processName":  w.get("process_name", ""),
                            "workflowName": w.get("workflow_name", ""),
                            "reason":       w.get("error_message", "")[:300],
                            "timestamp":    w.get("start_time", ""),
                            "appId":        inst_id,
                        }
                        for w in new_wfs if w["workflow_id"] not in existing_fw_ids
                    ]
                    if new_fw_entries:
                        db["app_insights"].update_one(
                            {"_id": app_doc["_id"]},
                            {"$push": {"failed_workflows": {"$each": new_fw_entries}}},
                        )
    else:
        logger.info("  Sweep: no additional workflows discovered")

    # 4. Tenant-level summary
    logger.info("Step 3/4 – Generating tenant-level summary...")
    tenant_insight_id: Optional[str] = None

    if app_insights:
        tenant_insights: dict = _heuristic_tenant_summary(app_insights, app_metrics_list)
        tenant_metrics = _compute_tenant_metrics(app_metrics_list)
        tenant_doc = {
            "tenant_name": tenant_name,
            "timeframe": {"start": start_time, "end": end_time},
            "app_count": len(app_insights),
            "app_names": [item["app_name"] for item in app_insights],
            "app_insight_ids": app_insight_ids,
            "metrics": tenant_metrics,
            "insights": tenant_insights,
            "analyzed_at": analyzed_at,
        }
        tenant_result = db["tenant_insights"].insert_one(tenant_doc)
        tenant_insight_id = str(tenant_result.inserted_id)
        logger.info(f"  Tenant insight stored → {tenant_insight_id}")
    else:
        logger.warning("  No application logs found – tenant summary skipped")

    logger.info("Step 4/4 – Done.")

    return {
        "tenant_name": tenant_name,
        "timeframe": timeframe,
        "apps_analyzed": [item["app_name"] for item in app_insights],
        "tenant_insight_id": tenant_insight_id,
        "app_insight_ids": app_insight_ids,
    }


# ---------------------------------------------------------------------------
# AWS Lambda handler
# ---------------------------------------------------------------------------

def lambda_handler(event: dict, context) -> dict:
    """
    AWS Lambda entry point.

    Expected event shape:
        {
            "tenant_name": "acme-corp",
            "timeframe": {
                "start": "2026-03-25T00:00:00Z",
                "end":   "2026-03-26T00:00:00Z"
            }
        }
    """
    return analyze_tenant_logs(event["tenant_name"], event["timeframe"])


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    if len(sys.argv) != 4:
        print("Usage: python log_analysis.py <tenant_name|all> <start_iso> <end_iso>")
        print("Single: python log_analysis.py rehlko 2026-03-26T12:00:00Z 2026-03-26T23:59:59Z")
        print("All:    python log_analysis.py all    2026-03-26T12:00:00Z 2026-03-26T23:59:59Z")
        sys.exit(1)

    import json

    tenant_arg = sys.argv[1]
    timeframe  = {"start": sys.argv[2], "end": sys.argv[3]}

    if tenant_arg.lower() == "all":
        cfg   = _load_config()
        token = _get_jiffy_token(cfg["jiffy"])
        names = _fetch_all_tenant_names(cfg["jiffy"], token)
        logger.info(f"Found {len(names)} tenant(s): {', '.join(names)}")

        results = []
        for i, name in enumerate(names, 1):
            logger.info(f"\n[{i}/{len(names)}] Analyzing tenant: {name}")
            try:
                result = analyze_tenant_logs(name, timeframe)
                results.append(result)
            except Exception as exc:
                logger.error(f"  Failed for {name}: {exc}")
                results.append({"tenant_name": name, "error": str(exc)})

        print(json.dumps(results, indent=2))
    else:
        output = analyze_tenant_logs(tenant_arg, timeframe)
        print(json.dumps(output, indent=2))
