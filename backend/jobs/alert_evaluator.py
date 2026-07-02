"""
Alert evaluator — invoked every 30 min by APScheduler (and on demand via
POST /api/alerts/evaluate-now).

For each rule in `alert_rules`, for each env the rule targets, evaluates each
condition against the latest data in Mongo and emails the SMTP recipient(s)
when a condition fires. Maintains per-rule state so the same workflow failure
isn't alerted twice, and so threshold-based conditions don't re-fire on
sustained spikes (hysteresis).

The four condition kinds get two different dedup strategies:

  workflow_failed:  per-workflow_id dedup via `state.workflow_failed.notified_workflow_ids`.
                    Fires when len(new_failed_ids) > threshold.
  error_5xx/4xx:    hysteresis flag in `state.<cond>.alerting`. Fires when
                    count > threshold AND not already alerting; clears when count
                    drops below threshold.
  error_rate:       same hysteresis as 5xx/4xx but on the rate percent.

Email body lists every condition that fired in this cycle in one message per
rule (one email per rule per cycle, not per condition).
"""
from __future__ import annotations

import json
import logging
import urllib.request
from datetime import datetime, timezone, timedelta
from email.message import EmailMessage
from typing import Any
from urllib.parse import quote, urlencode

from bson import ObjectId

from config import get_config
from database import get_db
from routers.support import load_smtp_config, send_via_smtp

log = logging.getLogger(__name__)

_MAX_NOTIFIED_IDS = 1000   # cap state.workflow_failed.notified_workflow_ids

# Error message → bucket. Order is priority — first match wins, "other" is the
# fallback. Tuned for the kinds of messages we see in `workflow_executions`
# (TimeoutError, ConnectionRefused, ValidationError, ChildWorkflowFailure, ...).
ERROR_CATEGORIES = [
    {"key": "timeout",    "label": "Timeout",            "color": "#d4a017",
     "patterns": ["timeout", "timed out", "deadline"]},
    {"key": "connection", "label": "Connection",         "color": "#1f2937",
     "patterns": ["connect", "refused", "econn", "network", "unreachable", "dns"]},
    {"key": "not_found",  "label": "Not Found",          "color": "#9ca3af",
     "patterns": ["not found", "404", "no such", "missing file"]},
    {"key": "validation", "label": "Validation",         "color": "#4b5563",
     "patterns": ["validation", "invalid", "missing field", "schema", "bad request"]},
    {"key": "child_wf",   "label": "Child Workflow",     "color": "#92400e",
     "patterns": ["childworkflowfailure", "child workflow"]},
    {"key": "other",      "label": "Other",              "color": "#dc2626",
     "patterns": []},  # catch-all
]


def _categorize_error(text: str) -> dict:
    """Pick the first category whose pattern occurs (case-insensitive) in
    `text`. Falls back to the catch-all 'other' bucket."""
    t = (text or "").lower()
    for cat in ERROR_CATEGORIES[:-1]:
        if any(p in t for p in cat["patterns"]):
            return cat
    return ERROR_CATEGORIES[-1]


def evaluate_all_rules(collection: str = "alert_rules") -> dict:
    """Top-level entry. Returns a summary dict suitable for the
    /evaluate-now endpoint response. Pass collection='sev_a_rules' for Sev A."""
    db = get_db()
    smtp_doc = load_smtp_config()
    smtp_ok = bool(smtp_doc and smtp_doc.get("smtp_host") and smtp_doc.get("to_email"))

    rules = list(db[collection].find({}))
    now_iso = datetime.now(timezone.utc).isoformat()

    summary = {
        "evaluated_at":     now_iso,
        "rules_evaluated":  0,
        "rules_fired":      0,
        "emails_sent":      0,
        "smtp_configured":  smtp_ok,
        "per_rule":         [],
    }

    for rule in rules:
        result = _evaluate_one_rule(db, rule, smtp_doc if smtp_ok else None, now_iso, collection=collection)
        summary["per_rule"].append(result)
        summary["rules_evaluated"] += 1
        if result.get("fired"):
            summary["rules_fired"] += 1
        if result.get("email_sent"):
            summary["emails_sent"] += 1

    log.info("alert evaluator finished: %s", {k: v for k, v in summary.items() if k != "per_rule"})
    return summary


def _evaluate_one_rule(db, rule: dict, smtp_doc: dict | None, now_iso: str, collection: str = "alert_rules") -> dict:
    rule_id        = str(rule["_id"])
    tenant         = rule.get("tenant")
    envs           = rule.get("envs") or ([rule["env"]] if rule.get("env") else [])
    conditions     = rule.get("conditions") or []
    window_minutes = int(rule.get("window_minutes") or 60)
    state          = dict(rule.get("state") or {})
    workflow_names = rule.get("workflow_names") or []

    window_start = (datetime.now(timezone.utc) - timedelta(minutes=window_minutes)).isoformat()

    # Sev A: workflow_failed threshold is always 0 — any single failure triggers.
    if collection == "sev_a_rules":
        conditions = [
            {**c, "threshold": 0} if c.get("key") == "workflow_failed" else c
            for c in conditions
        ]

    # Snapshot of pre-update state so we can build $set updates after eval.
    triggered: list[dict] = []
    state_updates: dict[str, Any] = {}
    push_updates: dict[str, Any] = {}

    for env in envs:
        metrics = _fetch_metrics_for(db, tenant, env, window_start, workflow_names=workflow_names or None)
        for cond in conditions:
            fired = _evaluate_condition(
                cond=cond,
                env=env,
                metrics=metrics,
                cond_state=state.get(cond["key"]) or {},
                now_iso=now_iso,
                state_updates=state_updates,
                push_updates=push_updates,
            )
            if fired:
                fired["env"] = env
                triggered.append(fired)

    email_sent = False
    email_error = None
    if triggered:
        teams_url = _resolve_teams_url(db, rule)
        if rule.get("teams_enabled") and teams_url:
            try:
                # Build "Investigate" deep-link URL
                app_base   = get_config().get("app_base_url", "").rstrip("/")
                webhook_id = rule.get("teams_webhook_id", "")
                # Backward-compat: if rule still uses raw teams_webhook URL,
                # look up the registered webhook by URL to get its ID.
                if not webhook_id:
                    raw_url = rule.get("teams_webhook", "")
                    if raw_url:
                        doc = db["teams_webhooks"].find_one({"url": raw_url})
                        if doc:
                            webhook_id = str(doc["_id"])
                investigate_url = ""
                if app_base and webhook_id:
                    investigate_url = (
                        f"{app_base}/api/alerts/investigate?"
                        + urlencode({
                            "tenant":         tenant,
                            "env":            ",".join(envs),
                            "window_minutes": window_minutes,
                            "webhook_id":     webhook_id,
                        })
                    )
                _send_teams_alert(
                    teams_url, tenant, envs, window_minutes,
                    triggered, now_iso, investigate_url,
                )
                email_sent = True
            except Exception as e:
                email_error = str(e)
                log.exception("teams alert failed for rule %s", rule_id)
        elif smtp_doc:
            try:
                _send_alert_email(rule, triggered, window_minutes, now_iso, smtp_doc,
                                  sev_a=(collection == "sev_a_rules"))
                email_sent = True
            except Exception as e:
                email_error = str(e)
                log.exception("alert email failed for rule %s", rule_id)
        else:
            email_error = "SMTP not configured"

    # Persist state changes + last_evaluated_at regardless of whether email
    # succeeded — re-trying on every cycle would re-fire stale conditions.
    update_doc: dict[str, Any] = {"$set": {"last_evaluated_at": now_iso}}
    if state_updates:
        update_doc["$set"].update(state_updates)
    if push_updates:
        update_doc["$push"] = push_updates
    db[collection].update_one({"_id": rule["_id"]}, update_doc)

    return {
        "rule_id":    rule_id,
        "tenant":     tenant,
        "envs":       envs,
        "fired":      bool(triggered),
        "triggered":  triggered,
        "email_sent": email_sent,
        "email_error": email_error,
    }


