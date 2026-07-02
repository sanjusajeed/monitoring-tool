"""
User-tunable settings for monitoring features.

Mirrors the single-doc pattern used by [support.py](backend/routers/support.py):
one Mongo collection (`monitoring_settings`), one doc per feature, identified by
`_id`. Each feature has its own GET/PUT pair.

Currently only the large-workflow detector is configurable here. The Mongo doc
also tracks the detector's `last_run_at` + `last_match_count` so the Settings
UI can show "last scan ran ... · found N oversized workflows".
"""
from fastapi import APIRouter
from pydantic import BaseModel, Field

from database import get_db

router = APIRouter(prefix="/api/settings", tags=["settings"])

COLLECTION  = "monitoring_settings"
DETECTOR_ID = "large_workflow_detector"

# Bounds tight enough to prevent foot-guns. Interval lower bound matches the
# K8s CronJob schedule (every 5 min), which is the smallest cadence the
# detector script can actually honour.
MIN_THRESHOLD_BYTES =         1_000_000   #   1 MB
MAX_THRESHOLD_BYTES = 1_000_000_000        #   1 GB
MIN_INTERVAL_MIN    = 5
MAX_INTERVAL_MIN    = 360                   #  6 hours

DEFAULT_THRESHOLD_BYTES  = 30_000_000      # 30 MB
DEFAULT_INTERVAL_MIN     = 30


class LargeWorkflowDetectorSettings(BaseModel):
    threshold_bytes:  int = Field(..., ge=MIN_THRESHOLD_BYTES, le=MAX_THRESHOLD_BYTES,
                                  description="History size threshold in bytes")
    interval_minutes: int = Field(..., ge=MIN_INTERVAL_MIN,    le=MAX_INTERVAL_MIN,
                                  description="Scan cadence in minutes")


@router.get("/large-workflow-detector")
def get_large_workflow_detector_settings():
    doc = get_db()[COLLECTION].find_one({"_id": DETECTOR_ID}) or {}
    return {
        "threshold_bytes":  int(doc.get("threshold_bytes")  or DEFAULT_THRESHOLD_BYTES),
        "interval_minutes": int(doc.get("interval_minutes") or DEFAULT_INTERVAL_MIN),
        "last_run_at":      doc.get("last_run_at"),
        "last_match_count": doc.get("last_match_count"),
        # Surface bounds so the UI can validate / clamp.
        "limits": {
            "threshold_bytes":  {"min": MIN_THRESHOLD_BYTES, "max": MAX_THRESHOLD_BYTES},
            "interval_minutes": {"min": MIN_INTERVAL_MIN,    "max": MAX_INTERVAL_MIN},
        },
    }


@router.put("/large-workflow-detector")
def put_large_workflow_detector_settings(payload: LargeWorkflowDetectorSettings):
    get_db()[COLLECTION].update_one(
        {"_id": DETECTOR_ID},
        {"$set": {
            "threshold_bytes":  payload.threshold_bytes,
            "interval_minutes": payload.interval_minutes,
        }},
        upsert=True,
    )
    return {"ok": True, "threshold_bytes": payload.threshold_bytes,
            "interval_minutes": payload.interval_minutes}


@router.post("/large-workflow-detector/run-now")
async def run_large_workflow_detector_now():
    """Bypass the interval guard and run the detector immediately."""
    from jobs.large_workflow_detector import detect_large_workflows, SETTINGS_COLLECTION, SETTINGS_DOC_ID
    db = get_db()
    db[SETTINGS_COLLECTION].update_one(
        {"_id": SETTINGS_DOC_ID}, {"$unset": {"last_run_at": ""}}, upsert=True
    )
    result = await detect_large_workflows()
    return result


# ─── Data Retention ───────────────────────────────────────────────────────────

RETENTION_ID       = "data_retention"
DEFAULT_RET_DAYS   = 14
MIN_RET_DAYS       = 1
MAX_RET_DAYS       = 365


class DataRetentionSettings(BaseModel):
    retention_days: int = Field(
        ..., ge=MIN_RET_DAYS, le=MAX_RET_DAYS,
        description="Delete data older than this many days",
    )


