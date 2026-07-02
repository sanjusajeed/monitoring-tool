"""
Crons — scheduled API Monitor collection runs with SMTP alerting.
"""
from datetime import datetime, timedelta, timezone

from bson import ObjectId
from bson.errors import InvalidId
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from database import get_db

router = APIRouter(prefix="/api/crons", tags=["crons"])

CRONS_COLL = "api_monitor_crons"
API_COLL   = "api_monitor_collections"
RUNS_COLL  = "api_monitor_cron_runs"


# ─── helpers ──────────────────────────────────────────────────────────────────

def _serialize(doc: dict) -> dict:
    out = dict(doc)
    out["id"] = str(out.pop("_id"))
    return out


_IST_OFFSET = timedelta(hours=5, minutes=30)


def _compute_next_run(schedule: dict, from_dt: datetime) -> datetime:
    """All HH:MM values in schedule are IST; from_dt and return value are UTC."""
    stype = schedule.get("type")

    if stype == "interval":
        mins         = int(schedule.get("interval_minutes") or 60)
        window_start = schedule.get("window_start")
        window_end   = schedule.get("window_end")
        next_dt      = from_dt + timedelta(minutes=mins)

        if window_start and window_end:
            # Delegate full window logic to the jobs module
            from jobs.api_monitor_cron import _in_window, _next_window_start
            if _in_window(next_dt, window_start, window_end):
                return next_dt
            return _next_window_start(next_dt, window_start)

        return next_dt

    # daily / weekly — time is IST
    time_str = schedule.get("time") or "00:00"
    try:
        hh, mm = map(int, time_str.split(":"))
    except Exception:
        hh, mm = 0, 0

    if stype == "daily":
        from_ist      = from_dt + _IST_OFFSET
        candidate_ist = from_ist.replace(hour=hh, minute=mm, second=0, microsecond=0)
        if candidate_ist <= from_ist:
            candidate_ist += timedelta(days=1)
        return candidate_ist - _IST_OFFSET

    if stype == "weekly":
        days     = schedule.get("days") or [0]
        from_ist = from_dt + _IST_OFFSET
        for offset in range(1, 8):
            cand_ist = from_ist + timedelta(days=offset)
            cand_ist = cand_ist.replace(hour=hh, minute=mm, second=0, microsecond=0)
            if cand_ist.weekday() in days and cand_ist > from_ist:
                return cand_ist - _IST_OFFSET
        return from_dt + timedelta(days=7)

    return from_dt + timedelta(hours=1)


# ─── Pydantic models ──────────────────────────────────────────────────────────

class CronJobIn(BaseModel):
    name:            str
    tenant:          str
    collection_id:   str
    api_filter:      list[str] | None = None
    schedule:        dict
    alert_emails:    list[str] = []
    alert_condition: str = "on_failure"  # "on_failure" | "always"
    enabled:         bool = True
    teams_enabled:      bool = False
    teams_webhook_id:   str | None = None
    sla_response_ms:    int | None = None
    sla_pass_rate_pct:  int | None = None


class CronJobPatch(BaseModel):
    name:            str | None = None
    api_filter:      list[str] | None = None
    schedule:        dict | None = None
    alert_emails:    list[str] | None = None
    alert_condition: str | None = None
    enabled:         bool | None = None
    teams_enabled:   bool | None = None
    teams_webhook_id: str | None = None
    sla_response_ms:   int | None = None
    sla_pass_rate_pct: int | None = None


# ─── endpoints ────────────────────────────────────────────────────────────────

@router.get("")
def list_crons(tenant: str | None = None):
    db     = get_db()
    query  = {"tenant": tenant} if tenant else {}
    docs   = list(db[CRONS_COLL].find(query).sort("created_at", -1))
    return {"crons": [_serialize(d) for d in docs]}


@router.get("/collections")
def list_collections_for_crons(tenant: str | None = None):
    """Return collections with flattened request names for the modal picker."""
    db    = get_db()
    query = {"tenant": tenant} if tenant else {}
    docs  = list(db[API_COLL].find(query).sort("name", 1))

    def _extract(items, prefix=""):
        reqs = []
        for item in items:
            name = (prefix + " / " if prefix else "") + item.get("name", "Unnamed")
            if "item" in item:
                reqs.extend(_extract(item["item"], name))
            elif "request" in item:
                reqs.append(name)
        return reqs

    result = []
    for d in docs:
        requests = _extract(d.get("collection", {}).get("item", []))
        result.append({
            "id":       str(d["_id"]),
            "name":     d.get("name", ""),
            "tenant":   d.get("tenant", ""),
            "requests": requests,
        })
    return {"collections": result}


