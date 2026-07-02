"""
Per-tenant analyzer Lambda.

Event shape:
  { "tenant": "cfo", "start": "2026-04-17T01:00:00Z", "end": "2026-04-17T02:00:00Z" }

If `start`/`end` are omitted, defaults to the last full hour (UTC).
Returns a small status object — the full analyzer output is persisted to
MongoDB `app_insights` / `workflow_executions`, so there is no need to return
it through the Lambda response.
"""
import logging
import os
from datetime import datetime, timedelta, timezone

# AWS Lambda's Python runtime attaches its own root-logger handler before our
# code runs, which makes `logging.basicConfig` a silent no-op. The runtime also
# leaves the root logger at WARNING on some versions, so `logger.info` output
# never reaches CloudWatch. Force INFO explicitly.
logging.getLogger().setLevel(logging.INFO)

from log_analysis import analyze_tenant_logs

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)


def _default_window() -> tuple[str, str]:
    end = datetime.now(timezone.utc).replace(second=0, microsecond=0)
    start = end - timedelta(minutes=30)
    fmt = "%Y-%m-%dT%H:%M:%SZ"
    return start.strftime(fmt), end.strftime(fmt)


def lambda_handler(event, context):
    tenant = (event or {}).get("tenant") or (event or {}).get("tenant_name")
    if not tenant:
        raise ValueError("event.tenant is required")

    start = (event or {}).get("start")
    end = (event or {}).get("end")
    if not start or not end:
        d_start, d_end = _default_window()
        start = start or d_start
        end = end or d_end

    # Prominent banner so the tenant is easy to spot in CloudWatch log streams
    # that mix output from many concurrent worker invocations.
    banner = "=" * 60
    logger.info(banner)
    logger.info(f"TENANT: {tenant}")
    logger.info(f"WINDOW: {start} → {end}")
    logger.info(banner)

    analyze_tenant_logs(tenant, {"start": start, "end": end})

    logger.info(f"TENANT: {tenant} — analyzer completed successfully")

    return {
        "status": "ok",
        "tenant": tenant,
        "window": {"start": start, "end": end},
    }