@router.get("/retention")
def get_all_retention_settings():
    """Returns both log and API monitor retention settings in one round trip."""
    db   = get_db()
    docs = {d["_id"]: d for d in db[COLLECTION].find({"_id": {"$in": [RETENTION_ID, API_MON_RETENTION_ID]}})}
    log_doc = docs.get(RETENTION_ID, {})
    api_doc = docs.get(API_MON_RETENTION_ID, {})
    return {
        "log": {
            "retention_days":                int(log_doc.get("retention_days") or DEFAULT_RET_DAYS),
            "last_run_at":                   log_doc.get("last_run_at"),
            "last_deleted_app_insights":     log_doc.get("last_deleted_app_insights"),
            "last_deleted_tenant_insights":  log_doc.get("last_deleted_tenant_insights"),
            "last_trimmed_wf_docs":          log_doc.get("last_trimmed_wf_docs"),
            "limits": {"retention_days": {"min": MIN_RET_DAYS, "max": MAX_RET_DAYS}},
        },
        "api_monitor": {
            "retention_days":    int(api_doc.get("retention_days") or DEFAULT_API_MON_DAYS),
            "last_run_at":       api_doc.get("last_run_at"),
            "last_deleted_runs": api_doc.get("last_deleted_runs"),
            "limits": {"retention_days": {"min": MIN_API_MON_DAYS, "max": MAX_API_MON_DAYS}},
        },
    }


@router.get("/data-retention")
def get_data_retention_settings():
    doc = get_db()[COLLECTION].find_one({"_id": RETENTION_ID}) or {}
    return {
        "retention_days": int(doc.get("retention_days") or DEFAULT_RET_DAYS),
        "last_run_at":                  doc.get("last_run_at"),
        "last_deleted_app_insights":    doc.get("last_deleted_app_insights"),
        "last_deleted_tenant_insights": doc.get("last_deleted_tenant_insights"),
        "last_trimmed_wf_docs":         doc.get("last_trimmed_wf_docs"),
        "limits": {"retention_days": {"min": MIN_RET_DAYS, "max": MAX_RET_DAYS}},
    }


@router.put("/data-retention")
def put_data_retention_settings(payload: DataRetentionSettings):
    get_db()[COLLECTION].update_one(
        {"_id": RETENTION_ID},
        {"$set": {"retention_days": payload.retention_days}},
        upsert=True,
    )
    return {"ok": True, "retention_days": payload.retention_days}


@router.post("/data-retention/run-now")
async def run_data_retention_now():
    """Run the log retention cleanup immediately."""
    from jobs.data_retention import run_log_retention
    return await run_log_retention()


# ─── API Monitor Retention ────────────────────────────────────────────────────

API_MON_RETENTION_ID   = "api_monitor_retention"
DEFAULT_API_MON_DAYS   = 30
MIN_API_MON_DAYS       = 1
MAX_API_MON_DAYS       = 365


class ApiMonitorRetentionSettings(BaseModel):
    retention_days: int = Field(
        ..., ge=MIN_API_MON_DAYS, le=MAX_API_MON_DAYS,
        description="Delete API Monitor run data older than this many days",
    )


@router.get("/api-monitor-retention")
def get_api_monitor_retention_settings():
    doc = get_db()[COLLECTION].find_one({"_id": API_MON_RETENTION_ID}) or {}
    return {
        "retention_days":    int(doc.get("retention_days") or DEFAULT_API_MON_DAYS),
        "last_run_at":       doc.get("last_run_at"),
        "last_deleted_runs": doc.get("last_deleted_runs"),
        "limits": {"retention_days": {"min": MIN_API_MON_DAYS, "max": MAX_API_MON_DAYS}},
    }


@router.put("/api-monitor-retention")
def put_api_monitor_retention_settings(payload: ApiMonitorRetentionSettings):
    get_db()[COLLECTION].update_one(
        {"_id": API_MON_RETENTION_ID},
        {"$set": {"retention_days": payload.retention_days}},
        upsert=True,
    )
    return {"ok": True, "retention_days": payload.retention_days}


@router.post("/api-monitor-retention/run-now")
async def run_api_monitor_retention_now():
    """Run the API Monitor retention cleanup immediately."""
    from jobs.data_retention import run_api_monitor_retention
    return await run_api_monitor_retention()