@router.post("", status_code=201)
def create_cron(payload: CronJobIn):
    db = get_db()

    # Verify collection exists
    try:
        col_oid = ObjectId(payload.collection_id)
    except InvalidId:
        raise HTTPException(400, "Invalid collection_id")
    col_doc = db[API_COLL].find_one({"_id": col_oid})
    if not col_doc:
        raise HTTPException(404, "Collection not found")

    now = datetime.now(timezone.utc)
    next_run = _compute_next_run(payload.schedule, now)

    doc = {
        "name":            payload.name.strip(),
        "tenant":          payload.tenant,
        "collection_id":   payload.collection_id,
        "collection_name": col_doc.get("name", ""),
        "api_filter":      payload.api_filter,
        "schedule":        payload.schedule,
        "alert_emails":    payload.alert_emails,
        "alert_condition": payload.alert_condition,
        "enabled":         payload.enabled,
        "teams_enabled":   payload.teams_enabled,
        "teams_webhook_id": payload.teams_webhook_id if payload.teams_enabled else None,
        "sla_response_ms":  payload.sla_response_ms,
        "sla_pass_rate_pct": payload.sla_pass_rate_pct,
        "created_at":      now.isoformat(),
        "last_run_at":     None,
        "last_results":    None,
        "next_run_at":     next_run.isoformat(),
    }
    res = db[CRONS_COLL].insert_one(doc)
    doc["_id"] = res.inserted_id
    return _serialize(doc)


@router.patch("/{cron_id}")
def update_cron(cron_id: str, payload: CronJobPatch):
    try:
        oid = ObjectId(cron_id)
    except InvalidId:
        raise HTTPException(400, "Invalid cron id")

    db  = get_db()
    doc = db[CRONS_COLL].find_one({"_id": oid})
    if not doc:
        raise HTTPException(404, "Cron not found")

    updates: dict = {}
    if payload.name is not None:
        updates["name"] = payload.name.strip()
    if payload.api_filter is not None:
        updates["api_filter"] = payload.api_filter
    if payload.alert_emails is not None:
        updates["alert_emails"] = payload.alert_emails
    if payload.alert_condition is not None:
        updates["alert_condition"] = payload.alert_condition
    if payload.enabled is not None:
        updates["enabled"] = payload.enabled
    if payload.teams_enabled is not None:
        updates["teams_enabled"]    = payload.teams_enabled
        updates["teams_webhook_id"] = payload.teams_webhook_id if payload.teams_enabled else None
    if payload.sla_response_ms is not None:
        updates["sla_response_ms"] = payload.sla_response_ms
    if payload.sla_pass_rate_pct is not None:
        updates["sla_pass_rate_pct"] = payload.sla_pass_rate_pct
    if payload.schedule is not None:
        updates["schedule"] = payload.schedule
        now = datetime.now(timezone.utc)
        updates["next_run_at"] = _compute_next_run(payload.schedule, now).isoformat()

    if updates:
        db[CRONS_COLL].update_one({"_id": oid}, {"$set": updates})

    updated = db[CRONS_COLL].find_one({"_id": oid})
    return _serialize(updated)


@router.delete("/{cron_id}")
def delete_cron(cron_id: str):
    try:
        oid = ObjectId(cron_id)
    except InvalidId:
        raise HTTPException(400, "Invalid cron id")
    res = get_db()[CRONS_COLL].delete_one({"_id": oid})
    if res.deleted_count == 0:
        raise HTTPException(404, "Cron not found")
    return {"ok": True}


@router.get("/{cron_id}/runs")
def get_cron_runs(cron_id: str, limit: int = 20):
    """Return the last N run records for a cron job."""
    db   = get_db()
    docs = list(
        db[RUNS_COLL]
        .find({"cron_id": cron_id})
        .sort("ran_at", -1)
        .limit(limit)
    )
    for d in docs:
        d["id"] = str(d.pop("_id"))
    return {"runs": docs}


@router.post("/{cron_id}/run-now")
def run_cron_now(cron_id: str):
    """Force an immediate run outside the scheduler."""
    import subprocess
    from jobs.api_monitor_cron import _run_one_cron
    try:
        oid = ObjectId(cron_id)
    except InvalidId:
        raise HTTPException(400, "Invalid cron id")

    db  = get_db()
    doc = db[CRONS_COLL].find_one({"_id": oid})
    if not doc:
        raise HTTPException(404, "Cron not found")

    try:
        summary = _run_one_cron(doc, db)
    except subprocess.TimeoutExpired:
        raise HTTPException(504, "Newman run timed out")
    except Exception as exc:
        raise HTTPException(500, f"Run failed: {exc}")

    return summary