# ─── Metrics fetch ─────────────────────────────────────────────────────────────

def _fetch_metrics_for(db, tenant: str, env: str, window_start_iso: str, workflow_names: list[str] | None = None) -> dict:
    """Pull the per-(tenant,env) metrics the evaluator needs.

    Returns:
      {
        "failed_workflow_ids":  [str, ...],   # unique workflow_ids that failed
        "failed_executions":    [dict, ...],  # full exec docs (same dedup key),
                                              # ordered most-recent first.
                                              # Used to build the HTML report.
        "error_4xx":    int,    # summed across apps for this (tenant, env)
        "error_5xx":    int,    # ditto
        "total_requests": int,
        "error_rate":   float,  # percent
      }
    """
    out = {
        "failed_workflow_ids": [],
        "failed_executions":   [],
        "error_4xx":      0,
        "error_5xx":      0,
        "total_requests": 0,
        "error_rate":     0.0,
    }

    # Failed workflows — unwind workflow_executions and dedupe by workflow_id.
    # Picks the most recent execution per workflow_id so the email has the
    # freshest error message / start_time. Same dedup shape as
    # backend/routers/temporal.py:2166-2186.
    try:
        pipeline = [
            {"$match": {"tenant_name": tenant, "environment": env}},
            {"$unwind": "$executions"},
            {"$match": {
                "executions.status":     {"$regex": r"^failed$", "$options": "i"},
                "executions.start_time": {"$gte": window_start_iso},
                **({"executions.process_name": {"$in": workflow_names}} if workflow_names else {}),
            }},
            {"$sort": {"executions.start_time": -1}},
            {"$group": {
                "_id":      {"$ifNull": ["$executions.workflow_id", "$executions.workflowId"]},
                "exec":     {"$first": "$executions"},
                # Carry app context forward — executions[] doesn't have it,
                # but the parent doc does (one workflow_executions doc per
                # app, with executions appended over time).
                "app_name": {"$first": "$app_name"},
                "app_display_name": {"$first": "$app_display_name"},
            }},
            {"$sort": {"exec.start_time": -1}},
        ]
        execs = []
        ids = []
        for doc in db["workflow_executions"].aggregate(pipeline, allowDiskUse=True):
            wf_id = doc.get("_id")
            if not wf_id:
                continue
            ids.append(wf_id)
            ex = dict(doc.get("exec") or {})
            ex.setdefault("workflow_id", wf_id)
            # Flatten app context onto the execution so downstream rendering
            # doesn't need to dig back into the doc.
            ex["app_name"]         = doc.get("app_name")
            ex["app_display_name"] = doc.get("app_display_name")
            execs.append(ex)
        out["failed_workflow_ids"] = ids
        out["failed_executions"]   = execs
    except Exception:
        log.exception("workflow_executions aggregation failed for %s/%s", tenant, env)

    # 4xx / 5xx / total_requests — pull each app's *latest* snapshot whose
    # analyzed_at is inside the window, then sum.
    try:
        cursor = db["app_insights"].aggregate([
            {"$match": {
                "tenant_name": tenant,
                "environment": env,
                "analyzed_at": {"$gte": window_start_iso},
            }},
            {"$sort": {"analyzed_at": -1}},
            {"$group": {
                "_id": "$inst_id",
                "doc": {"$first": "$$ROOT"},
            }},
            {"$replaceRoot": {"newRoot": "$doc"}},
        ], allowDiskUse=True)
        for snap in cursor:
            out["error_4xx"]      += int(snap.get("error_4xx_count")    or 0)
            out["error_5xx"]      += int(snap.get("error_5xx_count")    or 0)
            out["total_requests"] += int(snap.get("total_requests")     or 0)
    except Exception:
        log.exception("app_insights aggregation failed for %s/%s", tenant, env)

    if out["total_requests"] > 0:
        out["error_rate"] = round(
            (out["error_4xx"] + out["error_5xx"]) / out["total_requests"] * 100, 2
        )

    return out


# ─── Condition evaluation ─────────────────────────────────────────────────────

def _evaluate_condition(
    *,
    cond: dict,
    env: str,
    metrics: dict,
    cond_state: dict,
    now_iso: str,
    state_updates: dict,
    push_updates: dict,
) -> dict | None:
    """Returns a triggered dict if this condition fired, else None.
    Mutates state_updates / push_updates in place with what to persist."""
    key       = cond["key"]
    threshold = float(cond.get("threshold") or 0)
    label     = cond.get("label") or key

    if key == "workflow_failed":
        already_notified = set(cond_state.get("notified_workflow_ids") or [])
        current_ids = metrics.get("failed_workflow_ids") or []
        current_execs = metrics.get("failed_executions") or []
        # Build wf_id → execution map so we can return full exec docs for the
        # IDs that survive the dedup filter.
        exec_by_id = {(e.get("workflow_id") or e.get("workflowId")): e for e in current_execs}
        new_ids = [i for i in current_ids if i not in already_notified]
        if len(new_ids) > threshold:
            state_updates[f"state.{key}.last_alert_at"] = now_iso
            push_updates[f"state.{key}.notified_workflow_ids"] = {
                "$each": new_ids, "$slice": -_MAX_NOTIFIED_IDS,
            }
            new_execs = [exec_by_id[i] for i in new_ids if i in exec_by_id]
            return {
                "condition_key":   key,
                "condition_label": label,
                "threshold":       threshold,
                "count":           len(new_ids),
                "new_workflow_ids": new_ids[:50],
                "new_executions":   new_execs,   # full docs for the HTML report
            }
        return None

    if key in ("error_5xx", "error_4xx"):
        current = int(metrics.get(key, 0))
        already_alerting = bool(cond_state.get("alerting"))
        state_updates[f"state.{key}.last_value"] = current
        if current > threshold and not already_alerting:
            state_updates[f"state.{key}.alerting"]      = True
            state_updates[f"state.{key}.last_alert_at"] = now_iso
            return {
                "condition_key":   key,
                "condition_label": label,
                "threshold":       threshold,
                "count":           current,
            }
        if current <= threshold and already_alerting:
            state_updates[f"state.{key}.alerting"] = False
        return None

    if key == "error_rate":
        current = float(metrics.get("error_rate", 0.0))
        already_alerting = bool(cond_state.get("alerting"))
        state_updates[f"state.{key}.last_value"] = current
        if current > threshold and not already_alerting:
            state_updates[f"state.{key}.alerting"]      = True
            state_updates[f"state.{key}.last_alert_at"] = now_iso
            return {
                "condition_key":   key,
                "condition_label": label,
                "threshold":       threshold,
                "rate":            current,
            }
        if current <= threshold and already_alerting:
            state_updates[f"state.{key}.alerting"] = False
        return None

    return None


