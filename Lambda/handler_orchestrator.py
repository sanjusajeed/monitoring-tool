"""
Orchestrator Lambda.

Fetches all tenants from Jiffy and async-invokes the per-tenant worker Lambda
once per tenant. Each worker invocation is fire-and-forget (InvocationType=Event),
so the orchestrator returns quickly even when fan-out is large.

Event shape (all fields optional):
  {
    "start":   "2026-04-17T01:00:00Z",
    "end":     "2026-04-17T02:00:00Z",
    "tenants": ["cfo", "rehlko"]     # restrict to a subset; omit for all
  }

Environment:
  WORKER_FUNCTION_NAME  — name or ARN of the worker Lambda (required).
"""
import json
import logging
import os
from datetime import datetime, timedelta, timezone

import boto3

# Force INFO on the root logger — see note in handler_worker.py.
logging.getLogger().setLevel(logging.INFO)

from log_analysis import _fetch_all_tenant_names, _get_jiffy_token, _load_config

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

_lambda = boto3.client("lambda")
WORKER = os.environ["WORKER_FUNCTION_NAME"]


def _default_window() -> tuple[str, str]:
    # Last 30 minutes, ending at "now" rounded down to the minute so the window
    # boundary is stable across all worker invocations the orchestrator fans out.
    end = datetime.now(timezone.utc).replace(second=0, microsecond=0)
    start = end - timedelta(minutes=30)
    fmt = "%Y-%m-%dT%H:%M:%SZ"
    return start.strftime(fmt), end.strftime(fmt)


def lambda_handler(event, context):
    event = event or {}
    start = event.get("start")
    end = event.get("end")
    if not start or not end:
        d_start, d_end = _default_window()
        start = start or d_start
        end = end or d_end

    subset = event.get("tenants")
    if subset and not isinstance(subset, list):
        raise ValueError("event.tenants must be a list of tenant names")

    cfg = _load_config()
    token = _get_jiffy_token(cfg["jiffy"])
    all_names = _fetch_all_tenant_names(cfg["jiffy"], token)
    names = [n for n in all_names if n in subset] if subset else all_names
    logger.info(f"Fanning out to {len(names)} tenant(s): {', '.join(names)}")

    invoked, failed = [], []
    for name in names:
        payload = {"tenant": name, "start": start, "end": end}
        try:
            _lambda.invoke(
                FunctionName=WORKER,
                InvocationType="Event",
                Payload=json.dumps(payload).encode("utf-8"),
            )
            invoked.append(name)
        except Exception as exc:
            logger.error(f"Failed to invoke worker for {name}: {exc}")
            failed.append({"tenant": name, "error": str(exc)})

    return {
        "window": {"start": start, "end": end},
        "invoked_count": len(invoked),
        "invoked": invoked,
        "failed": failed,
    }
