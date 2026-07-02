import asyncio
import json
import base64
import csv
import io
import os
import re
import yaml
from datetime import datetime, timezone, timedelta
from fastapi import APIRouter, Query, HTTPException, Body
from fastapi.responses import StreamingResponse
from google.protobuf.json_format import MessageToDict
from opensearchpy import OpenSearch
from temporalio.client import Client as TemporalClient
from temporalio.service import RPCError

from config import get_config
from database import get_db
import anthropic

router = APIRouter(prefix="/api/temporal", tags=["Temporal"])


def _temporal_target() -> str:
    """
    Resolution order:
      1. $TEMPORAL_FRONTEND_ADDRESS (env override, e.g. in the Pod)
      2. config.yml:  temporal.address
      3. localhost:7233 (sane local dev default — matches `kubectl port-forward`)
    """
    env = os.environ.get("TEMPORAL_FRONTEND_ADDRESS")
    if env:
        return env
    cfg = (get_config().get("temporal") or {}).get("address")
    if cfg:
        return cfg
    return "localhost:7233"


def _temporal_namespace() -> str:
    env = os.environ.get("TEMPORAL_NAMESPACE")
    if env:
        return env
    cfg = (get_config().get("temporal") or {}).get("namespace")
    return cfg or "JIFFY_LIVE"


def _fetch_workflow_events(workflow_id: str, namespace: str | None = None) -> list[dict]:
    """
    Fetch a workflow's full event history via the Temporal gRPC SDK and return
    it as a list of dicts in the same shape the CLI's `workflow show -o json`
    used to produce (camelCase keys, proto enums as strings).

    `namespace` overrides the default. Used for app-lifecycle workflows that
    live in `default` (not JIFFY_LIVE).

    We create a fresh Client per request rather than caching one at module
    scope: the SDK's Client holds connections bound to the asyncio loop that
    created it, and `asyncio.run()` creates+tears down a new loop each call,
    so a cached client would be stale on the second invocation.
    """
    ns = namespace or _temporal_namespace()
    async def _run() -> list[dict]:
        client = await TemporalClient.connect(_temporal_target(), namespace=ns)
        handle = client.get_workflow_handle(workflow_id)
        events: list[dict] = []
        async for evt in handle.fetch_history_events():
            events.append(MessageToDict(evt, preserving_proto_field_name=False))
        return events

    try:
        return asyncio.run(_run())
    except RPCError as e:
        msg = str(e)
        if "not found" in msg.lower() or "NotFound" in msg:
            raise HTTPException(
                status_code=404,
                detail=f"Workflow history not available in Temporal — it may have been archived or exceeded the retention period. (workflow_id={workflow_id})",
            )
        raise HTTPException(status_code=502, detail=f"Temporal gRPC error: {msg}")
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="Temporal request timed out")
    except RuntimeError as e:
        # tonic/DNS/connect failures bubble as RuntimeError from the Rust bridge.
        raise HTTPException(status_code=502, detail=f"Temporal connect failed: {e}")


# ── App publish / app start failures (Temporal `default` namespace) ─────────
# Jiffy's app lifecycle workflows live in the `default` namespace (not
# JIFFY_LIVE which holds the per-tenant workflows). Two kinds we surface on
# the Dashboard:
#   - am-publish-*    → PublishAppWorkflow         ("App publish failed")
#   - am-start-app-*  → DeployAndWaitToCompleteWorkflow ("App start failed")
APP_LIFECYCLE_NAMESPACE = "default"
APP_LIFECYCLE_KINDS = [
    {"prefix": "am-publish",   "kind": "publish",   "label": "App publish"},
    {"prefix": "am-start-app", "kind": "start",     "label": "App start"},
]

# Keyed by (start_iso, end_iso) so the "Today" / "Last 1 hour" / "Last 7 days"
# presets each cache independently. Without this, switching the filter would
# return a stale payload until the previous TTL expired.
_APP_LIFECYCLE_CACHE: dict = {}   # { (start_iso, end_iso): {"ts": float, "data": dict} }
_APP_LIFECYCLE_TTL = 60.0  # seconds — cheaper than re-querying Temporal on every dashboard load


async def _enrich_lifecycle_failure(client, wf_id: str, run_id: str) -> dict:
    """Read the WorkflowExecutionStarted event for this workflow and extract
    user-facing identifiers from the input payload: App.displayName, App.name,
    EnvPartition.name (environment), and tenant_name (derived from the
    EnvPartition.nameSpace `{env}-{tenant}` or appFqdnSuffix dot pattern).
    Returns {} on any failure so the row still renders with its core fields."""
    try:
        handle = client.get_workflow_handle(wf_id, run_id=run_id)
        async for evt in handle.fetch_history_events():
            evt_dict = MessageToDict(evt, preserving_proto_field_name=False)
            attrs = (evt_dict.get("workflowExecutionStartedEventAttributes")
                     or evt_dict.get("workflow_execution_started_event_attributes")
                     or {})
            payloads = (attrs.get("input") or {}).get("payloads") or []
            for entry in (_decode_payloads(payloads) if payloads else []):
                data = entry.get("data")
                if not isinstance(data, dict):
                    continue
                app      = data.get("App") or {}
                env_part = data.get("EnvPartition") or {}
                env_blk  = data.get("Env") or {}
                # AppInst.id is the unique app-instance UUID. This is the
                # join key used by app-manager and downstream services
                # (model-repo, deployment-manager, ASM, jiffydrive) when
                # they log — see docs/app-publish-start-troubleshooting.md.
                # DeployInst.id is its equivalent for the start flow.
                app_inst    = data.get("AppInst")    or data.get("DeployInst") or {}

                # Tenant name: try the namespace first ('{env}-{tenant}'),
                # then the FQDN ('<env>.<tenant>.<rest>'), then fall back to
                # whatever readable label we have.
                tenant_name = None
                ns = (env_part.get("nameSpace") or "").strip()
                if ns and "-" in ns:
                    tenant_name = ns.split("-", 1)[1] or None
                if not tenant_name:
                    fqdn = (env_part.get("appFqdnSuffix") or "").strip()
                    parts = [p for p in fqdn.split(".") if p]
                    if len(parts) >= 2:
                        tenant_name = parts[1]

                return {
                    "app_display_name": app.get("displayName") or app.get("name"),
                    "app_name":         app.get("name"),
                    "app_id":           app.get("id"),
                    "app_inst_id":      app_inst.get("id"),
                    "app_version":      app_inst.get("version") or app_inst.get("Version"),
                    "tenant_id":        app.get("tenantId") or env_part.get("tenantId"),
                    "tenant_name":      tenant_name,
                    "environment":      env_part.get("name") or env_blk.get("name"),
                    "namespace":        env_part.get("nameSpace"),
                }
            return {}   # Started event seen but no usable payload — stop here
    except Exception:
        return {}
    return {}


def fetch_app_lifecycle_failures(
    start_iso: str | None = None,
    end_iso:   str | None = None,
    limit_per_kind: int = 25,
) -> dict:
    """Recent FAILED workflows from Temporal's `default` namespace, grouped by
    kind (publish / start). Each row is enriched with the app + tenant + env
    parsed from its WorkflowExecutionStarted input payload.

    Time window: `[start_iso, end_iso]` on `CloseTime`. Both are UTC ISO
    strings — the Dashboard converts its "Today (12 AM IST)" / "Last 1 hour" /
    "Last 7 days" presets into UTC before calling. If both are omitted, the
    default is the current IST day window (12 AM IST → now), which matches the
    rest of the Dashboard's cards.

    Cached for `_APP_LIFECYCLE_TTL` per (start, end) so each filter preset
    keeps its own short-lived cache."""
    # Default to the current IST day window when caller passes nothing.
    if start_iso is None and end_iso is None:
        from timewindow import ist_day_window
        _start_dt, _end_dt = ist_day_window()
        start_iso = _start_dt.strftime("%Y-%m-%dT%H:%M:%SZ")
        end_iso   = _end_dt.strftime("%Y-%m-%dT%H:%M:%SZ")

    import time as _time
    now = _time.time()
    cache_key = (start_iso, end_iso)
    cached_entry = _APP_LIFECYCLE_CACHE.get(cache_key)
    if cached_entry and (now - cached_entry["ts"]) < _APP_LIFECYCLE_TTL:
        return cached_entry["data"]

    async def _run() -> list[dict]:
        client = await TemporalClient.connect(
            _temporal_target(), namespace=APP_LIFECYCLE_NAMESPACE,
        )
        # Build the time clause. Temporal Visibility supports BETWEEN on
        # CloseTime; we only add `start` / `end` clauses that are present.
        time_clauses = []
        if start_iso:
            time_clauses.append(f"CloseTime >= '{start_iso}'")
        if end_iso:
            time_clauses.append(f"CloseTime <= '{end_iso}'")
        time_sql = (" AND " + " AND ".join(time_clauses)) if time_clauses else ""

        out: list[dict] = []
        for kind_def in APP_LIFECYCLE_KINDS:
            prefix = kind_def["prefix"]
            query = (
                f"WorkflowId STARTS_WITH '{prefix}' "
                f"AND ExecutionStatus = 'Failed'"
                f"{time_sql}"
            )
            try:
                count = 0
                async for wf in client.list_workflows(query=query, limit=limit_per_kind):
                    out.append({
                        "workflow_id":    getattr(wf, "id", None),
                        "run_id":         getattr(wf, "run_id", None),
                        "workflow_type":  getattr(wf, "workflow_type", None),
                        "kind":           kind_def["kind"],
                        "kind_label":     kind_def["label"],
                        "status":         "FAILED",
                        "start_time":     wf.start_time.isoformat() if getattr(wf, "start_time", None) else None,
                        "close_time":     wf.close_time.isoformat() if getattr(wf, "close_time", None) else None,
                        "history_length": getattr(wf, "history_length", None),
                    })
                    count += 1
                    if count >= limit_per_kind:
                        break
            except Exception:
                pass  # Don't let one kind break the other.

        # NOTE: we do NOT enrich rows here with app/tenant/env from input
        # payloads. Doing so would mean a Temporal history-fetch per row at
        # Dashboard-load time (effectively "investigating" before the user
        # asks). Enrichment happens on demand inside /investigate when the
        # user clicks the Investigate button on a row.
        return out

    try:
        rows = asyncio.run(_run())
    except Exception:
        stale = cached_entry["data"] if cached_entry else None
        return stale or {
            "failures": [], "start": start_iso, "end": end_iso, "error": True,
        }

    rows.sort(key=lambda r: r.get("close_time") or "", reverse=True)
    payload = {
        "failures":    rows[: 2 * limit_per_kind],
        "start":       start_iso,
        "end":         end_iso,
        "fetched_at":  datetime.now(timezone.utc).isoformat(),
        "namespace":   APP_LIFECYCLE_NAMESPACE,
    }
    _APP_LIFECYCLE_CACHE[cache_key] = {"ts": now, "data": payload}
    return payload


def _describe_workflow_statuses(workflow_ids: list[str], namespace: str | None = None) -> dict[str, dict]:
    """For each `workflow_id`, return its current Temporal status (e.g.
    COMPLETED / FAILED / RUNNING). Needed because a parent's event history
    only records a child's outcome if the parent observes it before terminating
    itself — when the parent fails first, the child may keep running and the
    parent's events never see its completion event.

    `namespace` overrides the default. Returns: { workflow_id: {...} }
    """
    if not workflow_ids:
        return {}

    ns = namespace or _temporal_namespace()
    async def _run() -> dict[str, dict]:
        client = await TemporalClient.connect(_temporal_target(), namespace=ns)

        async def _one(wf_id: str) -> tuple[str, dict]:
            try:
                desc = await client.get_workflow_handle(wf_id).describe()
                info = desc.raw_description.workflow_execution_info
                info_dict = MessageToDict(info, preserving_proto_field_name=False)
                status_raw = info_dict.get("status") or ""
                # status looks like "WORKFLOW_EXECUTION_STATUS_COMPLETED"; trim
                status = status_raw.replace("WORKFLOW_EXECUTION_STATUS_", "")
                return wf_id, {
                    "status":         status,
                    "close_time":     info_dict.get("closeTime"),
                    "start_time":     info_dict.get("startTime"),
                    "history_length": info_dict.get("historyLength"),
                    "run_id":         (info_dict.get("execution") or {}).get("runId"),
                }
            except Exception as e:
                return wf_id, {"error": f"{type(e).__name__}: {e}"}

        results = await asyncio.gather(*[_one(w) for w in workflow_ids],
                                       return_exceptions=False)
        return dict(results)

    try:
        return asyncio.run(_run())
    except Exception:
        # Don't break /investigate if Temporal describe fails for any reason —
        # the caller can fall back to the parent-events-derived status.
        return {}


