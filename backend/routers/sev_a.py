"""
Sev A alert rules — identical schema and logic to alert_rules, but stored
in the `sev_a_rules` collection so the two sets are fully independent.
"""
import re
from datetime import datetime, timezone
from typing import Literal

from bson import ObjectId
from bson.errors import InvalidId
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, field_validator

from database import get_db

router = APIRouter(prefix="/api/sev-a", tags=["sev-a"])

COLLECTION = "sev_a_rules"

ALLOWED_CONDITION_KEYS = {"workflow_failed"}
ALLOWED_ENVS = {"prod", "uat", "qa", "dev", "develop", "stage", "demo"}


class Condition(BaseModel):
    key:       Literal["workflow_failed"]
    label:     str = Field(..., min_length=1, max_length=120)
    unit:      Literal["count", "percent"]
    threshold: float = Field(..., ge=0)


_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class SevARuleIn(BaseModel):
    tenant:         str        = Field(..., min_length=1, max_length=120)
    envs:           list[str]  = Field(..., min_length=1, max_length=10)
    conditions:     list[Condition] = Field(..., min_length=1, max_length=8)
    window_minutes: int        = Field(..., ge=1, le=24 * 60)
    workflow_names: list[str]  = Field(default_factory=list, max_length=50,
                                       description="Optional: only fire when one of these process names fails")
    extra_emails:   list[str]  = Field(default_factory=list, max_length=5)
    created_by:     str | None = Field(None, max_length=200)
    teams_enabled:      bool       = False
    teams_webhook_id:   str | None = None

    @field_validator("extra_emails")
    @classmethod
    def _validate_emails(cls, v: list[str]) -> list[str]:
        cleaned = [e.strip() for e in v if e and e.strip()]
        bad = [e for e in cleaned if not _EMAIL_RE.match(e)]
        if bad:
            raise ValueError(f"Invalid email address(es): {bad}")
        seen = set()
        out = []
        for e in cleaned:
            if e.lower() not in seen:
                seen.add(e.lower())
                out.append(e)
        return out


def _ensure_indexes(db) -> None:
    db[COLLECTION].create_index([("tenant", 1), ("envs", 1)])
    db[COLLECTION].create_index([("created_at", -1)])


def _serialize(doc: dict) -> dict:
    out = dict(doc)
    out["id"] = str(out.pop("_id"))
    return out


@router.get("/rules")
def list_rules(
    tenant: str | None = None,
    env:    str | None = None,
):
    db = get_db()
    _ensure_indexes(db)
    q: dict = {}
    if tenant: q["tenant"] = tenant
    if env:    q["envs"]   = env
    docs = list(db[COLLECTION].find(q).sort("created_at", -1))
    return {"rules": [_serialize(d) for d in docs], "count": len(docs)}


@router.post("/rules", status_code=201)
def create_rule(payload: SevARuleIn):
    bad_envs = [e for e in payload.envs if e not in ALLOWED_ENVS]
    if bad_envs:
        raise HTTPException(400, f"envs must be one of {sorted(ALLOWED_ENVS)}; got bad: {bad_envs}")
    bad = [c.key for c in payload.conditions if c.key not in ALLOWED_CONDITION_KEYS]
    if bad:
        raise HTTPException(400, f"Unknown condition keys: {bad}")

    db = get_db()
    _ensure_indexes(db)
    doc = {
        "tenant":            payload.tenant,
        "envs":              list(dict.fromkeys(payload.envs)),
        "conditions":        [c.model_dump() for c in payload.conditions],
        "window_minutes":    payload.window_minutes,
        "workflow_names":    list(dict.fromkeys(payload.workflow_names)),
        "extra_emails":      payload.extra_emails,
        "teams_enabled":     payload.teams_enabled,
        "teams_webhook_id":  payload.teams_webhook_id if payload.teams_enabled else None,
        "state":             {},
        "last_evaluated_at": None,
        "created_at":        datetime.now(timezone.utc).isoformat(),
        "created_by":        payload.created_by,
    }
    res = db[COLLECTION].insert_one(doc)
    doc["_id"] = res.inserted_id
    return _serialize(doc)


@router.delete("/rules/{rule_id}")
def delete_rule(rule_id: str):
    try:
        oid = ObjectId(rule_id)
    except InvalidId:
        raise HTTPException(400, "Invalid rule id")
    res = get_db()[COLLECTION].delete_one({"_id": oid})
    if res.deleted_count == 0:
        raise HTTPException(404, "Rule not found")
    return {"ok": True, "id": rule_id}


