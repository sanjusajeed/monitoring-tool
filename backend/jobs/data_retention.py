"""
Nightly data retention jobs — delete old documents to keep MongoDB Atlas storage
under the free-tier limit.

  run_log_retention()         — app_insights, tenant_insights, workflow_executions
  run_api_monitor_retention() — api_monitor_cron_runs
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone, timedelta

from database import get_db

log = logging.getLogger(__name__)

SETTINGS_COLLECTION       = "monitoring_settings"
LOG_RETENTION_DOC_ID      = "data_retention"
API_MON_RETENTION_DOC_ID  = "api_monitor_retention"
DEFAULT_LOG_DAYS          = 14
DEFAULT_API_MON_DAYS      = 30


async def run_log_retention() -> dict:
    """Delete old app_insights, tenant_insights and workflow_executions entries."""
    db  = get_db()
    doc = db[SETTINGS_COLLECTION].find_one({"_id": LOG_RETENTION_DOC_ID}) or {}
    retention_days = int(doc.get("retention_days") or DEFAULT_LOG_DAYS)

    now    = datetime.now(timezone.utc)
    cutoff = (now - timedelta(days=retention_days)).isoformat()
    log.info("log_retention: cutoff=%s (keep last %d days)", cutoff, retention_days)

    # app_insights
    deleted_ai = 0
    try:
        r = db["app_insights"].delete_many({"analyzed_at": {"$lt": cutoff}})
        deleted_ai = r.deleted_count
        log.info("log_retention: app_insights deleted %d", deleted_ai)
    except Exception:
        log.exception("log_retention: app_insights delete failed")

    # tenant_insights
    deleted_ti = 0
    try:
        r = db["tenant_insights"].delete_many({"analyzed_at": {"$lt": cutoff}})
        deleted_ti = r.deleted_count
        log.info("log_retention: tenant_insights deleted %d", deleted_ti)
    except Exception:
        log.exception("log_retention: tenant_insights delete failed")

    # workflow_executions — server-side $pull (avoids large doc transfer)
    docs_trimmed = 0
    try:
        result = db["workflow_executions"].update_many(
            {"executions.start_time": {"$lt": cutoff}},
            {"$pull": {"executions": {"start_time": {"$lt": cutoff}}}},
        )
        docs_trimmed = result.modified_count
        log.info("log_retention: workflow_executions $pull modified %d docs", docs_trimmed)
    except Exception:
        log.exception("log_retention: workflow_executions trim failed")

    summary = {
        "ran_at":                    now.isoformat(),
        "retention_days":            retention_days,
        "deleted_app_insights":      deleted_ai,
        "deleted_tenant_insights":   deleted_ti,
        "trimmed_wf_docs":           docs_trimmed,
    }

    try:
        db[SETTINGS_COLLECTION].update_one(
            {"_id": LOG_RETENTION_DOC_ID},
            {"$set": {
                "last_run_at":                   now.isoformat(),
                "last_deleted_app_insights":     deleted_ai,
                "last_deleted_tenant_insights":  deleted_ti,
                "last_trimmed_wf_docs":          docs_trimmed,
            }},
            upsert=True,
        )
    except Exception:
        log.exception("log_retention: failed to persist stats")

    log.info("log_retention: done — %s", summary)
    return summary


async def run_api_monitor_retention() -> dict:
    """Delete old api_monitor_cron_runs entries."""
    db  = get_db()
    doc = db[SETTINGS_COLLECTION].find_one({"_id": API_MON_RETENTION_DOC_ID}) or {}
    retention_days = int(doc.get("retention_days") or DEFAULT_API_MON_DAYS)

    now    = datetime.now(timezone.utc)
    cutoff = (now - timedelta(days=retention_days)).isoformat()
    log.info("api_monitor_retention: cutoff=%s (keep last %d days)", cutoff, retention_days)

    deleted = 0
    try:
        r = db["api_monitor_cron_runs"].delete_many({"ran_at": {"$lt": cutoff}})
        deleted = r.deleted_count
        log.info("api_monitor_retention: deleted %d runs", deleted)
    except Exception:
        log.exception("api_monitor_retention: delete failed")

    summary = {
        "ran_at":           now.isoformat(),
        "retention_days":   retention_days,
        "deleted_runs":     deleted,
    }

    try:
        db[SETTINGS_COLLECTION].update_one(
            {"_id": API_MON_RETENTION_DOC_ID},
            {"$set": {
                "last_run_at":      now.isoformat(),
                "last_deleted_runs": deleted,
            }},
            upsert=True,
        )
    except Exception:
        log.exception("api_monitor_retention: failed to persist stats")

    log.info("api_monitor_retention: done — %s", summary)
    return summary


async def run_data_retention() -> dict:
    """Combined nightly job — runs both log and API monitor retention."""
    log_result = await run_log_retention()
    api_result = await run_api_monitor_retention()
    return {"log": log_result, "api_monitor": api_result}
