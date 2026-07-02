"""
Periodic detector: find Temporal workflows whose history exceeded the size
threshold in the last interval window, look up the owning tenant + app from
their input headers, and write them to MongoDB.

Designed to be invoked by a K8s CronJob every 5 minutes; the script then
enforces the user-configured interval itself by checking `last_run_at` in
`monitoring_settings`. Settings are tunable from the in-app Settings page.

Reuses the existing Temporal gRPC client + payload helpers from
`backend/routers/temporal.py`, the Mongo singleton from `backend/database.py`,
and the `inst_id → tenant_name` pattern already used in `backend/routers/insights.py`.

Local run:
    cd backend
    python -m jobs.large_workflow_detector
"""
import asyncio
import json
import sys
from datetime import datetime, timedelta, timezone

from google.protobuf.json_format import MessageToDict
from temporalio.client import Client as TemporalClient
from temporalio.service import RPCError

from database import get_db
from routers.temporal import (
    _temporal_target,
    _temporal_namespace,
    _decode_payloads,
)

# Defaults — used only when no `monitoring_settings` doc exists yet.
DEFAULT_THRESHOLD_BYTES  = 30_000_000   # 30 MB
DEFAULT_INTERVAL_MINUTES = 30

SETTINGS_COLLECTION  = "monitoring_settings"
SETTINGS_DOC_ID      = "large_workflow_detector"
RESULTS_COLLECTION   = "large_file_workflows"


# ── helpers ──────────────────────────────────────────────────────────────────

def _ensure_indexes(db) -> None:
    """Idempotent. Same style as Lambda/log_analysis.py:2109-2114."""
    db[RESULTS_COLLECTION].create_index([("workflow_id", 1), ("run_id", 1)], unique=True)
    db[RESULTS_COLLECTION].create_index([("analyzed_at", -1)])
    db[RESULTS_COLLECTION].create_index([("tenant_name", 1), ("app_name", 1)])
    db[RESULTS_COLLECTION].create_index([("history_size_bytes", -1)])


def _load_settings(db) -> tuple[int, int, str | None]:
    """Returns (threshold_bytes, interval_minutes, last_run_at_iso)."""
    doc = db[SETTINGS_COLLECTION].find_one({"_id": SETTINGS_DOC_ID}) or {}
    return (
        int(doc.get("threshold_bytes")  or DEFAULT_THRESHOLD_BYTES),
        int(doc.get("interval_minutes") or DEFAULT_INTERVAL_MINUTES),
        doc.get("last_run_at"),
    )


def _stamp_run(db, end: datetime, matches: int) -> None:
    db[SETTINGS_COLLECTION].update_one(
        {"_id": SETTINGS_DOC_ID},
        {"$set": {"last_run_at": end.isoformat(), "last_match_count": matches}},
        upsert=True,
    )


def _build_inst_map(db) -> dict[str, tuple[str, str, str]]:
    """appId (inst_id) -> (tenant_name, app_name, environment).
    Same $group pattern used in backend/routers/insights.py.
    """
    out: dict[str, tuple[str, str, str]] = {}
    for d in db["app_insights"].aggregate([
        {"$group": {"_id": {
            "tenant":   "$tenant_name",
            "inst_id":  "$inst_id",
            "app_name": "$app_name",
            "env":      "$environment",
        }}}
    ]):
        k = d["_id"]
        iid = k.get("inst_id")
        if not iid:
            continue
        out[iid] = (k.get("tenant") or "", k.get("app_name") or "", k.get("env") or "")
    return out


async def _extract_owner(handle) -> tuple[str | None, str | None]:
    """Read the WorkflowExecutionStarted event's input payloads and return
    (tenant_id, app_id). These show up directly in the decoded payload OR
    nested under headers depending on how the workflow was started — handle
    both. Returns (None, None) if anything fails."""
    try:
        async for evt in handle.fetch_history_events():
            evt_dict = MessageToDict(evt, preserving_proto_field_name=False)
            attrs = (
                evt_dict.get("workflowExecutionStartedEventAttributes")
                or evt_dict.get("workflow_execution_started_event_attributes")
                or {}
            )
            inp = attrs.get("input") or {}
            payloads = inp.get("payloads") or []
            decoded = _decode_payloads(payloads) if payloads else []
            tenant_id = app_id = None
            for entry in decoded:
                data = entry.get("data")
                if not isinstance(data, dict):
                    continue
                tenant_id = tenant_id or data.get("tenantId") or data.get("targetTenantId")
                app_id    = app_id    or data.get("appId")    or data.get("targetAppId")
                # Some flows nest these under "headers" — check there too.
                headers = data.get("headers")
                if isinstance(headers, dict):
                    tenant_id = tenant_id or headers.get("tenantId")
                    app_id    = app_id    or headers.get("appId")
                if tenant_id and app_id:
                    break
            return tenant_id, app_id
    except (RPCError, RuntimeError, TimeoutError):
        pass
    return None, None