@router.get("/tenants/{tenant}/workflows")
def list_tenant_workflows(tenant: str):
    """Return distinct process names from failed workflow executions for a tenant.
    Used to populate the workflow selector in the Sev A rule modal."""
    db = get_db()
    pipeline = [
        {"$match": {"tenant_name": tenant}},
        {"$unwind": "$executions"},
        {"$match": {"executions.status": {"$regex": r"^failed$", "$options": "i"}}},
        {"$group": {
            "_id":      {"$ifNull": ["$executions.process_name", "$executions.workflow_name"]},
            "app_name": {"$first": "$app_display_name"},
        }},
        {"$match": {"_id": {"$nin": [None, ""]}}},
        {"$sort": {"_id": 1}},
    ]
    workflows = []
    for doc in db["workflow_executions"].aggregate(pipeline, allowDiskUse=True):
        name = doc.get("_id")
        if name and str(name).strip():
            workflows.append({"name": str(name), "app": doc.get("app_name") or ""})
    return {"workflows": workflows, "count": len(workflows)}


@router.post("/evaluate-now")
def evaluate_now():
    """Force a synchronous evaluation of all Sev A rules."""
    from jobs.alert_evaluator import evaluate_all_rules
    summary = evaluate_all_rules(collection=COLLECTION)
    return summary


@router.post("/rules/{rule_id}/test-email")
def send_test_email(rule_id: str):
    """Send a test Sev A email for a rule regardless of whether conditions are met.
    Uses real failures within the rule's window_minutes, filtered by workflow_names."""
    from datetime import timedelta
    from email.message import EmailMessage
    from jobs.alert_evaluator import _fetch_day_failures, _build_sev_a_html_body, _build_sev_a_plain_body
    from routers.support import load_smtp_config, send_via_smtp

    try:
        oid = ObjectId(rule_id)
    except InvalidId:
        raise HTTPException(400, "Invalid rule id")

    db = get_db()
    rule = db[COLLECTION].find_one({"_id": oid})
    if not rule:
        raise HTTPException(404, "Rule not found")

    smtp_doc = load_smtp_config()
    if not smtp_doc or not smtp_doc.get("smtp_host") or not smtp_doc.get("to_email"):
        raise HTTPException(400, "SMTP is not configured — go to Settings to configure it")

    tenant         = rule.get("tenant")
    envs           = rule.get("envs") or []
    window_minutes = int(rule.get("window_minutes") or 60)
    workflow_names = rule.get("workflow_names") or []

    window_start_iso = (datetime.now(timezone.utc) - timedelta(minutes=window_minutes)).isoformat()
    day_execs = _fetch_day_failures(db, tenant, envs, workflow_names=workflow_names or None,
                                    since_iso=window_start_iso)

    envs_str = ", ".join(envs)
    total = len(day_execs)
    noun  = "failure" if total == 1 else "failures"
    subject = f"[TEST] [Sev A] {tenant} / {envs_str}: {total} workflow {noun} detected"

    from urllib.parse import quote
    dashboard_url = (smtp_doc.get("dashboard_url") or "https://apm.jiffy.ai").rstrip("/")
    first_env = envs[0] if envs else ""
    deep_link = (
        f"{dashboard_url}/?page=tenant-apps"
        f"&tenant={quote(tenant or '')}"
        + (f"&env={quote(first_env)}" if first_env else "")
    )

    skyline_url = f"{dashboard_url}/static/skyline-bg.jpg"
    plain = _build_sev_a_plain_body(tenant, envs, day_execs, deep_link=deep_link)
    html  = _build_sev_a_html_body(tenant, envs, day_execs, deep_link=deep_link, skyline_url=skyline_url)

    recipients = [smtp_doc["to_email"]] + list(rule.get("extra_emails") or [])
    seen: set[str] = set()
    deduped = [r for r in recipients if r and r.lower() not in seen and not seen.add(r.lower())]  # type: ignore[func-returns-value]

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"]    = smtp_doc["from_email"]
    msg["To"]      = ", ".join(deduped)
    msg.set_content(plain)
    msg.add_alternative(html, subtype="html")

    try:
        send_via_smtp(msg, smtp_doc)
    except Exception as e:
        raise HTTPException(502, f"SMTP send failed: {e}")

    return {"ok": True, "subject": subject, "recipients": deduped}
