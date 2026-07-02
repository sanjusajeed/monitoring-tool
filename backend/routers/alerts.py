"""
Alert rules — user-defined conditions that, when matched, trigger an email.

Schema (one doc per rule in `alert_rules`):
    {
        _id:               ObjectId,
        tenant:            str,        # tenant_name
        envs:              [str],      # one or more env keys
        conditions: [
            { key: str, label: str, unit: 'count'|'percent', threshold: float },
        ],
        window_minutes:    int,        # rolling evaluation window
        extra_emails:      [str],      # additional recipients (besides shared SMTP to_email)
        state:             dict,       # system-maintained per-condition state — see jobs/alert_evaluator.py
        last_evaluated_at: ISO | None, # diagnostic
        created_at:        ISO,
        created_by:        str | None,
    }

The actual evaluation + email send happens in `backend/jobs/alert_evaluator.py`
on an APScheduler 30-min interval. The /evaluate-now endpoint here is for
manual testing.
"""
import json
import re
import urllib.request
from datetime import datetime, timezone, timedelta
from typing import Literal

from bson import ObjectId
from bson.errors import InvalidId
from fastapi import APIRouter, BackgroundTasks, Form, HTTPException
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field, field_validator

from database import get_db

router = APIRouter(prefix="/api/alerts", tags=["alerts"])

COLLECTION = "alert_rules"

ALLOWED_CONDITION_KEYS = {"workflow_failed", "error_5xx", "error_4xx", "error_rate"}
ALLOWED_ENVS = {"prod", "uat", "qa", "dev", "develop", "stage", "demo"}


class Condition(BaseModel):
    key:       Literal["workflow_failed", "error_5xx", "error_4xx", "error_rate"]
    label:     str = Field(..., min_length=1, max_length=120)
    unit:      Literal["count", "percent"]
    threshold: float = Field(..., ge=0)


_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class AlertRuleIn(BaseModel):
    tenant:         str        = Field(..., min_length=1, max_length=120)
    envs:           list[str]  = Field(..., min_length=1, max_length=10,
                                       description="One or more env keys; rule fires if any match")
    conditions:     list[Condition] = Field(..., min_length=1, max_length=8)
    window_minutes: int        = Field(..., ge=1, le=24 * 60)
    extra_emails:   list[str]  = Field(default_factory=list, max_length=5,
                                       description="Additional recipients besides the shared SMTP to_email")
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
        # Dedupe while preserving order
        seen = set()
        out = []
        for e in cleaned:
            if e.lower() not in seen:
                seen.add(e.lower())
                out.append(e)
        return out


def _ensure_indexes(db) -> None:
    """Idempotent — safe to call on every request, Mongo de-dupes."""
    db[COLLECTION].create_index([("tenant", 1), ("envs", 1)])
    db[COLLECTION].create_index([("created_at", -1)])


def _serialize(doc: dict) -> dict:
    """Mongo ObjectId → string `id`, drop the raw `_id`."""
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
    if env:    q["envs"]   = env       # matches any rule whose `envs` array contains this value
    docs = list(db[COLLECTION].find(q).sort("created_at", -1))
    return {"rules": [_serialize(d) for d in docs], "count": len(docs)}