# ─── Teams webhook helpers ───────────────────────────────────────────────────

def _resolve_teams_url(db, rule: dict) -> str | None:
    """Return the Teams webhook URL for a rule, looking it up by ID if needed."""
    webhook_id = rule.get("teams_webhook_id")
    if webhook_id:
        try:
            doc = db["teams_webhooks"].find_one({"_id": ObjectId(webhook_id)})
            if doc:
                return doc["url"]
        except Exception:
            pass
    return rule.get("teams_webhook")  # backward compat for old docs with raw URL


def _send_teams_alert(
    webhook_url: str,
    tenant: str,
    envs: list[str],
    window_minutes: int,
    triggered: list[dict],
    now_iso: str,
    investigate_url: str = "",
) -> None:
    """POST an Adaptive Card to a Teams Incoming Webhook."""
    envs_str = ", ".join(envs)

    # Conditions summary
    cond_lines = []
    for t in triggered:
        key   = t.get("condition_key", "")
        label = t.get("condition_label", key)
        count = t.get("count", 0)
        rate  = t.get("rate")
        if key == "error_rate":
            cond_lines.append(f"• {label}: {rate:.1f}%")
        else:
            cond_lines.append(f"• {label}: {count}")
    conditions_text = "\n".join(cond_lines) or "Conditions fired"

    # Failed workflow rows (up to 8)
    wf_rows = []
    for t in triggered:
        if t.get("condition_key") == "workflow_failed":
            for ex in (t.get("new_executions") or [])[:8]:
                wf_id = ex.get("workflow_id") or ex.get("workflowId", "")
                name  = ex.get("process_name") or ex.get("workflow_name") or ""
                err   = (ex.get("error_message") or ex.get("exception") or "")[:80]
                wf_rows.append({"name": name, "wf_id": wf_id, "err": err})

    body: list = [
        {
            "type": "TextBlock",
            "text": f"🔴 Alert fired — {tenant}",
            "size": "Large",
            "weight": "Bolder",
            "color": "Attention",
        },
        {
            "type": "FactSet",
            "facts": [
                {"title": "Tenant",      "value": tenant},
                {"title": "Environment", "value": envs_str},
                {"title": "Window",      "value": f"{window_minutes} min"},
                {"title": "Time",        "value": now_iso},
            ],
        },
        {
            "type": "TextBlock",
            "text": "**Conditions fired:**",
            "weight": "Bolder",
            "spacing": "Medium",
        },
        {"type": "TextBlock", "text": conditions_text, "wrap": True},
    ]

    if wf_rows:
        body.append({
            "type": "TextBlock",
            "text": f"**Failed Workflows ({len(wf_rows)})**",
            "weight": "Bolder",
            "spacing": "Medium",
            "separator": True,
        })
        for i, wf in enumerate(wf_rows):
            wf_name = wf["name"] or ""
            wf_id   = wf["wf_id"] or ""
            wf_err  = wf["err"] or ""

            container_items: list = []

            # Workflow name row — show name if available, else mark as unnamed
            name_display = wf_name if wf_name else "— (no process name)"
            container_items.append({
                "type": "ColumnSet",
                "columns": [
                    {
                        "type": "Column", "width": "auto",
                        "items": [{"type": "TextBlock", "text": "Workflow",
                                   "size": "Small", "color": "Accent",
                                   "weight": "Bolder", "isSubtle": False}],
                    },
                    {
                        "type": "Column", "width": "stretch",
                        "items": [{"type": "TextBlock", "text": name_display,
                                   "weight": "Bolder", "wrap": True, "size": "Small"}],
                    },
                ],
            })

            # Run ID row (always show so it's clearly labelled)
            if wf_id:
                container_items.append({
                    "type": "ColumnSet",
                    "spacing": "None",
                    "columns": [
                        {
                            "type": "Column", "width": "auto",
                            "items": [{"type": "TextBlock", "text": "Run ID",
                                       "size": "Small", "isSubtle": True,
                                       "weight": "Bolder"}],
                        },
                        {
                            "type": "Column", "width": "stretch",
                            "items": [{"type": "TextBlock", "text": wf_id,
                                       "size": "Small", "isSubtle": True, "wrap": True}],
                        },
                    ],
                })

            # Error row
            if wf_err:
                container_items.append({
                    "type": "ColumnSet",
                    "spacing": "None",
                    "columns": [
                        {
                            "type": "Column", "width": "auto",
                            "items": [{"type": "TextBlock", "text": "Error",
                                       "size": "Small", "color": "Attention",
                                       "weight": "Bolder"}],
                        },
                        {
                            "type": "Column", "width": "stretch",
                            "items": [{"type": "TextBlock", "text": wf_err,
                                       "size": "Small", "color": "Attention",
                                       "wrap": True}],
                        },
                    ],
                })

            body.append({
                "type":      "Container",
                "style":     "emphasis",
                "spacing":   "Small",
                "separator": i > 0,
                "items":     container_items,
            })

    card: dict = {
        "type":    "AdaptiveCard",
        "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
        "version": "1.4",
        "body":    body,
    }
    if investigate_url:
        card["actions"] = [
            {"type": "Action.OpenUrl", "title": "🔍 Investigate", "url": investigate_url}
        ]

    payload = {
        "type": "message",
        "attachments": [{
            "contentType": "application/vnd.microsoft.card.adaptive",
            "contentUrl":  None,
            "content":     card,
        }],
    }
    data = json.dumps(payload).encode()
    req  = urllib.request.Request(webhook_url, data=data,
                                   headers={"Content-Type": "application/json"})
    urllib.request.urlopen(req, timeout=10)


# ─── Email build + send ───────────────────────────────────────────────────────

def _send_alert_email(rule: dict, triggered: list[dict], window_minutes: int,
                      now_iso: str, smtp_doc: dict, sev_a: bool = False) -> None:
    tenant = rule.get("tenant")
    envs   = rule.get("envs") or []
    envs_str = ", ".join(envs)

    recipients = [smtp_doc["to_email"]] + list(rule.get("extra_emails") or [])
    seen = set()
    deduped = []
    for r in recipients:
        if r and r.lower() not in seen:
            seen.add(r.lower())
            deduped.append(r)

    if sev_a:
        # Collect window-period failures already gathered by the evaluator
        window_execs = [ex for t in triggered for ex in (t.get("new_executions") or [])]
        total = len(window_execs)
        noun  = "failure" if total == 1 else "failures"
        subject = f"[Sev A] {tenant} / {envs_str}: {total} workflow {noun} detected"
        dashboard_url = (smtp_doc.get("dashboard_url") or "https://apm.jiffy.ai").rstrip("/")
        first_env = envs[0] if envs else ""
        deep_link = (
            f"{dashboard_url}/?page=tenant-apps"
            f"&tenant={quote(tenant or '')}"
            + (f"&env={quote(first_env)}" if first_env else "")
        )
        plain = _build_sev_a_plain_body(tenant, envs, window_execs, deep_link=deep_link)
        skyline_url = f"{dashboard_url}/static/skyline-bg.jpg"
        html  = _build_sev_a_html_body(tenant, envs, window_execs, deep_link=deep_link, skyline_url=skyline_url)
    else:
        workflow_names = rule.get("workflow_names") or []
        day_execs = _fetch_day_failures(get_db(), tenant, envs, workflow_names=workflow_names or None)

        total_wf_failed = sum(t.get("count", 0) for t in triggered if t.get("condition_key") == "workflow_failed")
        if total_wf_failed:
            noun = "failure" if total_wf_failed == 1 else "failures"
            subject = f"[Monitoring] {tenant} / {envs_str}: {total_wf_failed} workflow {noun} detected"
        else:
            n = len(triggered)
            noun = "alert" if n == 1 else "alerts"
            subject = f"[Monitoring] {tenant} / {envs_str}: {n} {noun} triggered"

        # Deep link to the tenant-apps page for this tenant + first env.
        dashboard_url = (smtp_doc.get("dashboard_url") or "https://apm.jiffy.ai").rstrip("/")
        first_env = envs[0] if envs else ""
        deep_link = (
            f"{dashboard_url}/?page=tenant-apps"
            f"&tenant={quote(tenant or '')}"
            + (f"&env={quote(first_env)}" if first_env else "")
        )
        plain = _build_plain_body(tenant, envs_str, window_minutes, now_iso, triggered, deep_link)
        html  = _build_html_body(tenant, envs, window_minutes, now_iso, triggered, deep_link,
                                  day_execs=day_execs)

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"]    = smtp_doc["from_email"]
    msg["To"]      = ", ".join(deduped)
    msg.set_content(plain)
    msg.add_alternative(html, subtype="html")

    send_via_smtp(msg, smtp_doc)