VS_ROUTES_CSV = os.path.join(os.path.dirname(__file__), "..", "..", "Lambda", "jiffy-platform-vs-routes.csv")


# ── Load VirtualService route map (host → service info) ─────────────────────

def _load_vs_routes() -> dict:
    host_map = {}
    try:
        with open(VS_ROUTES_CSV, newline="", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            for row in reader:
                prefix = (row.get("Prefix") or "").strip()
                host = (row.get("Destination Host") or "").strip()
                port = (row.get("Port") or "").strip()
                if not host or not prefix or not prefix.startswith("/platform/"):
                    continue
                host_map[host.lower()] = {
                    "prefix": prefix,
                    "host": host,
                    "port": int(port) if port.isdigit() else port,
                    "serviceName": host,
                }
    except Exception:
        pass
    return host_map

_VS_ROUTES = _load_vs_routes()


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


def _resolve_service(url: str) -> dict | None:
    """Given http://jiffydrive:8080/drive/..., resolve to VS route info."""
    if not url:
        return None
    m = re.match(r'https?://([^/:]+)', url)
    if not m:
        return None
    return _VS_ROUTES.get(m.group(1).lower())


# ── Base64 helpers ───────────────────────────────────────────────────────────

def _try_b64_decode(val: str):
    try:
        decoded = base64.b64decode(val).decode("utf-8", errors="replace")
        try:
            return json.loads(decoded)
        except (json.JSONDecodeError, ValueError):
            return decoded
    except Exception:
        return val


def _decode_payloads(payloads: list) -> list:
    decoded = []
    for p in payloads:
        entry = {}
        meta = p.get("metadata", {})
        enc_raw = meta.get("encoding", "")
        if enc_raw:
            entry["encoding"] = _try_b64_decode(enc_raw) if isinstance(enc_raw, str) else enc_raw
        data_raw = p.get("data", "")
        if data_raw and isinstance(data_raw, str):
            entry["data"] = _try_b64_decode(data_raw)
        else:
            entry["data"] = data_raw
        decoded.append(entry)
    return decoded


def _decode_recursive(obj):
    if isinstance(obj, dict):
        if "payloads" in obj and isinstance(obj["payloads"], list):
            obj["payloads"] = _decode_payloads(obj["payloads"])
        for v in obj.values():
            _decode_recursive(v)
    elif isinstance(obj, list):
        for item in obj:
            _decode_recursive(item)


# ── URL helpers ──────────────────────────────────────────────────────────────

def _extract_url_path(url: str) -> str | None:
    m = re.search(r'https?://[^/]+(/.+)', url)
    return m.group(1).rstrip("'\"") if m else None


def _extract_urls_from_string(s: str) -> list:
    return re.findall(r'https?://[^\s\'"\\},]+', s)


# ── DSL parser ───────────────────────────────────────────────────────────────

def _parse_dsl_steps(steps: list, smap: dict, context: str = ""):
    """Recursively walk DSL steps and build stepId → info map."""
    if not isinstance(steps, list):
        return
    for step_obj in steps:
        if not isinstance(step_obj, dict):
            continue
        for step_id, step_def in step_obj.items():
            if not isinstance(step_def, dict):
                continue

            label = None
            desc = step_def.get("description", "")
            if desc:
                try:
                    label = json.loads(desc).get("label")
                except (json.JSONDecodeError, TypeError):
                    pass

            method = step_def.get("call")
            args = step_def.get("args")
            url_raw = (args.get("url", "") if isinstance(args, dict) else "") if args else ""
            url = None
            if url_raw:
                clean = re.sub(r"^\$\{'?|'?\}$", "", url_raw)
                found = _extract_urls_from_string(clean)
                if found:
                    url = found[0]

            svc = _resolve_service(url)

            smap[step_id] = {
                "label": label,
                "method": method,
                "url": url,
                "urlPath": _extract_url_path(url) if url else None,
                "context": context,
                "service": svc,
            }

            # Recurse into try/except/finally/switch
            if "try" in step_def:
                _parse_dsl_steps(step_def["try"].get("steps", []), smap, "try")
            if "except" in step_def:
                exc = step_def["except"]
                _parse_dsl_steps(exc.get("steps", []) if isinstance(exc, dict) else [], smap, "except")
            if "finally" in step_def:
                _parse_dsl_steps(step_def["finally"].get("steps", []), smap, "finally")
            if "switch" in step_def:
                for branch in step_def["switch"]:
                    if isinstance(branch, dict):
                        cond = branch.get("condition", "?")
                        _parse_dsl_steps(branch.get("steps", []), smap, f"switch({cond})")


def _build_step_map(events: list) -> dict:
    """Find fetchDSLByStepName result and parse all DSL steps."""
    smap = {}
    by_id = {str(e.get("eventId")): e for e in events}

    for evt in events:
        if evt.get("eventType") != "EVENT_TYPE_ACTIVITY_TASK_COMPLETED":
            continue
        attrs = evt.get("activityTaskCompletedEventAttributes", {})
        sched_id = str(attrs.get("scheduledEventId", ""))
        sched_attrs = by_id.get(sched_id, {}).get("activityTaskScheduledEventAttributes", {})
        if (sched_attrs.get("activityType") or {}).get("name") != "fetchDSLByStepName":
            continue

        for p in (attrs.get("result") or {}).get("payloads", []):
            d = p.get("data")
            if not isinstance(d, dict):
                continue
            for flow_def in (d.get("flow") or {}).values():
                if isinstance(flow_def, dict):
                    _parse_dsl_steps(flow_def.get("steps", []), smap)
    return smap


# ── Main analysis ────────────────────────────────────────────────────────────

def _make_path_entry(step_id, info):
    """Build a path entry dict with service info."""
    entry = {
        "stepId": step_id,
        "label": info.get("label"),
        "method": info.get("method"),
        "path": info.get("urlPath"),
        "url": info.get("url"),
        "context": info.get("context"),
        "service": None,
    }
    svc = info.get("service")
    if svc:
        entry["service"] = {
            "name": svc["serviceName"],
            "host": svc["host"],
            "port": svc["port"],
            "vsPrefix": svc["prefix"],
        }
    return entry


def _analyse_events(events: list) -> dict:
    summary = {
        "workflowId": None,
        "workflowType": None,
        "status": "COMPLETED",
        "failureMessage": None,
        "failureStepName": None,
        "failureStepLabel": None,
        "failureSource": None,
        "failedApiPaths": [],
        "activityFailures": [],
        "allApiPaths": [],
        "activityTimeline": [],
        "triggeredBy": None,
        "request": None,
    }

    by_id = {str(e.get("eventId")): e for e in events}
    smap = _build_step_map(events)

    # All API paths from DSL
    summary["allApiPaths"] = [
        _make_path_entry(sid, info)
        for sid, info in smap.items()
        if info.get("urlPath")
    ]

    for evt in events:
        etype = evt.get("eventType", "")

        if etype == "EVENT_TYPE_WORKFLOW_EXECUTION_STARTED":
            attrs = evt.get("workflowExecutionStartedEventAttributes", {})
            summary["workflowId"] = attrs.get("workflowId")
            summary["workflowType"] = (attrs.get("workflowType") or {}).get("name")

            # Extract trigger info from workflow input
            start_payloads = (attrs.get("input") or {}).get("payloads", [])
            for sp in start_payloads:
                d = sp.get("data")
                if isinstance(d, dict) and "headers" in d:
                    hdrs = d.get("headers") or {}
                    # Parse user from x-jiffy-auth-info JSON
                    auth_info_raw = hdrs.get("x-jiffy-auth-info", "")
                    trigger_user = ""
                    if auth_info_raw:
                        try:
                            auth_info = json.loads(auth_info_raw) if isinstance(auth_info_raw, str) else auth_info_raw
                            trigger_user = auth_info.get("user", "")
                        except (json.JSONDecodeError, TypeError):
                            pass
                    summary["triggeredBy"] = {
                        "user":       trigger_user or d.get("userName", ""),
                        "userAgent":  hdrs.get("user-agent", ""),
                        "ip":         hdrs.get("cf-connecting-ip") or hdrs.get("x-forwarded-for", "").split(",")[0].strip(),
                        "referer":    hdrs.get("referer", ""),
                        "origin":     hdrs.get("origin", ""),
                        "tenant":     d.get("tenantId", ""),
                        "appId":      d.get("appId", ""),
                        "appEnv":     d.get("appEnv", ""),
                    }
                    # Build request object for Postman-like view
                    orig_path = hdrs.get("x-envoy-original-path", "")
                    host = hdrs.get("host", "")
                    proto = hdrs.get("x-forwarded-proto", "https")
                    summary["request"] = {
                        "method":  "POST",
                        "url":     f"{proto}://{host}{orig_path}" if host and orig_path else "",
                        "host":    host,
                        "path":    orig_path,
                        "headers": {
                            "Content-Type":   hdrs.get("content-type", "application/json"),
                            "Authorization":  "Bearer <token>",
                            "Origin":         hdrs.get("origin", ""),
                            "User-Agent":     hdrs.get("user-agent", ""),
                            "Accept":         hdrs.get("accept", ""),
                            "Referer":        hdrs.get("referer", ""),
                        },
                        "params":  d.get("params") or {},
                    }
                    break

        elif etype == "EVENT_TYPE_ACTIVITY_TASK_SCHEDULED":
            attrs = evt.get("activityTaskScheduledEventAttributes", {})
            activity_name = (attrs.get("activityType") or {}).get("name", "")
            input_payloads = (attrs.get("input") or {}).get("payloads", [])

            step_label = None
            api_url = None
            step_id = None
            for p in input_payloads:
                d = p.get("data")
                if isinstance(d, str) and re.match(r'^z\d+$', d):
                    step_id = d
                if isinstance(d, dict):
                    desc = d.get("description", "")
                    if desc:
                        try:
                            step_label = json.loads(desc).get("label")
                        except (json.JSONDecodeError, TypeError):
                            pass
                    url_val = (d.get("args") or {}).get("url", "")
                    if url_val:
                        found = _extract_urls_from_string(url_val)
                        if found:
                            api_url = found[0]

            api_path = _extract_url_path(api_url) if api_url else None
            svc = _resolve_service(api_url)

            summary["activityTimeline"].append({
                "eventId": evt.get("eventId"),
                "activity": activity_name,
                "stepId": step_id,
                "label": step_label,
                "apiUrl": api_url,
                "apiPath": api_path,
                "service": {"name": svc["serviceName"], "host": svc["host"], "port": svc["port"], "vsPrefix": svc["prefix"]} if svc else None,
            })

        elif etype == "EVENT_TYPE_ACTIVITY_TASK_FAILED":
            attrs = evt.get("activityTaskFailedEventAttributes", {})
            failure = attrs.get("failure", {})
            msg = failure.get("message", "")

            scheduled_id = str(attrs.get("scheduledEventId", ""))
            sched_attrs = by_id.get(scheduled_id, {}).get("activityTaskScheduledEventAttributes", {})
            activity_name = (sched_attrs.get("activityType") or {}).get("name", "")

            api_url = None
            step_label = None
            step_id = None
            for p in (sched_attrs.get("input") or {}).get("payloads", []):
                d = p.get("data")
                if isinstance(d, str) and re.match(r'^z\d+$', d):
                    step_id = d
                if isinstance(d, dict):
                    desc = d.get("description", "")
                    if desc:
                        try:
                            step_label = json.loads(desc).get("label")
                        except (json.JSONDecodeError, TypeError):
                            pass
                    url_val = (d.get("args") or {}).get("url", "")
                    if url_val:
                        found = _extract_urls_from_string(url_val)
                        if found:
                            api_url = found[0]

            http_code = None
            error_body = None
            try:
                err_json = json.loads(msg)
                http_code = err_json.get("httpCode")
                error_body = err_json.get("body")
            except (json.JSONDecodeError, TypeError):
                pass

            api_path = _extract_url_path(api_url) if api_url else None
            svc = _resolve_service(api_url)

            # Also resolve from DSL if we have step_id
            if step_id and step_id in smap:
                dsl = smap[step_id]
                if not step_label:
                    step_label = dsl.get("label")
                if not api_path:
                    api_path = dsl.get("urlPath")
                if not svc:
                    svc = dsl.get("service")

            summary["activityFailures"].append({
                "eventId": evt.get("eventId"),
                "eventTime": evt.get("eventTime"),
                "activity": activity_name,
                "stepId": step_id,
                "label": step_label,
                "message": msg,
                "httpCode": http_code,
                "errorBody": error_body,
                "apiUrl": api_url,
                "apiPath": api_path,
                "retryState": attrs.get("retryState"),
                "service": {"name": svc["serviceName"], "host": svc["host"], "port": svc["port"], "vsPrefix": svc["prefix"]} if svc else None,
            })

        elif etype == "EVENT_TYPE_WORKFLOW_EXECUTION_FAILED":
            attrs = evt.get("workflowExecutionFailedEventAttributes", {})
            failure = attrs.get("failure", {})
            msg = failure.get("message", "")
            summary["status"] = "FAILED"
            summary["failureMessage"] = msg
            summary["failureSource"] = failure.get("source")

            step_match = re.search(r'step name:\s*(\S+)', msg)
            if step_match:
                failed_step_id = step_match.group(1)
                summary["failureStepName"] = failed_step_id

                if failed_step_id in smap:
                    dsl = smap[failed_step_id]
                    summary["failureStepLabel"] = dsl.get("label")
                    if dsl.get("urlPath"):
                        summary["failedApiPaths"] = [_make_path_entry(failed_step_id, dsl)]

    # Fallback: use activity failures if workflow failure didn't find paths
    if not summary["failedApiPaths"] and summary["activityFailures"]:
        for af in summary["activityFailures"]:
            if af.get("apiPath"):
                summary["failedApiPaths"].append({
                    "stepId": af.get("stepId"),
                    "label": af.get("label"),
                    "method": None,
                    "path": af["apiPath"],
                    "url": af.get("apiUrl"),
                    "context": "activity_failure",
                    "service": af.get("service"),
                })

    if not summary["failureMessage"] and summary["activityFailures"]:
        summary["status"] = "FAILED"
        summary["failureMessage"] = summary["activityFailures"][0].get("message")

    return summary


# ── OpenSearch service log fetch + root-cause analysis ──────────────────────

_OS_SOURCE_FIELDS = [
    "@timestamp", "time", "message", "log_level", "stream",
    "service_name", "event_dataset", "ecs_version",
    "log_logger", "process_thread_name",
    "traceId", "spanId", "tenantId", "userId", "appId",
    "kubernetes.pod_name", "kubernetes.container_name",
    "kubernetes.namespace_name", "kubernetes.pod_id",
    "kubernetes.host", "kubernetes.pod_ip",
    "kubernetes.labels.apex-app",
    "kubernetes.labels.app_kubernetes_io/version",
]


def _fetch_service_logs(service_host: str, failure_time_iso: str,
                        window_minutes: int = 2) -> list:
    """Query OpenSearch for ALL pod logs of *service_host* ± window_minutes."""
    try:
        clean_ts = re.sub(r'\.\d{7,9}Z$', 'Z', failure_time_iso)
        ts_utc = datetime.fromisoformat(clean_ts.replace("Z", "+00:00"))
    except Exception:
        return []

    start = (ts_utc - timedelta(minutes=window_minutes)).strftime("%Y-%m-%dT%H:%M:%SZ")
    end   = (ts_utc + timedelta(minutes=window_minutes)).strftime("%Y-%m-%dT%H:%M:%SZ")

    # Fetch error/warn logs first, then fill with all logs
    client = _os_client()
    all_logs = []

    # Query 1: Get ERROR + WARN logs (most important for diagnosis)
    error_query = {
        "size": 200,
        "sort": [{"@timestamp": {"order": "asc"}}],
        "_source": _OS_SOURCE_FIELDS,
        "query": {
            "bool": {
                "must": [
                    {"range": {"@timestamp": {"gte": start, "lte": end}}},
                    {"wildcard": {"kubernetes.pod_name": {"value": f"*{service_host}*"}}},
                    {"terms": {"log_level.keyword": ["ERROR", "WARN", "error", "warn"]}},
                ],
                "must_not": [
                    {"term": {"kubernetes.container_name.keyword": "istio-proxy"}},
                ],
            }
        },
    }

    # Query 2: Get ALL logs
    all_query = {
        "size": 2000,
        "sort": [{"@timestamp": {"order": "asc"}}],
        "_source": _OS_SOURCE_FIELDS,
        "query": {
            "bool": {
                "must": [
                    {"range": {"@timestamp": {"gte": start, "lte": end}}},
                    {"wildcard": {"kubernetes.pod_name": {"value": f"*{service_host}*"}}},
                ],
                "must_not": [
                    {"term": {"kubernetes.container_name.keyword": "istio-proxy"}},
                ],
            }
        },
    }

    try:
        error_resp = client.search(index="platform-*", body=error_query)
        error_logs = [h["_source"] for h in error_resp.get("hits", {}).get("hits", [])]

        all_resp = client.search(index="platform-*", body=all_query)
        all_logs = [h["_source"] for h in all_resp.get("hits", {}).get("hits", [])]

        # Merge: ensure error logs are included even if all_logs hit the 2000 limit
        if error_logs:
            existing_ts = {(l.get("@timestamp"), l.get("message", "")[:50]) for l in all_logs}
            for el in error_logs:
                key = (el.get("@timestamp"), el.get("message", "")[:50])
                if key not in existing_ts:
                    all_logs.append(el)
            all_logs.sort(key=lambda x: x.get("@timestamp", ""))

        return all_logs
    except Exception:
        return []


def _log_to_entry(log: dict) -> dict:
    # Field names differ between log sources: istio-proxy / service-pod logs use
    # `log_level` / `log_logger`; workhorse / Temporal-worker logs use `level` /
    # `logger_name`. Accept both. Stack traces are kept (truncated) because they
    # are the single most useful signal in workflow-failure RCA.
    return {
        "timestamp":     log.get("@timestamp"),
        "message":       log.get("message") or "",
        "level":         (log.get("log_level") or log.get("level") or "").upper(),
        "logger":        log.get("log_logger") or log.get("logger_name") or "",
        "thread":        log.get("process_thread_name") or "",
        "traceId":       log.get("traceId") or "",
        "spanId":        log.get("spanId") or "",
        "tenantId":      log.get("tenantId") or "",
        "appId":         log.get("appId") or "",
        "pod_name":      (log.get("kubernetes") or {}).get("pod_name", ""),
        "stack_trace":   (str(log.get("stack_trace") or ""))[:1500],
        "exception":     (str(log.get("exception") or ""))[:600],
        "correlationId": log.get("correlationId") or "",
        "workflowName":  log.get("workflowName") or "",
        "processName":   log.get("processName") or "",
    }


# ── Workflow-id-scoped log fetching ───────────────────────────────────────────
# Used when the failed-service path doesn't surface enough context (e.g. a
# ChildWorkflowFailure that doesn't pin to a specific service host).

_CHILD_WF_UUID_RE = re.compile(
    r"ChildWorkflowFailure[^']*workflowId='([a-f0-9\-]{36})'", re.IGNORECASE
)
_WF_LOG_SOURCE_FIELDS = [
    "@timestamp", "message", "level", "log_level",
    "logger_name", "log_logger", "correlationId",
    "workflowName", "processName", "appId", "tenantId",
    "stack_trace", "exception", "traceId", "spanId", "kubernetes",
]


def _score_wf_log(log: dict) -> int:
    """Mirror of Lambda/log_analysis.py:_score_error_log. Higher = better
    diagnostic value for a workflow RCA prompt."""
    msg = str(log.get("message") or "")
    st  = str(log.get("stack_trace") or "")
    lvl = str(log.get("level") or log.get("log_level") or "").upper()
    s = 0
    if any(x in msg for x in (
        "Variable does not exist", "Error while evaluating expression",
        "with temporal exception", "is unsupported", "WorkflowException",
    )):
        s += 100
    if "Workflow execution failure" in msg and st:
        s += 90
    if st.lstrip().startswith("io.jiffy"):
        s += 75
    elif "io.jiffy" in st:
        s += 60
    if "ChildWorkflowFailure" in st:
        s += 55
    if "No enclosed exception block was found" in msg:
        s += 35
    if st:
        s += 40
    if log.get("exception"):
        s += 30
    if lvl == "ERROR":
        s += 12
    elif lvl == "WARN":
        s += 6
    return s


def _fetch_workflow_logs_by_id(
    workflow_id: str,
    around_iso: str,
    window_minutes: int = 10,
) -> list:
    """Fetch OpenSearch logs that mention `workflow_id` — by `correlationId.keyword`
    or by a literal text match in `message`. The text match catches Temporal-worker
    logs that don't set correlationId (e.g. `Workflow execution failure WorkflowId='...'`).
    Returns the raw `_source` dicts; caller scores + entry-ifies them."""
    if not workflow_id or not around_iso:
        return []
    try:
        clean = re.sub(r'\.\d{7,9}Z$', 'Z', around_iso)
        ts = datetime.fromisoformat(clean.replace("Z", "+00:00"))
    except Exception:
        return []
    start = (ts - timedelta(minutes=window_minutes)).strftime("%Y-%m-%dT%H:%M:%SZ")
    end   = (ts + timedelta(minutes=window_minutes)).strftime("%Y-%m-%dT%H:%M:%SZ")

    body = {
        "size": 200,
        "sort": [{"@timestamp": {"order": "asc"}}],
        "_source": _WF_LOG_SOURCE_FIELDS,
        "query": {"bool": {
            "must":  [{"range": {"@timestamp": {"gte": start, "lte": end}}}],
            "should": [
                {"term":         {"correlationId.keyword": workflow_id}},
                {"match_phrase": {"message": workflow_id}},
            ],
            "minimum_should_match": 1,
        }},
    }
    try:
        resp = _os_client().search(index="platform-*", body=body)
        return [h["_source"] for h in resp.get("hits", {}).get("hits", [])]
    except Exception:
        return []


def _fetch_app_manager_logs(
    app_inst_id: str,
    around_iso: str,
    window_minutes: int = 15,
    max_size: int = 200,
) -> list:
    """Fetch OpenSearch logs scoped to a Jiffy app instance — the right query
    shape for `am-publish-*` / `am-start-app-*` workflows.

    Why this exists separately from `_fetch_workflow_logs_by_id`: app-manager
    workflows DO NOT carry the temporal workflow ID in their log messages or
    correlationId field. Instead, app-manager and every downstream service
    (app-sandbox-manager, deployment-manager, model-repo, jiffydrive, ...) all
    tag their logs with `appInstId` (the `AppInst.id` / `DeployInst.id` UUID).

    Reference: docs/app-publish-start-troubleshooting.md §6 "Logging signals".
    """
    if not app_inst_id or not around_iso:
        return []
    try:
        clean = re.sub(r'\.\d{7,9}Z$', 'Z', around_iso)
        ts = datetime.fromisoformat(clean.replace("Z", "+00:00"))
    except Exception:
        return []
    start = (ts - timedelta(minutes=window_minutes)).strftime("%Y-%m-%dT%H:%M:%SZ")
    end   = (ts + timedelta(minutes=window_minutes)).strftime("%Y-%m-%dT%H:%M:%SZ")

    # Pod-name filter scopes the noise — we only care about the services that
    # actually participate in publish/start (per the playbook).
    pod_should = [
        {"wildcard": {"kubernetes.pod_name.keyword": "*app-manager*"}},
        {"wildcard": {"kubernetes.pod_name.keyword": "*app-sandbox-manager*"}},
        {"wildcard": {"kubernetes.pod_name.keyword": "*deployment-manager*"}},
        {"wildcard": {"kubernetes.pod_name.keyword": "*model-repo*"}},
        {"wildcard": {"kubernetes.pod_name.keyword": "*jiffydrive*"}},
        {"wildcard": {"kubernetes.pod_name.keyword": "*comp-lib*"}},
    ]
    body = {
        "size": max_size,
        "sort": [{"@timestamp": {"order": "asc"}}],
        "_source": _WF_LOG_SOURCE_FIELDS + [
            "appInstId", "appName", "appId", "appVer", "appBaseVer",
            "operation", "mediator", "comp name", "comp version", "comp type",
            "partition name", "requestId",
        ],
        "query": {"bool": {
            "must": [
                {"range": {"@timestamp": {"gte": start, "lte": end}}},
                {"bool": {"should": [
                    {"term":         {"appInstId.keyword": app_inst_id}},
                    {"match_phrase": {"message": app_inst_id}},
                ], "minimum_should_match": 1}},
                {"bool": {"should": pod_should, "minimum_should_match": 1}},
            ],
        }},
    }
    try:
        resp = _os_client().search(index="platform-*", body=body)
        return [h["_source"] for h in resp.get("hits", {}).get("hits", [])]
    except Exception:
        return []


def _extract_child_workflow_ids_from_logs(logs: list) -> set[str]:
    """Find every `ChildWorkflowFailure: ... workflowId='<uuid>' ...` in any
    stack_trace and return the unique child workflow UUIDs."""
    out: set[str] = set()
    for log in logs:
        st = str(log.get("stack_trace") or "")
        if "ChildWorkflowFailure" in st:
            for m in _CHILD_WF_UUID_RE.finditer(st):
                out.add(m.group(1))
    return out


def _prepare_log_context(logs: list, service_host: str) -> dict:
    """Prepare logs for AI analysis. Dedupes the merged service-host + workflow-id
    log streams, scores them with the Lambda-side heuristic, and ensures the
    highest-signal entries (those with stack traces / Jiffy/Temporal error
    patterns) lead the AI's view even when traffic volume buries them."""
    # 1) Dedupe — the same log can appear in both the service-host fetch and
    # the workflow-id fetch. Key on timestamp + first 80 chars of message.
    seen: set = set()
    deduped: list = []
    for l in logs:
        key = (l.get("@timestamp"), (l.get("message") or "")[:80])
        if key in seen:
            continue
        seen.add(key)
        deduped.append(l)

    # 2) Build entries with stable idx (frontend serviceLogs uses these idx
    # values; AI's logIdx evidence refers to them too).
    entries: list = []
    for i, l in enumerate(deduped):
        e = _log_to_entry(l)
        e["idx"] = i
        e["_score"] = _score_wf_log(l)
        entries.append(e)

    error_entries = [e for e in entries if e["level"] in ("ERROR", "WARN")]
    info_entries  = [e for e in entries if e["level"] not in ("ERROR", "WARN")]

    # 3) AI subset — every error/warn entry sorted by score desc so high-signal
    # stack-trace logs come first. Top up with up to 200 info logs (sampled
    # evenly across the window) for surrounding context.
    error_entries_sorted = sorted(error_entries, key=lambda e: -e.get("_score", 0))
    ai_logs = list(error_entries_sorted)
    max_info = 200
    if len(info_entries) > max_info:
        step = len(info_entries) / max_info
        ai_logs += [info_entries[int(i * step)] for i in range(max_info)]
    else:
        ai_logs += info_entries

    return {
        "service":    service_host,
        "totalLogs":  len(entries),
        "errorCount": len(error_entries),
        "infoCount":  len(info_entries),
        "logs":       ai_logs,
        "allLogs":    entries,
    }


# ── AI root-cause analysis ──────────────────────────────────────────────────

def _get_anthropic_key() -> str | None:
    try:
        key = (get_config().get("anthropic") or {}).get("api_key")
        if key and key != "YOUR_ANTHROPIC_API_KEY_HERE":
            return key
    except Exception:
        pass
    return os.environ.get("ANTHROPIC_API_KEY")


def _ai_root_cause(analysis: dict, log_analysis: dict | None, past_fixes: list | None = None, app_context: dict | None = None) -> dict | None:
    """Send Temporal failure context + OpenSearch logs + past fixes to Claude for analysis."""
    api_key = _get_anthropic_key()
    if not api_key:
        return None

    # Build context for Claude
    # 1) Temporal workflow failure summary
    temporal_ctx = {
        "workflowId": analysis.get("workflowId"),
        "workflowType": analysis.get("workflowType"),
        "status": analysis.get("status"),
        "failureMessage": analysis.get("failureMessage"),
        "failureStepName": analysis.get("failureStepName"),
        "failureStepLabel": analysis.get("failureStepLabel"),
        "failureSource": analysis.get("failureSource"),
        "failedApiPaths": analysis.get("failedApiPaths", []),
        "activityFailures": [
            {
                "activity": af.get("activity"),
                "stepId": af.get("stepId"),
                "label": af.get("label"),
                "httpCode": af.get("httpCode"),
                "errorBody": af.get("errorBody"),
                "message": (af.get("message") or "")[:500],
                "apiPath": af.get("apiPath"),
                "service": af.get("service"),
            }
            for af in (analysis.get("activityFailures") or [])
        ],
    }

    # 2) Service pod logs (service-host ±2 min + workflow-id-scoped + any
    # ChildWorkflowFailure descendants) — idx already assigned, ordered with
    # highest-scoring stack-trace logs first so the AI doesn't miss them.
    logs_ctx = None
    if log_analysis:
        logs_for_ai = []
        for e in (log_analysis.get("logs") or []):
            entry = {
                "idx":       e["idx"],
                "timestamp": e.get("timestamp"),
                "level":     e.get("level"),
                "message":   (e.get("message") or "")[:600],
                "logger":    e.get("logger"),
                "traceId":   e.get("traceId"),
                "pod_name":  e.get("pod_name"),
            }
            # Stack traces are the single most valuable signal for workflow
            # RCA. Truncated, but enough for the AI to see the failure chain.
            if e.get("stack_trace"):
                entry["stack_trace"] = e["stack_trace"][:1200]
            if e.get("exception"):
                entry["exception"] = e["exception"][:500]
            if e.get("correlationId"):
                entry["correlationId"] = e["correlationId"]
            if e.get("processName"):
                entry["processName"] = e["processName"]
            logs_for_ai.append(entry)
        logs_ctx = {
            "service":    log_analysis.get("service"),
            "totalLogs":  log_analysis.get("totalLogs"),
            "errorCount": log_analysis.get("errorCount"),
            "logs":       logs_for_ai,
        }

    # Detect app-manager publish/start workflows so we can inject the
    # playbook context — Claude needs to know the step sequence + error
    # shapes for these workflows to produce a useful RCA.
    _wf_id    = (analysis.get("workflowId") or "").strip()
    _wf_type  = (analysis.get("workflowType") or "").strip()
    is_publish_wf = _wf_id.startswith("am-publish-") or _wf_type == "PublishAppWorkflow"
    is_start_wf   = _wf_id.startswith("am-start-app-") or _wf_type == "DeployAndWaitToCompleteWorkflow"
    am_playbook = ""
    if is_publish_wf or is_start_wf:
        am_playbook = """
## App-Manager Playbook Context (for am-publish-* / am-start-app-* workflows)

These workflows live in Temporal's `default` namespace and run inside the
`app-manager` service. The relevant log join key is `appInstId` (NOT the
Temporal workflow ID). All downstream services (app-sandbox-manager,
deployment-manager, model-repo, jiffydrive, comp-lib) also tag logs with the
same `appInstId`, so the OpenSearch logs below come from across the chain.

### Publish flow (am-publish-*, PublishAppWorkflow) — step order
1. CleanupPublishMetadataInDrive (best-effort, doesn't fail the workflow)
2. InvokeMediatorActivity, called once PER mediator (iam, sandbox, jiffydrive, etc.)
   — error shape: `mediator <name> returned error on publish - <wrapped err>`
3. BackupApp (creates rollback snapshot)
4. UpdateModelRepoMediatedSvcsActivity (bumps versions in model-repo)
5. PublishAppInWorkflow (writes app rows + CLS publish + asset copy)
6. (new apps only, best-effort) MoveSharedDriveDataOnPublish, DeletePublicDriveForApp
7. DeleteAppBackup (best-effort)
8. (if !IsNotReady) PostPublishActivity or EditAndDeployActivity
On failure at step 5: auto-rollback runs RevertUpdatedModelRepoMediatedSvcsActivity + RestoreApp.
If rollback ALSO fails, the failure message includes `restoring backup failed with err:` — flag this as needing manual intervention.

### Start/deploy flow (am-start-app-*, DeployAndWaitToCompleteWorkflow) — step order
1. DeployStepCopyDriveData → CloneSharedDriveDataActivity + CopyDataFromGlobalDriveActivity
2. DeployStepUpgradeComponentModels → UpgradeComponentModelsActivity
   — error shape: `failed to upgrade app component models (err: <wrapped err>)`
3. DeployStepStartDeploy → StartDeployActivity (calls Deployment Manager)
   — error shape: `Deploy request on deployment manager failed: <wrapped err>`
4. DeployStepUpradeAppUsingDm → UpgradeAppUsingDomainModelActivity
5. WaitForDeployToCompleteActivity (polls DM every 2s for k8s readiness)
Workflow bails on the first failed step. No rollback; final status persists to Postgres `app_inst_state`.

### How to read the logs below
- `appName`, `appInstId`, `appId`, `tenantId`, `appVer`, `appBaseVer`, `operation`,
  `partition name`, `comp name`, `comp version`, `comp type`, `mediator`, `requestId` —
  these zap fields will appear on relevant rows. The `mediator` field tells you
  which mediator (iam, sandbox, jiffydrive, ...) was being invoked when an error
  was logged. The `comp name` / `comp version` / `comp type` triple identifies a
  specific component.
- Pod-name prefixes:
  * `app-manager-*` — the orchestrator; most failure messages originate here
  * `app-sandbox-manager-*` — ASM (clone-drive failures)
  * `deployment-manager-*` — DM (StartDeploy / WaitForDeploy failures)
  * `model-repo-*` — component registry (`component not found`, `version not found`)
  * `jiffydrive-*` — drive write failures during publish or copy
  * `comp-lib-*` — component library lookups
- Look for ERROR/WARN level rows first; map them to the step list above.

### Common failure → cause mapping
- `mediator <X> returned error on publish - component '<C>' version '<V>' not found`
  → component-V not in model-repo. Republish that component first.
- `Deploy request on deployment manager failed: <k8s err>`
  → namespace missing / RBAC / image-pull / helm validation. Check DM logs and pod events.
- `failed to upgrade app component models (err: ...)`
  → component-model migration failed. Check the running pod for migration errors.
- Hangs at WaitForDeployToCompleteActivity for >15min
  → k8s pod CrashLoopBackOff or ImagePullBackOff. Identify pod, read events.

When you produce the RCA, name the SPECIFIC step from the list above as the
failureStepName / label, and cite log idx values that prove it.
"""

    prompt = f"""You are an expert SRE analyzing a failed Temporal workflow on the Jiffy platform (Kubernetes microservices).

## Temporal Workflow Failure Context
```json
{json.dumps(temporal_ctx, indent=2, default=str)}
```

## App Context (decoded from workflow input payload)
```json
{json.dumps(app_context, indent=2, default=str) if app_context else "(no app context extracted)"}
```
{am_playbook}
## Service Pod Logs from OpenSearch (±2 min around failure)
Each log entry has an "idx" field — this is the log's index number. Use it to reference specific logs.
```json
{json.dumps(logs_ctx, indent=2, default=str) if logs_ctx else "No service logs available"}
```

## Past Fixes from Knowledge Base
These are fixes that users previously submitted for similar errors. If any are relevant, incorporate them into your resolution and mark usedPastFix=true.
```json
{json.dumps([{"fix": f["fix_description"], "error_step": (f.get("error_signature") or {}).get("error_step", ""), "error_service": (f.get("error_signature") or {}).get("error_service", ""), "tags": f.get("ai_tags", []), "app": f.get("app_name", "")} for f in (past_fixes or [])], indent=2, default=str) if past_fixes else "No past fixes available yet"}
```

Respond with ONLY a valid JSON object (no markdown, no code fences, no extra text). The JSON must follow this exact schema:

{{
  "rootCause": "<1-2 sentences. State the exact infrastructure/config problem. Be extremely specific — name the exact resource (bucket name, file path, DB record), whether source or destination failed, the error code, HTTP status, and service name.>",
  "failureChain": [
    {{
      "step": 1,
      "stepId": "<Temporal step ID like z1074759674172, or null if not a workflow step>",
      "label": "<human-readable label from DSL, e.g. 'Copy file to space', or a short description>",
      "description": "<what happened at this step — be specific with exact paths, bucket names, parameters>",
      "evidence": {{
        "logIdx": <integer — the "idx" value of the OpenSearch log entry that proves this step. Use null only if evidence comes from Temporal event data, not from a log>,
        "source": "<'opensearch' if referencing a log entry, or 'temporal' if referencing a Temporal event>"
      }}
    }}
  ],
  "resolution": [
    "<specific actionable step with exact values — bucket names, commands, tenant IDs from the data>"
  ],
  "prevention": "<1-2 sentences on how to prevent recurrence>",
  "usedPastFix": <true if you incorporated a past fix from the knowledge base, false otherwise>,
  "pastFixNote": "<if usedPastFix is true, briefly explain which past fix was relevant and how it applies>"
}}

Rules:
- failureChain should have 3-8 steps tracing the COMPLETE sequence from trigger to final failure
- If past fixes from the knowledge base are relevant, PRIORITIZE them in the resolution — real users confirmed these fixes worked
- Every step MUST have evidence. Use logIdx to point to the specific OpenSearch log entry (by its idx field). The frontend will display the full log line from that index.
- For evidence from Temporal events (not OpenSearch logs), set logIdx to null and source to "temporal"
- rootCause must name the EXACT failing resource (e.g. specific bucket ID, not just "a bucket")
- resolution should have 2-4 items with real values from the data (bucket names, paths, tenant IDs, commands)
- Do NOT wrap in markdown code fences. Output raw JSON only."""

    try:
        client = anthropic.Anthropic(api_key=api_key)
        message = client.messages.create(
            model="claude-opus-4-8",
            max_tokens=3000,
            messages=[{"role": "user", "content": prompt}],
        )
        ai_text = (message.content[0].text if message.content else "").strip()

        # Parse the JSON response from Claude
        # Strip markdown code fences if present
        if ai_text.startswith("```"):
            ai_text = re.sub(r'^```(?:json)?\s*', '', ai_text)
            ai_text = re.sub(r'\s*```$', '', ai_text)
        try:
            parsed = json.loads(ai_text)
        except json.JSONDecodeError:
            parsed = {"rawText": ai_text}

        return {
            **parsed,
            "model": message.model,
            "tokensUsed": {
                "input": message.usage.input_tokens,
                "output": message.usage.output_tokens,
            },
        }
    except Exception as e:
        return {"error": str(e)}


# ── callable investigation (used by Teams background task) ───────────────────

def run_workflow_investigation(workflow_id: str, namespace: str | None = None) -> dict:
    """Run the full per-workflow investigation and return the AI analysis dict.
    Called by the Teams 'Investigate' background task in routers/alerts.py.
    Returns {"workflow_id", "ai_analysis", "analysis", "app_context"}.
    """
    workflow_id = workflow_id.strip()
    events_list = _fetch_workflow_events(workflow_id, namespace=namespace)
    _decode_recursive(events_list)
    analysis = _analyse_events(events_list)

    # Extract app context from WorkflowExecutionStarted input payload
    app_context: dict = {}
    start_evt = next(
        (e for e in events_list if e.get("eventType") == "EVENT_TYPE_WORKFLOW_EXECUTION_STARTED"),
        None,
    )
    if start_evt:
        start_attrs = next((start_evt[k] for k in start_evt if k.endswith("EventAttributes")), {}) or {}
        payloads = (start_attrs.get("input") or {}).get("payloads") or []
        for entry in (_decode_payloads(payloads) if payloads else []):
            data = entry.get("data")
            if not isinstance(data, dict):
                continue
            app      = data.get("App") or {}
            env_part = data.get("EnvPartition") or {}
            env_blk  = data.get("Env") or {}
            app_inst = data.get("AppInst") or data.get("DeployInst") or {}
            tenant_name = None
            ns = (env_part.get("nameSpace") or "").strip()
            if ns and "-" in ns:
                tenant_name = ns.split("-", 1)[1] or None
            if not tenant_name:
                fqdn = (env_part.get("appFqdnSuffix") or "").strip()
                parts = [p for p in fqdn.split(".") if p]
                if len(parts) >= 2:
                    tenant_name = parts[1]
            app_context = {
                "app_display_name": app.get("displayName") or app.get("name"),
                "app_name":         app.get("name"),
                "app_id":           app.get("id"),
                "app_inst_id":      app_inst.get("id"),
                "app_version":      app_inst.get("version") or app_inst.get("Version"),
                "tenant_id":        app.get("tenantId") or env_part.get("tenantId"),
                "tenant_name":      tenant_name,
                "environment":      env_part.get("name") or env_blk.get("name"),
                "namespace":        env_part.get("nameSpace"),
            }
            break

    # Identify failed service host and failure time for log fetching
    failed_svc_host = None
    failure_time    = None
    for af in (analysis.get("activityFailures") or []):
        svc = af.get("service")
        et  = af.get("eventTime")
        if svc and et:
            failed_svc_host = svc["host"]
            failure_time    = et
            break
    if not failed_svc_host:
        for fp in (analysis.get("failedApiPaths") or []):
            if fp.get("service"):
                failed_svc_host = fp["service"]["host"]
                break

    # Fetch service + workflow logs
    logs: list = []
    if failed_svc_host and failure_time:
        try:
            logs = _fetch_service_logs(failed_svc_host, failure_time, window_minutes=2)
        except Exception:
            pass

    wf_failure_time = failure_time
    if not wf_failure_time:
        for evt in events_list:
            if evt.get("eventType") == "EVENT_TYPE_WORKFLOW_EXECUTION_FAILED":
                wf_failure_time = evt.get("eventTime")
                break
        if not wf_failure_time and events_list:
            wf_failure_time = events_list[-1].get("eventTime")

    if wf_failure_time:
        try:
            primary = _fetch_workflow_logs_by_id(workflow_id, wf_failure_time)
            logs.extend(primary)
            for cid in list(_extract_child_workflow_ids_from_logs(primary))[:3]:
                if cid != workflow_id:
                    logs.extend(_fetch_workflow_logs_by_id(cid, wf_failure_time))
        except Exception:
            pass

    if app_context.get("app_inst_id") and wf_failure_time:
        try:
            logs.extend(_fetch_app_manager_logs(app_context["app_inst_id"], wf_failure_time))
        except Exception:
            pass

    log_context = _prepare_log_context(logs, failed_svc_host or workflow_id) if logs else None

    # Past fixes from knowledge base
    past_fixes: list = []
    if analysis.get("status") == "FAILED":
        try:
            past_fixes = _find_similar_fixes(_extract_error_signature(analysis, None))
        except Exception:
            pass

    # AI root-cause analysis
    ai_analysis = None
    if analysis.get("status") == "FAILED":
        try:
            ai_analysis = _ai_root_cause(
                analysis, log_context, past_fixes=past_fixes, app_context=app_context
            )
        except Exception as e:
            ai_analysis = {"error": str(e)}

    return {
        "workflow_id": workflow_id,
        "ai_analysis": ai_analysis,
        "analysis":    analysis,
        "app_context": app_context,
    }


# ── endpoint ─────────────────────────────────────────────────────────────────

@router.get("/investigate")
def investigate_workflow(
    workflow_id: str = Query(..., description="Temporal workflow ID"),
    namespace: str | None = Query(None, description="Temporal namespace override (e.g. 'default' for app publish/start workflows)"),
):
    if not workflow_id or not workflow_id.strip():
        raise HTTPException(status_code=400, detail="workflow_id is required")

    events_list = _fetch_workflow_events(workflow_id.strip(), namespace=namespace)
    _decode_recursive(events_list)
    analysis = _analyse_events(events_list)

    # Extract app/tenant/env from the WorkflowExecutionStarted input payload
    # NOW (before logs are fetched) — the `app_inst_id` is needed to scope the
    # app-manager OpenSearch query below. Reuses _enrich_lifecycle_failure's
    # parser via a synchronous walk over the already-fetched events.
    app_context: dict = {}
    start_evt_early = next(
        (e for e in events_list if e.get("eventType") == "EVENT_TYPE_WORKFLOW_EXECUTION_STARTED"),
        None,
    )
    if start_evt_early:
        _attrs = next((start_evt_early[k] for k in start_evt_early if k.endswith("EventAttributes")), {}) or {}
        for _entry in (_decode_payloads((_attrs.get("input") or {}).get("payloads") or []) or []):
            _d = _entry.get("data") or {}
            if not isinstance(_d, dict):
                continue
            _app      = _d.get("App") or {}
            _env_part = _d.get("EnvPartition") or {}
            _env_blk  = _d.get("Env") or {}
            _inst     = _d.get("AppInst") or _d.get("DeployInst") or {}
            _tenant_name = None
            _ns = (_env_part.get("nameSpace") or "").strip()
            if _ns and "-" in _ns:
                _tenant_name = _ns.split("-", 1)[1] or None
            if not _tenant_name:
                _fqdn = (_env_part.get("appFqdnSuffix") or "").strip()
                _parts = [p for p in _fqdn.split(".") if p]
                if len(_parts) >= 2:
                    _tenant_name = _parts[1]
            app_context = {
                "app_display_name": _app.get("displayName") or _app.get("name"),
                "app_name":         _app.get("name"),
                "app_id":           _app.get("id"),
                "app_inst_id":      _inst.get("id"),
                "app_version":      _inst.get("version") or _inst.get("Version"),
                "tenant_id":        _app.get("tenantId") or _env_part.get("tenantId"),
                "tenant_name":      _tenant_name,
                "environment":      _env_part.get("name") or _env_blk.get("name"),
                "namespace":        _env_part.get("nameSpace"),
            }
            break

    # ── Fetch service logs from OpenSearch around the failure ──
    log_analysis = None
    failed_svc_host = None
    failure_time = None

    # 1) From activity failures (most precise — has eventTime + service)
    for af in (analysis.get("activityFailures") or []):
        svc = af.get("service")
        et  = af.get("eventTime")
        if svc and et:
            failed_svc_host = svc["host"]
            failure_time = et
            break

    # 2) Fallback: from failedApiPaths + workflow-failure eventTime
    if not failed_svc_host:
        for fp in (analysis.get("failedApiPaths") or []):
            if fp.get("service"):
                failed_svc_host = fp["service"]["host"]
                break
        if failed_svc_host:
            for evt in events_list:
                if evt.get("eventType") == "EVENT_TYPE_WORKFLOW_EXECUTION_FAILED":
                    failure_time = evt.get("eventTime")
                    break

    log_context = None
    log_fetch_error = None
    logs: list = []
    if failed_svc_host and failure_time:
        try:
            logs = _fetch_service_logs(failed_svc_host, failure_time, window_minutes=2)
        except Exception as e:
            log_fetch_error = str(e)
            logs = []

    # Always also pull workflow-id-scoped logs. Required for failures where no
    # service host can be identified from Temporal events — e.g. a Jiffy DSL
    # `ChildWorkflowFailure` where the parent worker bubbles up the child's
    # error without naming a service. Also catches the Temporal-worker stack
    # trace lines that pinpoint the failing child workflow UUID, which we then
    # recurse into so the AI can see the actual root error.
    wf_failure_time = failure_time
    if not wf_failure_time:
        for evt in events_list:
            if evt.get("eventType") == "EVENT_TYPE_WORKFLOW_EXECUTION_FAILED":
                wf_failure_time = evt.get("eventTime")
                break
        if not wf_failure_time and events_list:
            wf_failure_time = events_list[-1].get("eventTime")

    if wf_failure_time:
        try:
            primary = _fetch_workflow_logs_by_id(workflow_id.strip(), wf_failure_time)
            logs.extend(primary)
            child_ids = _extract_child_workflow_ids_from_logs(primary)
            for cid in list(child_ids)[:3]:   # cap depth — usually 0 or 1 child
                if cid == workflow_id.strip():
                    continue
                logs.extend(_fetch_workflow_logs_by_id(cid, wf_failure_time))
        except Exception as e:
            log_fetch_error = (log_fetch_error or "") + f" wf-logs: {e}"

    # ── App-manager / publish-start path ─────────────────────────────────────
    # The workflow-id text match above will miss app-manager workflows
    # (am-publish-* / am-start-app-*) because app-manager doesn't carry the
    # Temporal workflow ID in its logs — it keys on `appInstId`. Uses the
    # `app_inst_id` already extracted from the input payload above. See
    # docs/app-publish-start-troubleshooting.md for the field map.
    if app_context.get("app_inst_id") and wf_failure_time:
        try:
            am_logs = _fetch_app_manager_logs(app_context["app_inst_id"], wf_failure_time)
            logs.extend(am_logs)
        except Exception as e:
            log_fetch_error = (log_fetch_error or "") + f" app-manager-logs: {e}"

    if logs:
        log_context = _prepare_log_context(logs, failed_svc_host or workflow_id.strip())

    # ── Search knowledge base for similar past fixes ──
    past_fixes = []
    error_sig = {}
    if analysis.get("status") == "FAILED":
        error_sig = _extract_error_signature(analysis, None)
        try:
            past_fixes = _find_similar_fixes(error_sig)
        except Exception:
            pass

    # ── AI root-cause analysis using Claude ──
    ai_analysis = None
    if analysis.get("status") == "FAILED":
        try:
            ai_analysis = _ai_root_cause(analysis, log_context, past_fixes=past_fixes, app_context=app_context)
        except Exception as e:
            ai_analysis = {"error": str(e)}

    # Build serviceLogs for the frontend (all logs with stable idx)
    service_logs = None
    if log_context and log_context.get("allLogs"):
        service_logs = log_context["allLogs"]

    # ── Related-workflow statuses (parent + children) ────────────────────────
    # We always re-describe related workflows directly from Temporal because:
    #  - Child outcomes in the parent's events only record what the parent saw
    #    before terminating (callback children often finish later, unseen).
    #  - The parent row needs a status badge too.
    related_wf_ids: list[str] = []
    start_evt = next(
        (e for e in events_list if e.get("eventType") == "EVENT_TYPE_WORKFLOW_EXECUTION_STARTED"),
        None,
    )
    parent_exec = None
    if start_evt:
        start_attrs = next((start_evt[k] for k in start_evt if k.endswith("EventAttributes")), {}) or {}
        parent_exec = start_attrs.get("parentWorkflowExecution") or start_attrs.get("parent_workflow_execution")
        if parent_exec:
            parent_wfid = parent_exec.get("workflowId") or parent_exec.get("workflow_id")
            if parent_wfid:
                related_wf_ids.append(parent_wfid)
    for evt in events_list:
        if evt.get("eventType") == "EVENT_TYPE_START_CHILD_WORKFLOW_EXECUTION_INITIATED":
            attrs = next((evt[k] for k in evt if k.endswith("EventAttributes")), {}) or {}
            wfid = attrs.get("workflowId") or attrs.get("workflow_id")
            if wfid and wfid not in related_wf_ids:
                related_wf_ids.append(wfid)
    child_workflows = _describe_workflow_statuses(related_wf_ids, namespace=namespace) if related_wf_ids else {}

    # Extract app/tenant/env directly from the already-fetched
    # WorkflowExecutionStarted event — no extra Temporal call. Same parser
    # used to be at the dashboard layer; moved here so the cost is paid
    # only when the user actually clicks Investigate.
    app_context: dict = {}
    if start_evt:
        start_attrs = next((start_evt[k] for k in start_evt if k.endswith("EventAttributes")), {}) or {}
        payloads = (start_attrs.get("input") or {}).get("payloads") or []
        for entry in (_decode_payloads(payloads) if payloads else []):
            data = entry.get("data")
            if not isinstance(data, dict):
                continue
            app      = data.get("App") or {}
            env_part = data.get("EnvPartition") or {}
            env_blk  = data.get("Env") or {}
            # AppInst.id (publish) or DeployInst.id (start) is the join key
            # downstream services log under `appInstId` —
            # see docs/app-publish-start-troubleshooting.md.
            app_inst = data.get("AppInst") or data.get("DeployInst") or {}
            tenant_name = None
            ns = (env_part.get("nameSpace") or "").strip()
            if ns and "-" in ns:
                tenant_name = ns.split("-", 1)[1] or None
            if not tenant_name:
                fqdn = (env_part.get("appFqdnSuffix") or "").strip()
                parts = [p for p in fqdn.split(".") if p]
                if len(parts) >= 2:
                    tenant_name = parts[1]
            app_context = {
                "app_display_name": app.get("displayName") or app.get("name"),
                "app_name":         app.get("name"),
                "app_id":           app.get("id"),
                "app_inst_id":      app_inst.get("id"),
                "app_version":      app_inst.get("version") or app_inst.get("Version"),
                "tenant_id":        app.get("tenantId") or env_part.get("tenantId"),
                "tenant_name":      tenant_name,
                "environment":      env_part.get("name") or env_blk.get("name"),
                "namespace":        env_part.get("nameSpace"),
            }
            break

    return {
        "events": events_list,
        "analysis": analysis,
        "aiAnalysis": ai_analysis,
        "serviceLogs": service_logs,
        "pastFixes": past_fixes,
        "childWorkflows": child_workflows,
        "appContext": app_context,
        "_debug": {
            "failedService": failed_svc_host,
            "failureTime": failure_time,
            "logsFound": len(log_context.get("logs", [])) if log_context else 0,
            "logFetchError": log_fetch_error,
            "apiKeySet": _get_anthropic_key() is not None,
            "statusIsFailed": analysis.get("status") == "FAILED",
        },
    }


# ── Fix Knowledge Base ────────────────────────────────────────────────────────

def _extract_error_signature(analysis: dict, ai_analysis: dict | None) -> dict:
    """Extract searchable error characteristics from a workflow failure."""
    sig = {}
    # From activity failures
    act_fails = analysis.get("activityFailures") or []
    if act_fails:
        af = act_fails[0]
        sig["error_step"] = af.get("label") or af.get("stepId") or ""
        sig["error_service"] = (af.get("service") or {}).get("name", "")
        sig["error_http_code"] = af.get("httpCode")
        sig["error_message"] = (af.get("message") or "")[:500]
        sig["error_body"] = (str(af.get("errorBody") or ""))[:500]
    # From failed API paths
    failed_paths = analysis.get("failedApiPaths") or []
    if failed_paths:
        sig["error_api_path"] = failed_paths[0].get("path", "")
    # From AI analysis
    if ai_analysis and ai_analysis.get("rootCause"):
        sig["ai_root_cause"] = ai_analysis["rootCause"][:500]
    return sig


def _find_similar_fixes(error_sig: dict, limit: int = 5) -> list:
    """Search fix_knowledge_base for fixes matching similar error patterns."""
    db = get_db()
    col = db["fix_knowledge_base"]

    # Build OR query matching any of the error characteristics
    or_clauses = []
    if error_sig.get("error_service"):
        or_clauses.append({"error_signature.error_service": error_sig["error_service"]})
    if error_sig.get("error_http_code"):
        or_clauses.append({"error_signature.error_http_code": error_sig["error_http_code"]})
    if error_sig.get("error_api_path"):
        or_clauses.append({"error_signature.error_api_path": error_sig["error_api_path"]})
    if error_sig.get("error_step"):
        or_clauses.append({"error_signature.error_step": error_sig["error_step"]})

    if not or_clauses:
        return []

    results = list(col.find(
        {"$or": or_clauses},
        {"_id": 0, "fix_description": 1, "error_signature": 1, "workflow_id": 1,
         "tenant": 1, "app_name": 1, "submitted_at": 1, "ai_tags": 1},
    ).sort("submitted_at", -1).limit(limit))
    return results


@router.post("/submit-fix")
def submit_fix(payload: dict = Body(...)):
    """Store a user-submitted fix in the knowledge base."""
    workflow_id = (payload.get("workflow_id") or "").strip()
    fix_text = (payload.get("fix_description") or "").strip()
    if not workflow_id or not fix_text:
        raise HTTPException(status_code=400, detail="workflow_id and fix_description are required")

    # Build error signature from the provided context
    error_sig = {}
    ctx = payload.get("error_context") or {}
    for key in ["error_step", "error_service", "error_http_code", "error_message",
                "error_body", "error_api_path", "ai_root_cause"]:
        if ctx.get(key):
            error_sig[key] = ctx[key]

    # Use Claude to extract tags and categorise the fix
    ai_tags = []
    api_key = _get_anthropic_key()
    if api_key and fix_text:
        try:
            client = anthropic.Anthropic(api_key=api_key)
            tag_resp = client.messages.create(
                model="claude-haiku-4-5-20251001",
                max_tokens=200,
                messages=[{"role": "user", "content": f"""Extract 3-6 short tags/keywords from this fix description for a workflow failure.
Return ONLY a JSON array of lowercase strings, no other text.
Fix: "{fix_text}"
Error context: {json.dumps(error_sig)}"""}],
            )
            tag_text = (tag_resp.content[0].text if tag_resp.content else "").strip()
            if tag_text.startswith("```"):
                tag_text = re.sub(r'^```(?:json)?\s*', '', tag_text)
                tag_text = re.sub(r'\s*```$', '', tag_text)
            ai_tags = json.loads(tag_text) if tag_text.startswith("[") else []
        except Exception:
            pass

    doc = {
        "workflow_id": workflow_id,
        "tenant": payload.get("tenant", ""),
        "app_name": payload.get("app_name", ""),
        "fix_description": fix_text,
        "error_signature": error_sig,
        "ai_tags": ai_tags,
        "submitted_at": datetime.now(timezone.utc).isoformat(),
    }

    db = get_db()
    db["fix_knowledge_base"].insert_one(doc)
    return {"status": "saved", "tags": ai_tags}


@router.get("/debug-investigate")
def debug_investigate(workflow_id: str = Query(..., description="Temporal workflow ID")):
    """Lightweight version of /investigate — returns only debug, aiAnalysis, and analysis summary (no events)."""
    if not workflow_id or not workflow_id.strip():
        raise HTTPException(status_code=400, detail="workflow_id is required")

    events_list = _fetch_workflow_events(workflow_id.strip())
    _decode_recursive(events_list)
    analysis = _analyse_events(events_list)

    # Find failed service + time
    failed_svc_host = None
    failure_time = None
    for af in (analysis.get("activityFailures") or []):
        svc = af.get("service")
        et = af.get("eventTime")
        if svc and et:
            failed_svc_host = svc["host"]
            failure_time = et
            break
    if not failed_svc_host:
        for fp in (analysis.get("failedApiPaths") or []):
            if fp.get("service"):
                failed_svc_host = fp["service"]["host"]
                break
        if failed_svc_host:
            for evt in events_list:
                if evt.get("eventType") == "EVENT_TYPE_WORKFLOW_EXECUTION_FAILED":
                    failure_time = evt.get("eventTime")
                    break

    # Fetch logs
    log_context = None
    log_fetch_error = None
    logs: list = []
    if failed_svc_host and failure_time:
        try:
            logs = _fetch_service_logs(failed_svc_host, failure_time, window_minutes=2)
        except Exception as e:
            log_fetch_error = str(e)
            logs = []

    # Always also pull workflow-id-scoped logs. Required for failures where no
    # service host can be identified from Temporal events — e.g. a Jiffy DSL
    # `ChildWorkflowFailure` where the parent worker bubbles up the child's
    # error without naming a service. Also catches the Temporal-worker stack
    # trace lines that pinpoint the failing child workflow UUID, which we then
    # recurse into so the AI can see the actual root error.
    wf_failure_time = failure_time
    if not wf_failure_time:
        for evt in events_list:
            if evt.get("eventType") == "EVENT_TYPE_WORKFLOW_EXECUTION_FAILED":
                wf_failure_time = evt.get("eventTime")
                break
        if not wf_failure_time and events_list:
            wf_failure_time = events_list[-1].get("eventTime")

    if wf_failure_time:
        try:
            primary = _fetch_workflow_logs_by_id(workflow_id.strip(), wf_failure_time)
            logs.extend(primary)
            child_ids = _extract_child_workflow_ids_from_logs(primary)
            for cid in list(child_ids)[:3]:   # cap depth — usually 0 or 1 child
                if cid == workflow_id.strip():
                    continue
                logs.extend(_fetch_workflow_logs_by_id(cid, wf_failure_time))
        except Exception as e:
            log_fetch_error = (log_fetch_error or "") + f" wf-logs: {e}"

    # ── App-manager / publish-start path ─────────────────────────────────────
    # The workflow-id text match above will miss app-manager workflows
    # (am-publish-* / am-start-app-*) because app-manager doesn't carry the
    # Temporal workflow ID in its logs — it keys on `appInstId`. Decode the
    # input payload now to extract that ID, then pull app-manager + downstream
    # service logs scoped to it. This is the join that makes RCA accurate for
    # publish/start failures. See docs/app-publish-start-troubleshooting.md.
    early_app_inst_id = None
    if events_list:
        _start = next((e for e in events_list if e.get("eventType") == "EVENT_TYPE_WORKFLOW_EXECUTION_STARTED"), None)
        if _start:
            _attrs = next((_start[k] for k in _start if k.endswith("EventAttributes")), {}) or {}
            for _entry in (_decode_payloads((_attrs.get("input") or {}).get("payloads") or []) or []):
                _d = _entry.get("data") or {}
                if not isinstance(_d, dict):
                    continue
                _inst = _d.get("AppInst") or _d.get("DeployInst") or {}
                if _inst.get("id"):
                    early_app_inst_id = _inst["id"]
                    break

    if early_app_inst_id and wf_failure_time:
        try:
            am_logs = _fetch_app_manager_logs(early_app_inst_id, wf_failure_time)
            logs.extend(am_logs)
        except Exception as e:
            log_fetch_error = (log_fetch_error or "") + f" app-manager-logs: {e}"

    if logs:
        log_context = _prepare_log_context(logs, failed_svc_host or workflow_id.strip())

    # AI analysis
    ai_analysis = None
    if analysis.get("status") == "FAILED":
        try:
            ai_analysis = _ai_root_cause(analysis, log_context)
        except Exception as e:
            ai_analysis = {"error": str(e)}

    return {
        "analysisSummary": {
            "status": analysis.get("status"),
            "failureMessage": (analysis.get("failureMessage") or "")[:300],
            "failureStepName": analysis.get("failureStepName"),
            "failureStepLabel": analysis.get("failureStepLabel"),
            "activityFailureCount": len(analysis.get("activityFailures") or []),
        },
        "aiAnalysis": ai_analysis,
        "_debug": {
            "failedService": failed_svc_host,
            "failureTime": failure_time,
            "logsFound": len(log_context.get("logs", [])) if log_context else 0,
            "logFetchError": log_fetch_error,
            "apiKeySet": _get_anthropic_key() is not None,
            "statusIsFailed": analysis.get("status") == "FAILED",
        },
    }


@router.get("/test-logs")
def test_service_logs(
    service_host: str = Query(..., description="e.g. jiffydrive"),
    failure_time: str = Query(..., description="UTC ISO timestamp from Temporal, e.g. 2024-12-15T05:00:00Z"),
    window: int = Query(5, description="±minutes"),
):
    """Debug endpoint — returns query params + sample logs so you can verify in OpenSearch."""
    clean_ts = re.sub(r'\.\d{7,9}Z$', 'Z', failure_time)
    ts_utc = datetime.fromisoformat(clean_ts.replace("Z", "+00:00"))
    ts_ist = ts_utc + timedelta(hours=5, minutes=30)
    start_utc = ts_utc - timedelta(minutes=window)
    end_utc   = ts_utc + timedelta(minutes=window)

    logs = _fetch_service_logs(service_host, failure_time, window_minutes=window)

    return {
        "query": {
            "service_host": service_host,
            "failure_time_utc": failure_time,
            "failure_time_ist": ts_ist.strftime("%Y-%m-%dT%H:%M:%S"),
            "search_range_utc": {
                "start": start_utc.strftime("%Y-%m-%dT%H:%M:%SZ"),
                "end":   end_utc.strftime("%Y-%m-%dT%H:%M:%SZ"),
            },
            "search_range_ist_display": {
                "start": (ts_ist - timedelta(minutes=window)).strftime("%Y-%m-%dT%H:%M:%S"),
                "end":   (ts_ist + timedelta(minutes=window)).strftime("%Y-%m-%dT%H:%M:%S"),
            },
            "pod_filter": f"*{service_host}*",
        },
        "totalHits": len(logs),
        "logs": [
            {
                "@timestamp": l.get("@timestamp"),
                "log_level": l.get("log_level") or "",
                "message": (l.get("message") or "")[:300],
                "log_logger": l.get("log_logger") or "",
                "traceId": l.get("traceId") or "",
                "pod_name": (l.get("kubernetes") or {}).get("pod_name") if isinstance(l.get("kubernetes"), dict) else None,
            }
            for l in logs[:10]
        ],
    }


@router.get("/download-logs-csv")
def download_logs_csv(
    workflow_id: str = Query(..., description="Temporal workflow ID"),
    window: int = Query(5, description="±minutes"),
    limit: int = Query(10, description="Number of logs to return"),
):
    """Investigate workflow, fetch service logs from OpenSearch, return as CSV."""
    # 1) Fetch Temporal history
    events_list = _fetch_workflow_events(workflow_id.strip())
    _decode_recursive(events_list)
    analysis = _analyse_events(events_list)

    # 2) Find failed service + time
    failed_svc_host, failure_time = None, None
    for af in (analysis.get("activityFailures") or []):
        svc = af.get("service")
        et  = af.get("eventTime")
        if svc and et:
            failed_svc_host = svc["host"]
            failure_time = et
            break
    if not failed_svc_host:
        for fp in (analysis.get("failedApiPaths") or []):
            if fp.get("service"):
                failed_svc_host = fp["service"]["host"]
                break
        if failed_svc_host:
            for evt in events_list:
                if evt.get("eventType") == "EVENT_TYPE_WORKFLOW_EXECUTION_FAILED":
                    failure_time = evt.get("eventTime")
                    break

    if not failed_svc_host or not failure_time:
        raise HTTPException(status_code=404, detail="Could not determine failed service or failure time from workflow")

    # 3) Compute ranges for display
    clean_ts = re.sub(r'\.\d{7,9}Z$', 'Z', failure_time)
    ts_utc = datetime.fromisoformat(clean_ts.replace("Z", "+00:00"))
    ts_ist = ts_utc + timedelta(hours=5, minutes=30)
    start_utc = ts_utc - timedelta(minutes=window)
    end_utc   = ts_utc + timedelta(minutes=window)

    # 4) Fetch logs
    logs = _fetch_service_logs(failed_svc_host, failure_time, window_minutes=window)

    # 5) Write CSV
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow([])
    writer.writerow([f"# Workflow: {workflow_id}"])
    writer.writerow([f"# Failed Service: {failed_svc_host}"])
    writer.writerow([f"# Failure Time (UTC): {failure_time}"])
    writer.writerow([f"# Failure Time (IST): {ts_ist.strftime('%Y-%m-%dT%H:%M:%S')}"])
    writer.writerow([f"# Search Range (UTC): {start_utc.strftime('%Y-%m-%dT%H:%M:%SZ')} to {end_utc.strftime('%Y-%m-%dT%H:%M:%SZ')}"])
    writer.writerow([f"# Search Range (IST): {(ts_ist - timedelta(minutes=window)).strftime('%Y-%m-%dT%H:%M:%S')} to {(ts_ist + timedelta(minutes=window)).strftime('%Y-%m-%dT%H:%M:%S')}"])
    writer.writerow([f"# Pod Filter: *{failed_svc_host}*"])
    writer.writerow([f"# Total Hits: {len(logs)}"])
    writer.writerow([])
    writer.writerow([
        "timestamp", "log_level", "pod_name", "container_name", "service_name",
        "log_logger", "process_thread_name", "traceId", "spanId",
        "tenantId", "appId", "message",
    ])
    for l in logs[:limit]:
        k8s = l.get("kubernetes", {}) if isinstance(l.get("kubernetes"), dict) else {}
        writer.writerow([
            l.get("@timestamp", ""),
            l.get("log_level") or "",
            k8s.get("pod_name", ""),
            k8s.get("container_name", ""),
            l.get("service_name") or "",
            l.get("log_logger") or "",
            l.get("process_thread_name") or "",
            l.get("traceId") or "",
            l.get("spanId") or "",
            l.get("tenantId") or "",
            l.get("appId") or "",
            (l.get("message") or "")[:2000],
        ])

    buf.seek(0)
    filename = f"logs_{workflow_id}_{failed_svc_host}.csv"
    return StreamingResponse(
        buf,
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ── Workflow counts (Temporal-backed totals for Tenant & Apps page) ─────────

# Temporal CountWorkflowExecutions ExecutionStatus values
_TEMPORAL_STATUSES = {
    "running":   "Running",
    "completed": "Completed",
    "failed":    "Failed",
    "canceled":  "Canceled",
    "terminated": "Terminated",
    "timed_out": "TimedOut",
}


def _ist_window_iso() -> tuple[str, str]:
    """Return (start_iso, end_iso) UTC for the current IST day."""
    from timewindow import ist_day_window
    s, e = ist_day_window()
    return s.strftime("%Y-%m-%dT%H:%M:%SZ"), e.strftime("%Y-%m-%dT%H:%M:%SZ")


def _list_sample_workflows(query: str, limit: int = 5) -> list[dict]:
    """List up to `limit` workflow executions matching the query and dump
    the attributes useful for figuring out tenant scoping.

    Returns a list of plain dicts. On any per-workflow extraction error we
    capture {_error: ...} for that workflow rather than aborting the whole
    probe — the goal is to see SOMETHING about every workflow.
    """
    def _safe(v):
        try:
            if hasattr(v, "isoformat"):
                return v.isoformat()
            if hasattr(v, "name"):  # enums
                return v.name
            return v
        except Exception:
            return repr(v)

    def _search_attrs_dict(wf):
        sa = getattr(wf, "search_attributes", None)
        if sa is None:
            return {}
        try:
            return {k: list(v) for k, v in sa.items()}
        except Exception as e:
            return {"_error": f"{type(e).__name__}: {e}"}

    def _memo_dict(wf):
        # `memo` is a property; on this SDK version it can raise if decoding
        # fails. Use the raw memo fields directly to avoid the decode path.
        try:
            raw = wf.raw_info.memo.fields if getattr(wf, "raw_info", None) and getattr(wf.raw_info, "memo", None) else {}
            return {k: "<encoded>" for k in raw.keys()}
        except Exception as e:
            return {"_error": f"{type(e).__name__}: {e}"}

    async def _run() -> list[dict]:
        client = await TemporalClient.connect(
            _temporal_target(), namespace=_temporal_namespace()
        )
        out: list[dict] = []
        async for wf in client.list_workflows(query=query, limit=limit):
            try:
                row = {
                    "workflow_id":   getattr(wf, "id", None),
                    "run_id":        getattr(wf, "run_id", None),
                    "workflow_type": getattr(wf, "workflow_type", None),
                    "task_queue":    getattr(wf, "task_queue", None),
                    "status":        _safe(getattr(wf, "status", None)),
                    "start_time":    _safe(getattr(wf, "start_time", None)),
                    "close_time":    _safe(getattr(wf, "close_time", None)),
                    "history_length": getattr(wf, "history_length", None),
                    "search_attribute_keys": list(_search_attrs_dict(wf).keys()),
                    "memo_keys":     list(_memo_dict(wf).keys()),
                }
            except Exception as e:
                row = {"_error": f"{type(e).__name__}: {e}", "raw_repr": repr(wf)[:500]}
            out.append(row)
            if len(out) >= limit:
                break
        return out
    try:
        return asyncio.run(_run())
    except Exception as e:
        return [{"_error": f"{type(e).__name__}: {e}"}]


@router.get("/probe-workflows")
def probe_workflows(
    tenant_name: str = Query(..., description="Tenant name to investigate"),
    limit: int = Query(5, ge=1, le=20),
):
    """Diagnostic: list a few sample workflows from Temporal that ran during the
    current IST day, plus the inst_ids/app_names we know for this tenant. Used
    to figure out which Temporal attribute scopes workflows to a tenant.

    Call once from the deployed pod (where Temporal is reachable) and inspect
    the output to see what task_queue / workflow_type / search_attributes
    Jiffy uses — that tells us the right query for /workflow-counts.
    """
    db = get_db()
    apps = list(db["app_insights"].aggregate([
        {"$match": {"tenant_name": tenant_name}},
        {"$sort":  {"analyzed_at": -1}},
        {"$group": {
            "_id":       {"app_name": "$app_name", "inst_id": "$inst_id"},
            "authority": {"$first": "$authority"},
            "environment": {"$first": "$environment"},
        }},
    ]))
    known_apps = [
        {
            "app_name":    a["_id"].get("app_name"),
            "inst_id":     a["_id"].get("inst_id"),
            "authority":   a.get("authority"),
            "environment": a.get("environment"),
        }
        for a in apps
    ]

    start_iso, end_iso = _ist_window_iso()
    samples = _list_sample_workflows(
        f"StartTime BETWEEN '{start_iso}' AND '{end_iso}'",
        limit=limit,
    )
    return {
        "tenant_name":    tenant_name,
        "ist_window":     {"start": start_iso, "end": end_iso},
        "namespace":      _temporal_namespace(),
        "known_apps":     known_apps,
        "sample_workflows": samples,
    }


def _opensearch_workflow_counts(inst_ids: list[str], start_iso: str, end_iso: str) -> dict:
    """Workflow totals for one tenant during the IST window.

    `total` comes from OpenSearch correlationId cardinality (Temporal has
    no tenant scoping in this namespace, so we correlate via the appId
    field on platform logs). `failed` is the unique-workflow-id count
    summed across `failed_workflows` arrays in Lambda's `app_insights`
    docs, matching the per-app drilldown.

    Running is always 0 (logs don't tell us which workflows are still
    in flight); completed = total - failed.
    """
    if not inst_ids:
        return {"total": 0, "failed": 0, "completed": 0, "running": 0}

    client = _os_client()
    total_q = {
        "size": 0,
        "query": {
            "bool": {
                "must": [
                    {"range": {"@timestamp": {"gte": start_iso, "lte": end_iso}}},
                    {"terms": {"appId.keyword": inst_ids}},
                    {"exists": {"field": "correlationId"}},
                ]
            }
        },
        "aggs": {
            "wf_count": {
                "cardinality": {
                    "field": "correlationId.keyword",
                    "precision_threshold": 40000,
                }
            }
        },
    }
    try:
        total_resp = client.search(index="platform-*", body=total_q)
        total = int(total_resp.get("aggregations", {}).get("wf_count", {}).get("value", 0) or 0)
    except Exception as e:
        return {"total": 0, "failed": 0, "completed": 0, "running": 0,
                "_error": f"{type(e).__name__}: {e}"}

    failed_per_inst = _failed_counts_from_lambda_per_appid(inst_ids, start_iso)
    failed = sum(failed_per_inst.values())
    completed = max(0, total - failed)
    return {"total": total, "failed": failed, "completed": completed, "running": 0}


# In-process cache so the Tenant & Apps page (which fans out to one count
# per tenant) doesn't hammer OpenSearch on every reload.
_COUNTS_CACHE: dict[str, tuple[float, dict]] = {}
_COUNTS_TTL = 30.0  # seconds


def _cached_tenant_workflow_counts(tenant_name: str) -> dict:
    """OpenSearch-backed workflow counts for one tenant during the current
    IST day, cached for `_COUNTS_TTL` seconds."""
    import time as _time
    db = get_db()
    inst_ids = [
        i for i in db["app_insights"].distinct("inst_id", {"tenant_name": tenant_name})
        if i
    ]
    start_iso, end_iso = _ist_window_iso()
    cache_key = f"{tenant_name}|{start_iso}|{end_iso}|{','.join(sorted(inst_ids))}"
    now = _time.time()
    cached = _COUNTS_CACHE.get(cache_key)
    if cached and (now - cached[0]) < _COUNTS_TTL:
        return cached[1]
    counts = _opensearch_workflow_counts(inst_ids, start_iso, end_iso)
    payload = {
        "tenant_name": tenant_name,
        "ist_window":  {"start": start_iso, "end": end_iso},
        "inst_ids":    inst_ids,
        **counts,
        "source": "opensearch:correlationId-cardinality",
    }
    _COUNTS_CACHE[cache_key] = (now, payload)
    return payload


@router.get("/workflow-counts/{tenant_name}")
def workflow_counts(tenant_name: str):
    """OpenSearch-backed workflow counts for one tenant during the current
    IST day. Returns total/completed/failed/running plus the inst_ids that
    were scoped against."""
    return _cached_tenant_workflow_counts(tenant_name)


def _failed_counts_from_lambda_per_appid(
    inst_ids: list[str], start_iso: str,
) -> dict[str, int]:
    """Count unique failed workflow IDs per inst_id since `start_iso`,
    using the `workflow_executions` collection Lambda populates.

    Why `workflow_executions` and not `app_insights.failed_workflows`:
    `workflow_executions` is the same source the per-app drilldown reads
    (`/api/insights/{tenant}/apps/{app}/executions`) and includes UUID-style
    workflow IDs that the path-message-based `failed_workflows` field
    misses. Matching this source guarantees the Tenant & Apps "Failed"
    column equals the drilldown's "Failed" count.

    Performance: previously this fetched every doc's full `executions` array
    over the wire and filtered in Python — for high-volume tenants the array
    grows to thousands of entries across Lambda runs and the round-trip alone
    was the dominant cost of the Tenant & Apps page (~500 s in profiling).
    This rewrite pushes the filter, de-dup, and count entirely into Mongo
    via $unwind + $group; only the per-inst_id integers cross the wire.
    """
    if not inst_ids:
        return {}
    db = get_db()
    out: dict[str, int] = {iid: 0 for iid in inst_ids}
    pipeline = [
        {"$match": {"inst_id": {"$in": inst_ids}}},
        {"$unwind": "$executions"},
        {"$match": {
            # Mongo's $regex is case-insensitive so we catch "FAILED",
            # "failed", "Failed" without filtering in Python.
            "executions.status":     {"$regex": r"^failed$", "$options": "i"},
            "executions.start_time": {"$gte": start_iso},
        }},
        # Dedupe by (inst_id, workflow_id) — a single workflow can appear in
        # multiple Lambda runs' merged executions array.
        {"$group": {
            "_id": {
                "inst_id": "$inst_id",
                "wf_id":   {"$ifNull": ["$executions.workflow_id", "$executions.workflowId"]},
            },
        }},
        {"$group": {
            "_id":   "$_id.inst_id",
            "count": {"$sum": 1},
        }},
    ]
    try:
        for d in db["workflow_executions"].aggregate(pipeline, allowDiskUse=True):
            iid = d.get("_id")
            if iid in out:
                out[iid] = int(d.get("count") or 0)
    except Exception as e:
        # Fall back to zeros if the aggregation pipeline ever fails — better
        # than letting the whole /summary 500.
        import sys
        print(f"  _failed_counts_from_lambda_per_appid pipeline error: {e!r}",
              file=sys.stderr, flush=True)
    return out


def _opensearch_workflow_counts_per_appid(
    inst_ids: list[str], start_iso: str, end_iso: str,
) -> dict[str, dict]:
    """Returns {inst_id: {total, failed, completed}} for every inst_id with
    workflow activity in the window.

    `total` is summed from `app_insights.metrics.workflow_total` written by
    the Lambda batch every 30 minutes. Lambda windows do not overlap, so a
    `$sum` across all matching docs is exact (no de-duplication needed) for
    any aggregating window (Last 1 hour, Today, custom).
    `failed` comes from `_failed_counts_from_lambda_per_appid` (Mongo too).
    `completed` is `total - failed`, clamped to zero.

    Old name kept so every caller keeps working. The "opensearch_" prefix is
    now historical — this function no longer hits OpenSearch on the request
    path; pre-computation moved into the Lambda. See `_fetch_workflow_total`
    in Lambda/log_analysis.py.
    """
    if not inst_ids:
        print(f"    └ workflow_counts: no inst_ids → empty result", flush=True)
        return {}

    out: dict[str, dict] = {i: {"total": 0, "failed": 0, "completed": 0} for i in inst_ids}
    db = get_db()

    # Sum per-run workflow_total across docs analysed in [start_iso, end_iso].
    # Missing field ($sum of None) returns 0, so old docs that pre-date the
    # field contribute 0 — they get replaced on the next Lambda run.
    import time as _t
    t0 = _t.perf_counter()
    nonzero_groups = 0
    grand_total = 0
    try:
        for d in db["app_insights"].aggregate([
            {"$match": {
                "inst_id":     {"$in": inst_ids},
                "analyzed_at": {"$gte": start_iso, "$lte": end_iso},
            }},
            {"$group": {
                "_id":   "$inst_id",
                "total": {"$sum": "$metrics.workflow_total"},
            }},
        ]):
            iid = d["_id"]
            tot = int(d.get("total") or 0)
            if iid in out:
                out[iid]["total"] = tot
                if tot > 0:
                    nonzero_groups += 1
                    grand_total += tot
        print(
            f"    └ workflow_total $sum: scanned {len(inst_ids)} inst_ids, "
            f"{nonzero_groups} non-zero groups, grand total {grand_total} workflows "
            f"in {(_t.perf_counter()-t0)*1000:.0f} ms",
            flush=True,
        )
        # Top 5 inst_ids by total — handy for spotting which app is generating
        # most workflows in the window.
        top = sorted(out.items(), key=lambda kv: -kv[1]["total"])[:5]
        if any(t["total"] > 0 for _, t in top):
            preview = ", ".join(f"{iid[:8]}…={c['total']}" for iid, c in top if c["total"] > 0)
            print(f"      • top apps by workflow_total: {preview}", flush=True)
    except Exception as e:
        print(f"    └ workflow_total $sum FAILED: {e!r}", flush=True)

    t0 = _t.perf_counter()
    failed_per_inst = _failed_counts_from_lambda_per_appid(inst_ids, start_iso)
    total_failed = sum(failed_per_inst.values())
    print(
        f"    └ failed counts (Mongo workflow_executions): "
        f"{sum(1 for v in failed_per_inst.values() if v > 0)}/{len(inst_ids)} apps with failures, "
        f"{total_failed} total failed in {(_t.perf_counter()-t0)*1000:.0f} ms",
        flush=True,
    )
    for iid, fc in failed_per_inst.items():
        if iid in out:
            out[iid]["failed"] = fc
            out[iid]["completed"] = max(0, out[iid]["total"] - fc)
    return out


# Cache for the per-appId result (one entry, refreshed every TTL).
_PER_APP_CACHE: dict[str, tuple[float, dict]] = {}


def workflow_counts_per_appid(
    inst_ids: list[str],
    start_iso: str | None = None,
    end_iso: str | None = None,
) -> dict[str, dict]:
    """Cached `_opensearch_workflow_counts_per_appid` keyed by the window
    + sorted inst_id list. Defaults to today-in-IST when no window is given.
    Cache TTL is `_COUNTS_TTL` seconds."""
    import time as _time
    if start_iso is None or end_iso is None:
        s, e = _ist_window_iso()
        start_iso = start_iso or s
        end_iso = end_iso or e
    key = f"{start_iso}|{end_iso}|{','.join(sorted(inst_ids))}"
    now = _time.time()
    cached = _PER_APP_CACHE.get(key)
    if cached and (now - cached[0]) < _COUNTS_TTL:
        return cached[1]
    result = _opensearch_workflow_counts_per_appid(inst_ids, start_iso, end_iso)
    _PER_APP_CACHE[key] = (now, result)
    return result