@router.post("/rules", status_code=201)
def create_rule(payload: AlertRuleIn):
    bad_envs = [e for e in payload.envs if e not in ALLOWED_ENVS]
    if bad_envs:
        # Don't 422 — friendlier message that tells the UI the allowed set.
        raise HTTPException(400, f"envs must be one of {sorted(ALLOWED_ENVS)}; got bad: {bad_envs}")
    # Pydantic already restricts condition.key via Literal; this guards against
    # someone bypassing Pydantic (e.g. wrong payload shape).
    bad = [c.key for c in payload.conditions if c.key not in ALLOWED_CONDITION_KEYS]
    if bad:
        raise HTTPException(400, f"Unknown condition keys: {bad}")

    db = get_db()
    _ensure_indexes(db)
    doc = {
        "tenant":            payload.tenant,
        "envs":              list(dict.fromkeys(payload.envs)),   # preserve order, dedupe
        "conditions":        [c.model_dump() for c in payload.conditions],
        "window_minutes":    payload.window_minutes,
        "extra_emails":      payload.extra_emails,
        "teams_enabled":     payload.teams_enabled,
        "teams_webhook_id":  payload.teams_webhook_id if payload.teams_enabled else None,
        "state":             {},     # populated by the evaluator
        "last_evaluated_at": None,   # populated by the evaluator
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


@router.post("/evaluate-now")
def evaluate_now():
    """Force a synchronous run of the alert evaluator across all rules.
    Exists for manual testing — the scheduled 30-min job calls the same
    function under the hood."""
    from jobs.alert_evaluator import evaluate_all_rules
    summary = evaluate_all_rules()
    return summary


# ─── Teams "Investigate" endpoints ───────────────────────────────────────────

_PAGE_STYLE = """
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
       margin:0;padding:0;background:#f1f5f9;min-height:100vh;
       display:flex;align-items:center;justify-content:center}
  .card{background:#fff;border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,.1);
        padding:36px 40px;max-width:560px;width:100%}
  h2{margin:0 0 6px;font-size:20px;color:#111827}
  p{margin:0 0 20px;font-size:13px;color:#6b7280}
  .wf-list{list-style:none;margin:0 0 24px;padding:0;display:flex;flex-direction:column;gap:10px}
  .wf-item{display:flex;align-items:flex-start;gap:12px;padding:12px 14px;
           border:1.5px solid #e5e7eb;border-radius:10px;cursor:pointer;transition:border .15s}
  .wf-item:has(input:checked){border-color:#2563eb;background:#eff6ff}
  .wf-item input{margin-top:3px;accent-color:#2563eb;flex-shrink:0}
  .wf-name{font-weight:700;font-size:14px;color:#111827}
  .wf-err{font-size:12px;color:#6b7280;margin-top:2px}
  .btn{width:100%;padding:12px;border:none;border-radius:10px;
       background:#2563eb;color:#fff;font-size:15px;font-weight:600;cursor:pointer}
  .btn:hover{background:#1d4ed8}
  .btn:disabled{opacity:.6;cursor:not-allowed}
  .empty{text-align:center;color:#9ca3af;font-size:14px;padding:20px 0}
"""


@router.get("/investigate", response_class=HTMLResponse)
def investigate_selector(
    tenant: str,
    env: str,
    window_minutes: int = 60,
    webhook_id: str = "",
):
    """Serve a workflow-selector page opened when user clicks Investigate in Teams."""
    db = get_db()
    now          = datetime.now(timezone.utc)
    window_start = (now - timedelta(minutes=window_minutes)).isoformat()

    # Query recent workflow failures for all envs (env param may be comma-separated)
    env_list = [e.strip() for e in env.split(",") if e.strip()]
    pipeline = [
        {"$match": {"tenant_name": tenant, "environment": {"$in": env_list}}},
        {"$unwind": "$executions"},
        {"$match": {
            "executions.status":     {"$regex": r"^failed$", "$options": "i"},
            "executions.start_time": {"$gte": window_start},
        }},
        {"$sort": {"executions.start_time": -1}},
        {"$group": {
            "_id":  {"$ifNull": ["$executions.workflow_id", "$executions.workflowId"]},
            "exec": {"$first": "$executions"},
        }},
        {"$sort": {"exec.start_time": -1}},
        {"$limit": 20},
    ]
    failures = []
    for doc in db["workflow_executions"].aggregate(pipeline, allowDiskUse=True):
        wf_id = doc.get("_id") or ""
        ex    = doc.get("exec") or {}
        failures.append({
            "workflow_id":  wf_id,
            "process_name": ex.get("process_name") or wf_id or "Unknown workflow",
            "error_msg":    (ex.get("error_message") or ex.get("exception") or "")[:120],
            "start_time":   ex.get("start_time", ""),
        })

    # Build radio list HTML
    if failures:
        items_html = ""
        for i, f in enumerate(failures):
            ts = f["start_time"][:19].replace("T", " ") + " UTC" if f["start_time"] else ""
            items_html += f"""
              <li class="wf-item">
                <input type="radio" name="workflow_id" value="{f['workflow_id']}"
                       id="wf{i}" {"checked" if i == 0 else ""} required>
                <label for="wf{i}" style="cursor:pointer;flex:1">
                  <div class="wf-name">{f['process_name']}</div>
                  <div class="wf-err">{f['error_msg'] or '—'}</div>
                  <div class="wf-err" style="margin-top:2px;color:#9ca3af">{ts}</div>
                </label>
              </li>"""
        list_html = f'<ul class="wf-list">{items_html}</ul>'
    else:
        list_html = '<div class="empty">No workflow failures found in this window.</div>'

    html = f"""<!DOCTYPE html><html><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Investigate — {tenant}</title>
    <style>{_PAGE_STYLE}</style></head>
    <body><div class="card">
      <h2>🔍 Investigate a workflow failure</h2>
      <p>Tenant: <strong>{tenant}</strong> &nbsp;·&nbsp; Env: <strong>{env}</strong>
         &nbsp;·&nbsp; Last {window_minutes} min</p>
      <form method="POST" action="/api/alerts/investigate/run">
        <input type="hidden" name="webhook_id" value="{webhook_id}">
        <input type="hidden" name="tenant"     value="{tenant}">
        <input type="hidden" name="env"        value="{env}">
        {list_html}
        {"<button class='btn' type='submit'>Investigate</button>" if failures else ""}
      </form>
    </div></body></html>"""
    return HTMLResponse(html)


@router.post("/investigate/run", response_class=HTMLResponse)
def run_investigation(
    background_tasks: BackgroundTasks,
    workflow_id: str  = Form(...),
    webhook_id:  str  = Form(...),
    tenant:      str  = Form(...),
    env:         str  = Form(...),
):
    """Trigger background investigation for a selected workflow, post result to Teams."""
    db = get_db()
    try:
        oid = ObjectId(webhook_id)
    except Exception:
        return HTMLResponse("<h2>Invalid webhook</h2>", status_code=400)
    webhook_doc = db["teams_webhooks"].find_one({"_id": oid})
    if not webhook_doc:
        return HTMLResponse("<h2>Webhook not found</h2>", status_code=404)

    background_tasks.add_task(
        _run_workflow_investigation_task,
        workflow_id, tenant, env, webhook_doc["url"],
    )
    return HTMLResponse(f"""<!DOCTYPE html><html><head><meta charset="utf-8">
    <title>Investigation started</title>
    <style>{_PAGE_STYLE}</style></head>
    <body><div class="card" style="text-align:center">
      <div style="font-size:48px;margin-bottom:12px">✅</div>
      <h2>Investigation started</h2>
      <p>Results will appear in your Teams channel shortly.</p>
      <p style="color:#9ca3af;font-size:12px">You can close this tab.</p>
    </div></body></html>""")


def _run_workflow_investigation_task(
    workflow_id: str, tenant: str, env: str, webhook_url: str
) -> None:
    """Background task: run AI investigation, post result to Teams."""
    try:
        from routers.temporal import run_workflow_investigation
        result     = run_workflow_investigation(workflow_id)
        ai         = result.get("ai_analysis") or {}
        analysis   = result.get("analysis") or {}
        app_ctx    = result.get("app_context") or {}

        process_name = app_ctx.get("app_display_name") or app_ctx.get("app_name") or workflow_id

        if ai.get("error"):
            title_text  = f"⚠️ Investigation error — {workflow_id}"
            body_blocks = [{"type": "TextBlock", "text": str(ai["error"]), "wrap": True, "color": "Attention"}]
        elif not ai:
            title_text  = f"⚠️ No AI analysis — {workflow_id}"
            status      = analysis.get("status", "unknown")
            body_blocks = [{"type": "TextBlock", "text": f"Workflow status: {status}. No AI result.", "wrap": True}]
        else:
            title_text  = f"🔍 Investigation — {process_name}"

            body_blocks: list = [
                {"type": "TextBlock", "text": "**Root Cause**", "weight": "Bolder", "spacing": "Medium"},
                {"type": "TextBlock", "text": ai.get("rootCause", "—"), "wrap": True},
            ]

            # Failure chain
            chain = ai.get("failureChain") or []
            if chain:
                body_blocks.append({
                    "type": "TextBlock", "text": "**Failure Chain**",
                    "weight": "Bolder", "spacing": "Medium",
                })
                for step in chain[:6]:
                    body_blocks.append({
                        "type": "TextBlock",
                        "text": f"{step.get('step', '')}. {step.get('label', '')} — {step.get('description', '')}",
                        "wrap": True, "isSubtle": True,
                    })

            # Resolution
            resolution = ai.get("resolution") or []
            if resolution:
                body_blocks.append({
                    "type": "TextBlock", "text": "**Resolution**",
                    "weight": "Bolder", "spacing": "Medium",
                })
                body_blocks.append({
                    "type": "TextBlock",
                    "text": "\n".join(f"• {r}" for r in resolution[:5]),
                    "wrap": True,
                })

            # Past fix note
            if ai.get("usedPastFix") and ai.get("pastFixNote"):
                body_blocks.append({
                    "type": "TextBlock",
                    "text": f"💡 Past fix: {ai['pastFixNote']}",
                    "wrap": True, "isSubtle": True, "spacing": "Medium",
                })

        card = {
            "type":    "AdaptiveCard",
            "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
            "version": "1.4",
            "body": [
                {
                    "type": "TextBlock", "text": title_text,
                    "size": "Large", "weight": "Bolder",
                    "color": "Warning" if ai.get("error") else "Good",
                },
                {"type": "FactSet", "facts": [
                    {"title": "Tenant", "value": tenant},
                    {"title": "Env",    "value": env},
                    {"title": "Workflow ID", "value": workflow_id},
                ]},
            ] + body_blocks,
        }

        payload = {
            "type": "message",
            "attachments": [{
                "contentType": "application/vnd.microsoft.card.adaptive",
                "contentUrl":  None,
                "content":     card,
            }],
        }
        data = json.dumps(payload).encode()
        req  = urllib.request.Request(
            webhook_url, data=data, headers={"Content-Type": "application/json"}
        )
        urllib.request.urlopen(req, timeout=15)

    except Exception:
        import logging
        logging.getLogger(__name__).exception(
            "Investigation background task failed for workflow %s", workflow_id
        )