def _build_plain_body(tenant: str, envs_str: str, window_minutes: int,
                      now_iso: str, triggered: list[dict], deep_link: str = "") -> str:
    """Plain-text fallback for clients that don't render HTML."""
    lines: list[str] = []
    lines.append(f"Tenant: {tenant}")
    lines.append(f"Environments: {envs_str}")
    lines.append(f"Window: last {window_minutes} minutes")
    lines.append(f"Evaluated at: {_fmt_iso_full(now_iso)}")
    lines.append("")
    lines.append("Triggered conditions")
    lines.append("────────────────────")
    for t in triggered:
        env = t.get("env", "")
        label = t["condition_label"]
        threshold = t["threshold"]
        if t["condition_key"] == "workflow_failed":
            lines.append(f"• [{env}] {label}: {t['count']} new (threshold {threshold:g})")
            execs_by_id = {(e.get("workflow_id") or e.get("workflowId")): e for e in (t.get("new_executions") or [])}
            for wid in t.get("new_workflow_ids", []):
                ex = execs_by_id.get(wid)
                wf_name = (ex.get("process_name") or ex.get("workflow_name") or "") if ex else ""
                if wf_name:
                    lines.append(f"    {wf_name}  ({wid})")
                else:
                    lines.append(f"    {wid}")
        elif t["condition_key"] == "error_rate":
            lines.append(f"• [{env}] {label}: {t['rate']:.2f}% (threshold {threshold:g}%)")
        else:
            lines.append(f"• [{env}] {label}: {t['count']} (threshold {threshold:g})")
    lines.append("")
    if deep_link:
        lines.append(f"Open the dashboard for full investigation: {deep_link}")
    else:
        lines.append("Open the dashboard for full investigation.")
    return "\n".join(lines)


def _fmt_iso_for_email(iso: str | None) -> str:
    """Format an ISO timestamp as 'HH:MM:SS IST' for the email body. Returns
    '—' if iso is missing or unparseable."""
    if not iso:
        return "—"
    try:
        dt = datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        ist = dt.astimezone(timezone(timedelta(hours=5, minutes=30)))
        return ist.strftime("%H:%M:%S IST")
    except Exception:
        return str(iso)[:19].replace("T", " ")


def _fmt_iso_full(iso: str | None) -> str:
    if not iso:
        return "—"
    try:
        dt = datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        ist = dt.astimezone(timezone(timedelta(hours=5, minutes=30)))
        return ist.strftime("%d-%b-%Y %H:%M:%S IST")
    except Exception:
        return str(iso)