def _history_size_bytes(desc) -> int:
    """Read history_size_bytes from the raw DescribeWorkflowExecution response.
    Defensive: shapes vary slightly between temporalio SDK versions."""
    try:
        return int(desc.raw_description.workflow_execution_info.history_size_bytes or 0)
    except AttributeError:
        pass
    try:
        return int(getattr(desc, "history_size_bytes", 0) or 0)
    except Exception:
        return 0


# ── main entry ───────────────────────────────────────────────────────────────

async def detect_large_workflows() -> dict:
    db = get_db()
    _ensure_indexes(db)

    threshold, interval_min, last_run = _load_settings(db)
    end = datetime.now(timezone.utc).replace(second=0, microsecond=0)

    # Skip-if-too-recent guard. K8s CronJob fires every 5 min; this lets the
    # user's interval setting drive the real cadence without manual schedule
    # changes.
    if last_run:
        try:
            last_run_dt = datetime.fromisoformat(str(last_run).replace("Z", "+00:00"))
            if (end - last_run_dt) < timedelta(minutes=interval_min):
                return {
                    "skipped":          True,
                    "reason":           "interval not yet elapsed",
                    "last_run_at":      last_run,
                    "interval_minutes": interval_min,
                    "next_eligible_at": (last_run_dt + timedelta(minutes=interval_min)).isoformat(),
                }
        except ValueError:
            pass  # malformed timestamp — proceed as if no prior run

    start = end - timedelta(minutes=interval_min)
    # Temporal visibility query: workflows that closed (any status) in the window.
    query = f"CloseTime BETWEEN '{start.isoformat()}' AND '{end.isoformat()}'"

    print(f"[detector] window {start.isoformat()} -> {end.isoformat()}  threshold={threshold} bytes",
          flush=True)

    client = await TemporalClient.connect(_temporal_target(), namespace=_temporal_namespace())
    inst_map = _build_inst_map(db)
    print(f"[detector] inst_id map: {len(inst_map)} apps", flush=True)

    rows: list[dict] = []
    scanned = 0
    async for wf in client.list_workflows(query=query, limit=2000):
        scanned += 1
        try:
            handle = client.get_workflow_handle(wf.id, run_id=wf.run_id)
            desc   = await handle.describe()
        except (RPCError, RuntimeError, TimeoutError) as e:
            print(f"[detector] describe failed for {wf.id}: {e!r}", flush=True)
            continue

        size = _history_size_bytes(desc)
        if size < threshold:
            continue

        tenant_id, app_id = await _extract_owner(handle)
        ten, app, env = inst_map.get(app_id or "", (None, None, None))

        rows.append({
            "workflow_id":        wf.id,
            "run_id":             wf.run_id,
            "workflow_type":      getattr(wf, "workflow_type", None),
            "tenant_id":          tenant_id,
            "app_id":             app_id,
            "tenant_name":        ten,
            "app_name":           app,
            "environment":        env,
            "history_size_bytes": size,
            "history_length":     getattr(wf, "history_length", None),
            "status":             str(getattr(wf, "status", "")),
            "start_time":         wf.start_time.isoformat() if getattr(wf, "start_time", None) else None,
            "close_time":         wf.close_time.isoformat() if getattr(wf, "close_time", None) else None,
            "analyzed_at":        end.isoformat(),
        })
        print(f"[detector] match: {wf.id} size={size} tenant={ten or '?'} app={app or '?'}",
              flush=True)

    for r in rows:
        db[RESULTS_COLLECTION].update_one(
            {"workflow_id": r["workflow_id"], "run_id": r["run_id"]},
            {"$set": r},
            upsert=True,
        )

    _stamp_run(db, end, len(rows))
    return {
        "scanned_at":      end.isoformat(),
        "interval_min":    interval_min,
        "threshold_bytes": threshold,
        "scanned":         scanned,
        "matches":         len(rows),
    }


if __name__ == "__main__":
    result = asyncio.run(detect_large_workflows())
    print(json.dumps(result, indent=2))
    # Non-zero exit code on hard failure isn't necessary for now — the
    # CronJob restarts naturally on the next tick. But if we ever wanted
    # K8s backoff on failure, raise here.
    sys.exit(0)