def _html_escape(s: str) -> str:
    return (
        (s or "")
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def _build_donut_svg(slices: list[dict], total: int, size: int = 120) -> str:
    """Inline SVG donut. `slices` is a list of {color, count} ordered around
    the ring. Gmail / iOS Mail / Outlook web render inline SVG; Outlook
    desktop sometimes won't, in which case the legend below still carries
    every number — the chart is decoration, not the single source of truth."""
    if total <= 0:
        return ""
    r = 40
    cx = cy = 50
    circumference = 2 * 3.141592653589793 * r
    parts: list[str] = []
    # Background ring
    parts.append(
        f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="none" '
        f'stroke="#f3f4f6" stroke-width="14"/>'
    )
    offset = 0.0
    for s in slices:
        count = int(s.get("count") or 0)
        if count <= 0:
            continue
        seg = (count / total) * circumference
        # `stroke-dasharray "seg gap"` plus a negative dashoffset rotates the
        # arc into position. Drawing starts at 3 o'clock, so the parent
        # transform rotates by -90° to begin at 12 o'clock.
        parts.append(
            f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="none" '
            f'stroke="{s["color"]}" stroke-width="14" '
            f'stroke-dasharray="{seg:.3f} {circumference - seg:.3f}" '
            f'stroke-dashoffset="{-offset:.3f}"/>'
        )
        offset += seg
    inner = "".join(parts)
    return (
        f'<svg viewBox="0 0 100 100" width="{size}" height="{size}" '
        f'style="display:block;transform:rotate(-90deg);">{inner}</svg>'
    )


def _fetch_day_failures(db, tenant: str, envs: list[str], workflow_names: list[str] | None = None,
                        since_iso: str | None = None) -> list[dict]:
    """All failed workflow executions for (tenant, env in envs) since today's
    12:00 AM IST (or since_iso if provided). Combines MongoDB workflow_executions
    with live OpenSearch data. Deduped by workflow_id across both sources.
    If workflow_names is provided, only include executions for those process names."""
    import re
    from timewindow import ist_day_window
    start_utc, now_utc = ist_day_window()
    start_iso = since_iso if since_iso else start_utc.isoformat()
    out: list[dict] = []
    seen_wf_ids: set[str] = set()

    for env in envs:
        # ── MongoDB: all failed execution entries today ────────────────────
        try:
            pipeline = [
                {"$match": {"tenant_name": tenant, "environment": env}},
                {"$unwind": "$executions"},
                {"$match": {
                    "executions.status":     {"$regex": r"^failed$", "$options": "i"},
                    "executions.start_time": {"$gte": start_iso},
                    **({"executions.process_name": {"$in": workflow_names}} if workflow_names else {}),
                }},
                {"$sort": {"executions.start_time": -1}},
                {"$project": {
                    "exec":             "$executions",
                    "app_name":         1,
                    "app_display_name": 1,
                }},
            ]
            for doc in db["workflow_executions"].aggregate(pipeline, allowDiskUse=True):
                ex = dict(doc.get("exec") or {})
                wf_id = str(ex.get("workflow_id") or ex.get("workflowId") or "")
                if not wf_id or wf_id in seen_wf_ids:
                    continue
                seen_wf_ids.add(wf_id)
                ex.setdefault("workflow_id", wf_id)
                ex["app_name"]         = doc.get("app_name")
                ex["app_display_name"] = doc.get("app_display_name")
                ex["_env"] = env
                out.append(ex)
        except Exception:
            log.exception("day failures MongoDB aggregation failed for %s/%s", tenant, env)

        # ── OpenSearch: live failures not yet written to MongoDB ───────────
        try:
            from routers.insights import _os_client
            app_docs = list(db["app_insights"].aggregate([
                {"$match": {"tenant_name": tenant, "environment": env}},
                {"$sort": {"analyzed_at": -1}},
                {"$group": {"_id": "$app_name", "doc": {"$first": "$$ROOT"}}},
                {"$replaceRoot": {"newRoot": "$doc"}},
            ]))
            ts_start = start_utc.strftime("%Y-%m-%dT%H:%M:%SZ")
            ts_end   = now_utc.strftime("%Y-%m-%dT%H:%M:%SZ")
            _wf_re   = re.compile(r"((?:Jiffy|JM)_\d+)")
            _uuid_re = re.compile(r"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})", re.IGNORECASE)
            client   = _os_client()
            for app_doc in app_docs:
                inst_id = app_doc.get("inst_id") or app_doc.get("app_id", "")
                if not inst_id:
                    continue
                app_name = app_doc.get("app_display_name") or app_doc.get("app_name") or "—"
                query = {
                    "size": 500,
                    "sort": [{"@timestamp": {"order": "desc"}}],
                    "_source": ["@timestamp", "message", "correlationId", "processName", "appId"],
                    "query": {"bool": {
                        "must": [
                            {"range": {"@timestamp": {"gte": ts_start, "lte": ts_end}}},
                            {"term":  {"appId.keyword": inst_id}},
                        ],
                        "should": [
                            {"term":         {"status.keyword": "Failed"}},
                            {"match_phrase": {"message": "WORKFLOW_EXECUTION_FAILED"}},
                            {"match_phrase": {"message": "Workflow execution failed"}},
                            {"match_phrase": {"message": "Workflow execution failure"}},
                            {"match_phrase": {"message": "Work FLow execution Failed"}},
                            {"match_phrase": {"message": "JOB UNEXPECTED ERROR"}},
                            {"match_phrase": {"message": "WorkflowException"}},
                            {"match_phrase": {"message": "Failed to execute"}},
                        ],
                        "minimum_should_match": 1,
                    }},
                }
                resp = client.search(index="platform-*", body=query)
                for hit in resp.get("hits", {}).get("hits", []):
                    src   = hit["_source"]
                    msg   = src.get("message", "")
                    wf_id = str(src.get("correlationId") or "")
                    if not _wf_re.match(wf_id) and not _uuid_re.match(wf_id):
                        m = _wf_re.search(msg)
                        wf_id = m.group(1) if m else ""
                        if not wf_id:
                            m2 = _uuid_re.search(msg)
                            wf_id = m2.group(1) if m2 else ""
                    if not wf_id or wf_id in seen_wf_ids:
                        continue
                    seen_wf_ids.add(wf_id)
                    out.append({
                        "workflow_id":      wf_id,
                        "status":           "failed",
                        "process_name":     src.get("processName") or "",
                        "start_time":       src.get("@timestamp") or "",
                        "error_message":    msg[:300].strip(),
                        "app_name":         app_doc.get("app_name"),
                        "app_display_name": app_name,
                        "_env":             env,
                    })
        except Exception:
            log.exception("day failures OpenSearch query failed for %s/%s", tenant, env)

    return out


def _categorize_executions(execs: list[dict]) -> list[dict]:
    """Bucket failed executions into categories. Returns the same shape as
    ERROR_CATEGORIES entries plus {count, pct} for each non-empty bucket,
    sorted by count desc."""
    buckets: dict[str, dict] = {}
    for ex in execs:
        text = " ".join([
            str(ex.get("error_message") or ""),
            str(ex.get("exception") or ""),
            str(ex.get("root_cause") or ""),
        ])
        cat = _categorize_error(text)
        b = buckets.setdefault(cat["key"], {**cat, "count": 0})
        b["count"] += 1
    total = sum(b["count"] for b in buckets.values()) or 1
    out = []
    for b in buckets.values():
        out.append({**b, "pct": round(b["count"] / total * 100)})
    out.sort(key=lambda x: x["count"], reverse=True)
    return out


def _build_sev_a_html_body(tenant: str, envs: list[str], day_execs: list[dict],
                           deep_link: str = "", skyline_url: str = "") -> str:
    """Sev A alert email.
    - Shield: CSS-only (no inline SVG — Gmail strips SVG elements)
    - Skyline: hosted image URL as CSS background-image (Gmail blocks data URIs)
    - Table: plain text column headers, red dot per row
    """
    env_label = ", ".join(e.upper() for e in envs) if envs else "—"
    total = len(day_execs)
    noun  = "failure" if total == 1 else "failures"
    t_esc = _html_escape(tenant or "—")

    # ── Skyline hosted URL — data URIs are blocked by Gmail for CSS backgrounds ──
    sky_bg_css = (
        f"background-image:url('{skyline_url}');"
        "background-repeat:no-repeat;background-position:bottom center;background-size:100% auto;"
    ) if skyline_url else ""

    # ── Table rows (cap at 50) ────────────────────────────────────────────────
    rows_html = ""
    for ex in day_execs[:50]:
        wf_name   = _html_escape(str(ex.get("process_name") or ex.get("workflow_name") or "—"))
        wf_id     = _html_escape(str(ex.get("workflow_id") or "—"))
        failed_at = _html_escape(_fmt_iso_for_email(ex.get("start_time") or ex.get("end_time")))
        rows_html += f"""
              <tr>
                <td style="padding:11px 16px;border-bottom:1px solid #f1f5f9;vertical-align:middle;">
                  <table cellpadding="0" cellspacing="0" border="0"><tr>
                    <td style="padding-right:10px;vertical-align:middle;">
                      <div style="width:7px;height:7px;border-radius:50%;background:#dc2626;font-size:0;line-height:0;">&nbsp;</div>
                    </td>
                    <td style="font-family:'Segoe UI',Arial,sans-serif;font-size:13px;color:#0f172a;">{wf_name}</td>
                  </tr></table>
                </td>
                <td style="padding:11px 16px;border-bottom:1px solid #f1f5f9;font-family:'Segoe UI',Arial,sans-serif;font-size:13px;color:#64748b;word-break:break-all;">{wf_id}</td>
                <td style="padding:11px 16px;border-bottom:1px solid #f1f5f9;font-family:'Segoe UI',Arial,sans-serif;font-size:13px;color:#64748b;white-space:nowrap;">{failed_at}</td>
              </tr>"""

    if not rows_html:
        rows_html = """
              <tr>
                <td colspan="3" style="padding:28px 16px;text-align:center;font-family:'Segoe UI',Arial,sans-serif;font-size:13px;color:#94a3b8;">
                  No failures detected in this window
                </td>
              </tr>"""

    # ── "View all failures" row ───────────────────────────────────────────────
    view_all_row = ""
    if deep_link:
        dl_esc = _html_escape(deep_link)
        view_all_row = f"""
              <tr>
                <td colspan="3" style="padding:13px 16px;">
                  <a href="{dl_esc}" style="font-family:'Segoe UI',Arial,sans-serif;font-size:13px;color:#4f46e5;text-decoration:none;font-weight:500;">&#8599; View all failures</a>
                </td>
              </tr>"""

    _anim_style = (
        "<style>"
        "@keyframes sevaRing{"
        "0%{box-shadow:0 0 0 0px rgba(220,38,38,0.30);transform:scale(1)}"
        "55%{box-shadow:0 0 0 18px rgba(220,38,38,0);transform:scale(1.06)}"
        "100%{box-shadow:0 0 0 0px rgba(220,38,38,0);transform:scale(1)}"
        "}"
        "@keyframes sevaShake{"
        "0%,100%{transform:translateY(0)}"
        "20%{transform:translateY(-4px)}"
        "40%{transform:translateY(2px)}"
        "60%{transform:translateY(-2px)}"
        "80%{transform:translateY(1px)}"
        "}"
        ".seva-icon{display:inline-block;border-radius:50%;animation:sevaRing 2.2s ease-out infinite}"
        ".seva-bang{display:inline-block;animation:sevaShake 2.2s ease-in-out 0.4s infinite}"
        "</style>"
    )

    return f"""<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">{_anim_style}</head>
<body style="margin:0;padding:0;background:#f1f5f9;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f1f5f9;padding:32px 0;">
  <tr><td align="center" style="padding:0 16px;">

    <table width="620" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(15,23,42,0.10);">

      <!-- ── Header: shield + title — skyline is CSS background so it sits BEHIND the text ── -->
      <tr>
        <td align="center" style="padding:44px 32px 40px;background-color:#ffffff;{sky_bg_css}">

          <!-- Shield: animated pulse ring + shake on ! -->
          <div class="seva-icon" style="display:inline-block;border-radius:50%;margin:0 auto 14px auto;">
          <table cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td align="center" valign="middle" style="width:72px;height:72px;border-radius:50%;background:#fef2f2;border:2px solid #fecaca;">
                <table cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;">
                  <tr>
                    <td align="center" valign="middle" style="width:40px;height:46px;background:#dc2626;border-radius:7px 7px 4px 4px;font-family:Georgia,serif;font-size:28px;font-weight:900;color:#ffffff;line-height:46px;"><span class="seva-bang" style="display:inline-block;">!</span></td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
          </div>

          <!-- SEVERITY A ALERT label -->
          <p style="margin:0 0 8px;font-family:'Segoe UI',Arial,sans-serif;font-size:11px;font-weight:700;letter-spacing:2.5px;color:#dc2626;text-transform:uppercase;">Severity A Alert</p>

          <!-- Title -->
          <h1 style="margin:0 0 18px;font-family:'Segoe UI',Arial,sans-serif;font-size:26px;font-weight:800;color:#0f172a;letter-spacing:-0.5px;">Sev A failure for {t_esc}</h1>

          <!-- Meta row -->
          <table cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;">
            <tr>
              <td style="padding:0 14px;font-family:'Segoe UI',Arial,sans-serif;font-size:13px;color:#64748b;">
                Environment: <strong style="color:#dc2626;">{_html_escape(env_label)}</strong>
              </td>
              <td style="color:#cbd5e1;font-size:18px;vertical-align:middle;padding:0 2px;">|</td>
              <td style="padding:0 14px;font-family:'Segoe UI',Arial,sans-serif;font-size:13px;color:#64748b;">
                <strong style="color:#0f172a;">{total}</strong> {_html_escape(noun)} detected
              </td>
            </tr>
          </table>

        </td>
      </tr>

      <!-- ── Failure table ── -->
      <tr>
        <td style="padding:20px 24px 8px;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;">

            <tr style="background:#f8fafc;">
              <td style="padding:12px 16px;border-bottom:1px solid #e2e8f0;width:38%;font-family:'Segoe UI',Arial,sans-serif;font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.7px;">Workflow Name</td>
              <td style="padding:12px 16px;border-bottom:1px solid #e2e8f0;font-family:'Segoe UI',Arial,sans-serif;font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.7px;">Workflow ID</td>
              <td style="padding:12px 16px;border-bottom:1px solid #e2e8f0;font-family:'Segoe UI',Arial,sans-serif;font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.7px;white-space:nowrap;">Failed At</td>
            </tr>

{rows_html}
{view_all_row}

          </table>
        </td>
      </tr>

      <!-- ── Footer ── -->
      <tr>
        <td style="padding:16px 24px 20px;border-top:1px solid #f1f5f9;text-align:center;">
          <p style="margin:0;font-family:'Segoe UI',Arial,sans-serif;font-size:11px;color:#94a3b8;">Jiffy AI Monitoring &nbsp;·&nbsp; Severity A Alert</p>
        </td>
      </tr>

    </table>
  </td></tr>
</table>
</body>
</html>"""


def _build_sev_a_plain_body(tenant: str, envs: list[str], day_execs: list[dict],
                            deep_link: str = "") -> str:
    """Plain-text fallback for the Sev A email."""
    env_label = ", ".join(envs) if envs else "—"
    lines = [
        "SEVERITY A ALERT",
        f"Sev A failure for {tenant}",
        f"Environment: {env_label}",
        f"",
        f"Failed workflows ({len(day_execs)} total):",
        "─" * 50,
    ]
    for ex in day_execs[:50]:
        wf_name   = str(ex.get("process_name") or ex.get("workflow_name") or "—")
        wf_id     = str(ex.get("workflow_id") or "—")
        failed_at = _fmt_iso_for_email(ex.get("start_time") or ex.get("end_time"))
        lines.append(f"  {wf_name}")
        lines.append(f"    ID:   {wf_id}")
        lines.append(f"    Time: {failed_at}")
        lines.append("")
    if not day_execs:
        lines.append("  No failures detected in this window.")
    if deep_link:
        lines += ["", f"View all failures: {deep_link}"]
    return "\n".join(lines)


def _build_html_body(tenant: str, envs: list[str], window_minutes: int,
                     now_iso: str, triggered: list[dict], deep_link: str = "#",
                     day_execs: list[dict] | None = None) -> str:
    """Build the report-style HTML email. Layout uses tables (email-safe)
    with inline styles. Mirrors the JIFFY AI Workflow Monitoring Report
    template the user shared."""
    env_label = ", ".join(e.upper() for e in envs) if envs else "—"

    # Pull together executions across all workflow_failed conditions for the
    # categorization chart + recent-failures list.
    all_execs: list[dict] = []
    wf_total_new = 0
    wf_threshold = 0
    for t in triggered:
        if t.get("condition_key") == "workflow_failed":
            all_execs.extend(t.get("new_executions") or [])
            wf_total_new += int(t.get("count") or 0)
            wf_threshold = t.get("threshold", wf_threshold)

    # ── Top header banner (JIFFY AI) ─────────────────────────────────────
    header = """
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#1a1a1a;border-radius:10px 10px 0 0;">
      <tr><td style="padding:12px 20px;">
        <span style="font-family:'Segoe UI',Arial,sans-serif;font-weight:700;font-size:16px;letter-spacing:1px;">
          <span style="color:#ffffff;">JIFFY</span><span style="color:#d4a017;">AI</span>
        </span>
      </td></tr>
    </table>
    """

    # ── Hero title + big stat ────────────────────────────────────────────
    hero = f"""
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;padding:18px 22px 6px;">
      <tr>
        <td>
          <h1 style="margin:0;font-family:'Segoe UI',Arial,sans-serif;font-weight:700;font-size:20px;color:#1f2937;line-height:1.2;">
            Workflow Monitoring Report
          </h1>
          <div style="height:2px;width:54px;background:#d4a017;margin-top:6px;margin-bottom:6px;"></div>
          <p style="margin:0;color:#6b7280;font-size:12px;font-family:Arial,sans-serif;">
            Your automated workflow failure summary and insights
          </p>
        </td>
      </tr>
    </table>

    <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;padding:8px 22px 12px;">
      <tr>
        <td align="center">
          <div style="display:inline-block;vertical-align:middle;width:34px;height:34px;background:#dc2626;border-radius:50%;text-align:center;line-height:34px;">
            <span style="color:#ffffff;font-size:18px;font-weight:700;font-family:Arial,sans-serif;">!</span>
          </div>
          <div style="display:inline-block;vertical-align:middle;margin-left:10px;text-align:left;">
            <div style="font-size:18px;font-weight:700;color:#dc2626;font-family:Arial,sans-serif;line-height:1.2;">
              {wf_total_new} <span style="color:#1f2937;">Workflow Failure{'' if wf_total_new == 1 else 's'} Detected</span>
            </div>
            <div style="font-size:11px;color:#6b7280;margin-top:2px;font-family:Arial,sans-serif;">
              in {_html_escape(env_label)} during the last {window_minutes} minutes
            </div>
          </div>
        </td>
      </tr>
    </table>
    """

    # ── 4-card stat strip ────────────────────────────────────────────────
    def _card(icon_bg: str, icon_fg: str, icon: str, label: str, value: str, value_color: str, sub: str = "") -> str:
        return f"""
        <td width="25%" valign="top" style="padding:4px;">
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border:1px solid #eef0f5;border-radius:10px;">
            <tr><td align="center" style="padding:8px 4px;">
              <div style="display:inline-block;width:26px;height:26px;border-radius:50%;background:{icon_bg};color:{icon_fg};line-height:26px;font-size:13px;font-weight:700;font-family:Arial,sans-serif;">{icon}</div>
              <div style="font-size:10px;color:#6b7280;margin-top:4px;font-family:Arial,sans-serif;">{label}</div>
              <div style="font-size:14px;font-weight:700;color:{value_color};margin-top:2px;font-family:Arial,sans-serif;">{_html_escape(value)}</div>
              {f'<div style="font-size:9px;color:#9ca3af;margin-top:2px;font-family:Arial,sans-serif;">{_html_escape(sub)}</div>' if sub else ''}
            </td></tr>
          </table>
        </td>
        """

    stats = f"""
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;padding:0 16px 10px;">
      <tr>
        {_card('#fee2e2', '#dc2626', '!',  'Failed Workflows', str(wf_total_new), '#dc2626', f'Threshold: {wf_threshold:g}')}
        {_card('#dcfce7', '#16a34a', '🏢', 'Tenant',           tenant or '—',     '#16a34a')}
        {_card('#dbeafe', '#2563eb', '🗄', 'Environment',     env_label,         '#2563eb')}
        {_card('#fef3c7', '#d97706', '⏱', 'Time Window',     f'Last {window_minutes} Min', '#d97706')}
      </tr>
    </table>
    """

    # ── Total Workflow Failures ───────────────────────────────────────────
    # Aggregates day_execs (or window-scoped fallback) by (app_name, env)
    # so the recipient can see which apps to investigate without scanning
    # individual workflow IDs.
    dist_execs = day_execs if day_execs is not None else all_execs
    apps_rollup: dict[tuple, dict] = {}
    for ex in dist_execs:
        app_name  = ex.get("app_display_name") or ex.get("app_name") or "—"
        env_tag   = ex.get("_env") or (envs[0] if envs else "")
        key       = (app_name, env_tag)
        b = apps_rollup.setdefault(key, {"app": app_name, "env": env_tag, "count": 0})
        b["count"] += 1
    apps_rows_list = sorted(apps_rollup.values(), key=lambda r: r["count"], reverse=True)
    if apps_rows_list:
        apps_rows_html = "".join([
            f"""
            <tr>
              <td style="padding:6px 12px;border-bottom:1px solid #f3f4f6;font-size:12px;color:#1f2937;font-family:Arial,sans-serif;">
                <span style="font-weight:700;">{_html_escape(r['app'])}</span>
                <span style="color:#9ca3af;margin-left:6px;">{_html_escape(r['env'])}</span>
              </td>
              <td align="right" style="padding:6px 12px;border-bottom:1px solid #f3f4f6;font-size:12px;color:#dc2626;font-weight:700;font-family:Arial,sans-serif;">{r['count']}</td>
            </tr>
            """ for r in apps_rows_list
        ])
        apps_section = f"""
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;padding:0 22px 6px;">
          <tr><td>
            <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #eef0f5;border-radius:10px;">
              <tr>
                <td style="padding:10px 14px 4px;font-weight:700;color:#1f2937;font-size:12px;font-family:Arial,sans-serif;">Total Workflow Failures <span style="font-weight:500;color:#9ca3af;font-size:11px;">· today (12 AM IST → now)</span></td>
                <td align="right" style="padding:10px 14px 4px;font-weight:500;color:#9ca3af;font-size:11px;font-family:Arial,sans-serif;">{len(apps_rows_list)} app{'s' if len(apps_rows_list) != 1 else ''}</td>
              </tr>
              {apps_rows_html}
            </table>
          </td></tr>
        </table>
        """
    else:
        apps_section = ""

    # ── Current failures (rule window) — live per-app rollup ─────────────
    live_apps_rollup: dict[tuple, dict] = {}
    for ex in all_execs:
        app_name = ex.get("app_display_name") or ex.get("app_name") or "—"
        env_tag = ex.get("_env") or (envs[0] if envs else "")
        key = (app_name, env_tag)
        b = live_apps_rollup.setdefault(key, {"app": app_name, "env": env_tag, "count": 0})
        b["count"] += 1
    live_apps_rows_list = sorted(live_apps_rollup.values(), key=lambda r: r["count"], reverse=True)
    if live_apps_rows_list:
        live_apps_rows_html = "".join([
            f"""
            <tr>
              <td style="padding:6px 12px;border-bottom:1px solid #f3f4f6;font-size:12px;color:#1f2937;font-family:Arial,sans-serif;">
                <span style="font-weight:700;">{_html_escape(r['app'])}</span>
                <span style="color:#9ca3af;margin-left:6px;">{_html_escape(r['env'])}</span>
              </td>
              <td align="right" style="padding:6px 12px;border-bottom:1px solid #f3f4f6;font-size:12px;color:#dc2626;font-weight:700;font-family:Arial,sans-serif;">{r['count']}</td>
            </tr>
            """ for r in live_apps_rows_list
        ])
        live_apps_section = f"""
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;padding:0 22px 6px;">
          <tr><td>
            <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #eef0f5;border-radius:10px;">
              <tr>
                <td style="padding:10px 14px 4px;font-weight:700;color:#1f2937;font-size:12px;font-family:Arial,sans-serif;">Current failures <span style="font-weight:500;color:#9ca3af;font-size:11px;">· last {window_minutes} minutes</span></td>
                <td align="right" style="padding:10px 14px 4px;font-weight:500;color:#9ca3af;font-size:11px;font-family:Arial,sans-serif;">{len(live_apps_rows_list)} app{'s' if len(live_apps_rows_list) != 1 else ''}</td>
              </tr>
              {live_apps_rows_html}
            </table>
          </td></tr>
        </table>
        """
    else:
        live_apps_section = ""

    # ── Recent Failed Workflows list ─────────────────────────────────────
    def _wf_row(ex: dict) -> str:
        wf_id      = ex.get("workflow_id") or ex.get("workflowId") or "—"
        wf_name    = ex.get("process_name") or ex.get("workflow_name") or ""
        app_label  = ex.get("app_display_name") or ex.get("app_name")
        err        = ex.get("error_message") or ex.get("exception") or ex.get("root_cause") or "Failure"
        err_short  = (err if len(err) <= 80 else err[:77] + "…")
        ts         = _fmt_iso_for_email(ex.get("start_time"))
        app_chip   = (
            f'<span style="display:inline-block;background:#eef2ff;color:#3730a3;border-radius:4px;padding:1px 6px;font-size:10px;font-weight:600;margin-right:6px;vertical-align:middle;">{_html_escape(app_label)}</span>'
            if app_label else ''
        )
        # Show workflow name as the primary title; ID as a smaller sub-line
        name_html  = f'<span style="font-weight:700;color:#1f2937;font-size:12px;">{_html_escape(wf_name)}</span>' if wf_name else ""
        id_html    = f'<span style="color:#6b7280;font-size:10px;font-family:monospace;">{_html_escape(wf_id)}</span>'
        title_line = f"{app_chip}{name_html}" if wf_name else f"{app_chip}{id_html}"
        sub_line   = f'<div style="color:#6b7280;font-size:10px;font-family:Arial,sans-serif;margin-top:1px;">{id_html}</div>' if wf_name else ""
        return f"""
        <tr>
          <td style="padding:6px 12px;border-bottom:1px solid #f3f4f6;vertical-align:middle;">
            <table cellpadding="0" cellspacing="0">
              <tr>
                <td width="26" valign="middle">
                  <div style="width:18px;height:18px;border-radius:50%;background:#fee2e2;color:#dc2626;line-height:18px;text-align:center;font-weight:700;font-family:Arial,sans-serif;font-size:11px;">!</div>
                </td>
                <td valign="middle">
                  <div style="font-family:Arial,sans-serif;">{title_line}</div>
                  {sub_line}
                  <div style="color:#dc2626;font-size:11px;font-family:Arial,sans-serif;margin-top:1px;">Error: {_html_escape(err_short)}</div>
                </td>
              </tr>
            </table>
          </td>
          <td align="right" style="padding:6px 12px;border-bottom:1px solid #f3f4f6;color:#6b7280;font-size:11px;font-family:Arial,sans-serif;white-space:nowrap;vertical-align:middle;">⏱ {ts}</td>
        </tr>
        """

    recent_rows = "".join(_wf_row(ex) for ex in all_execs[:5])
    if recent_rows:
        # Format the "report date" header line from now_iso
        try:
            dt = datetime.fromisoformat(str(now_iso).replace("Z", "+00:00"))
            date_header = dt.strftime("%B %d, %Y")
        except Exception:
            date_header = ""
        recent_section = f"""
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;padding:0 22px 6px;">
          <tr><td>
            <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #eef0f5;border-radius:10px;">
              <tr>
                <td style="padding:10px 14px 4px;font-weight:700;color:#1f2937;font-size:12px;font-family:Arial,sans-serif;">Recent Failed Workflows</td>
                <td align="right" style="padding:10px 14px 4px;color:#6b7280;font-size:11px;font-family:Arial,sans-serif;">📅 {date_header}</td>
              </tr>
              {recent_rows}
            </table>
          </td></tr>
        </table>
        """
    else:
        recent_section = ""

    # ── CTA + footer ─────────────────────────────────────────────────────
    cta_footer = f"""
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;padding:10px 22px 14px;">
      <tr><td align="center">
        <a href="{_html_escape(deep_link)}" style="display:inline-block;background:#1f2937;color:#ffffff;text-decoration:none;font-weight:700;font-family:Arial,sans-serif;font-size:12px;padding:8px 18px;border-radius:8px;">
          📊  View Full Dashboard
        </a>
      </td></tr>
    </table>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border-radius:0 0 10px 10px;padding:10px 18px;">
      <tr><td align="center" style="color:#6b7280;font-size:11px;font-family:Arial,sans-serif;">
        🛡  Generated automatically by JiffyAI Monitoring Service<br/>
        <span style="color:#9ca3af;">Evaluated at: {_fmt_iso_full(now_iso)}</span>
      </td></tr>
    </table>
    """

    # ── Optional: also list non-workflow conditions that fired (5xx etc.)
    other_conds = [t for t in triggered if t.get("condition_key") != "workflow_failed"]
    other_rows = ""
    if other_conds:
        rows = "".join([
            f"""
            <tr>
              <td style="padding:8px 14px;border-bottom:1px solid #f3f4f6;color:#1f2937;font-size:13px;font-family:Arial,sans-serif;">
                <strong>[{_html_escape(t.get('env',''))}] {_html_escape(t['condition_label'])}</strong>
              </td>
              <td align="right" style="padding:8px 14px;border-bottom:1px solid #f3f4f6;color:#dc2626;font-weight:700;font-family:Arial,sans-serif;font-size:13px;">
                { (f"{t['rate']:.2f}%" if t['condition_key']=='error_rate' else str(t.get('count',0))) }
                <span style="color:#9ca3af;font-weight:400;"> (threshold {t['threshold']:g}{'%' if t['condition_key']=='error_rate' else ''})</span>
              </td>
            </tr>
            """ for t in other_conds
        ])
        other_rows = f"""
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;padding:0 28px 16px;">
          <tr><td>
            <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #eef0f5;border-radius:12px;">
              <tr><td style="padding:14px 14px 6px;font-weight:700;color:#1f2937;font-size:14px;font-family:Arial,sans-serif;">Other Triggered Conditions</td></tr>
              {rows}
            </table>
          </td></tr>
        </table>
        """

    return f"""<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#eef1f4;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#eef1f4;padding:14px 0;">
    <tr><td align="center">
      <table width="520" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:10px;overflow:hidden;box-shadow:0 3px 12px rgba(0,0,0,0.06);">
        <tr><td>{header}</td></tr>
        <tr><td>{hero}</td></tr>
        <tr><td>{stats}</td></tr>
        <tr><td>{apps_section}</td></tr>
        <tr><td>{live_apps_section}</td></tr>
        <tr><td>{recent_section}</td></tr>
        <tr><td>{other_rows}</td></tr>
        <tr><td>{cta_footer}</td></tr>
      </table>
    </td></tr>
  </table>
</body></html>
"""


def evaluate_rule_now(rule_id: str) -> dict:
    """Evaluate a single rule (kept around for future per-card 'Test' button)."""
    db = get_db()
    try:
        oid = ObjectId(rule_id)
    except Exception:
        return {"error": "invalid rule id"}
    rule = db["alert_rules"].find_one({"_id": oid})
    if not rule:
        return {"error": "rule not found"}
    smtp_doc = load_smtp_config()
    now_iso = datetime.now(timezone.utc).isoformat()
    return _evaluate_one_rule(db, rule, smtp_doc, now_iso)
