"""
Scheduled job: run due API Monitor cron jobs and send failure alerts via SMTP.
Registered in main.py on a 1-minute APScheduler interval.
"""
import json
import logging
import urllib.request
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage

from bson import ObjectId

from database import get_db
from routers.api_monitor import _run_newman
from routers.support import load_smtp_config, send_via_smtp

log = logging.getLogger(__name__)

CRONS_COLL = "api_monitor_crons"
API_COLL   = "api_monitor_collections"
RUNS_COLL  = "api_monitor_cron_runs"

# All user-facing times (window, daily, weekly) are in IST (UTC+5:30)
IST_OFFSET = timedelta(hours=5, minutes=30)


def _parse_hhmm(t: str):
    """Return (hour, minute) from 'HH:MM', or (0, 0) on error."""
    try:
        h, m = map(int, t.split(":"))
        return h, m
    except Exception:
        return 0, 0


def _to_ist(dt_utc: datetime) -> datetime:
    return dt_utc + IST_OFFSET


def _ist_display(iso_str: str) -> str:
    """Format a UTC ISO string as a human-readable IST timestamp."""
    try:
        dt = datetime.fromisoformat(iso_str.replace("Z", "+00:00"))
        ist = dt + IST_OFFSET
        return ist.strftime("%d %b %Y, %I:%M %p IST")
    except Exception:
        return iso_str


def _in_window(dt_utc: datetime, window_start_ist: str, window_end_ist: str) -> bool:
    """True if dt_utc falls inside the IST window [window_start, window_end). Supports overnight."""
    dt_ist  = _to_ist(dt_utc)
    sh, sm  = _parse_hhmm(window_start_ist)
    eh, em  = _parse_hhmm(window_end_ist)
    now_m   = dt_ist.hour * 60 + dt_ist.minute
    start_m = sh * 60 + sm
    end_m   = eh * 60 + em
    if start_m == end_m:
        return True
    if start_m < end_m:
        return start_m <= now_m < end_m
    # Overnight (e.g. 17:30 IST → 05:30 IST)
    return now_m >= start_m or now_m < end_m


def _next_window_start(from_dt_utc: datetime, window_start_ist: str) -> datetime:
    """Return the next UTC datetime when the IST window opens, strictly after from_dt_utc."""
    from_ist = _to_ist(from_dt_utc)
    sh, sm   = _parse_hhmm(window_start_ist)
    candidate_ist = from_ist.replace(hour=sh, minute=sm, second=0, microsecond=0)
    if candidate_ist <= from_ist:
        candidate_ist += timedelta(days=1)
    return candidate_ist - IST_OFFSET  # convert back to UTC


def _compute_next_run(schedule: dict, from_dt: datetime) -> datetime:
    """All HH:MM values in schedule are IST; from_dt and return value are UTC."""
    stype = schedule.get("type")

    if stype == "interval":
        mins         = int(schedule.get("interval_minutes") or 60)
        window_start = schedule.get("window_start")
        window_end   = schedule.get("window_end")
        next_dt      = from_dt + timedelta(minutes=mins)

        if window_start and window_end:
            if _in_window(next_dt, window_start, window_end):
                return next_dt
            return _next_window_start(next_dt, window_start)

        return next_dt

    # daily / weekly — time is IST, convert to UTC for storage
    time_str = schedule.get("time") or "00:00"
    hh, mm   = _parse_hhmm(time_str)

    if stype == "daily":
        from_ist      = _to_ist(from_dt)
        candidate_ist = from_ist.replace(hour=hh, minute=mm, second=0, microsecond=0)
        if candidate_ist <= from_ist:
            candidate_ist += timedelta(days=1)
        return candidate_ist - IST_OFFSET

    if stype == "weekly":
        days     = schedule.get("days") or [0]
        from_ist = _to_ist(from_dt)
        for offset in range(1, 8):
            cand_ist = from_ist + timedelta(days=offset)
            cand_ist = cand_ist.replace(hour=hh, minute=mm, second=0, microsecond=0)
            if cand_ist.weekday() in days and cand_ist > from_ist:
                return cand_ist - IST_OFFSET
        return from_dt + timedelta(days=7)

    return from_dt + timedelta(hours=1)


def _fmt_duration(ms: int) -> str:
    if not ms:
        return "—"
    if ms >= 60_000:
        m, s = divmod(ms // 1000, 60)
        return f"{m}m {s}s"
    if ms >= 1000:
        return f"{ms / 1000:.1f}s"
    return f"{ms} ms"


def _send_cron_report(cron: dict, col_name: str, run_summary: dict, failures_only: bool) -> None:
    smtp_doc = load_smtp_config()
    if not smtp_doc:
        log.warning("Cron report skipped — no SMTP config")
        return

    all_results  = run_summary.get("results", [])
    failures     = [r for r in all_results if not r["passed"]]
    rows_to_show = failures if failures_only else all_results

    recipients = list({smtp_doc["to_email"]} | set(cron.get("alert_emails") or []))
    ran_at  = _ist_display(run_summary.get("ran_at", ""))
    total   = run_summary.get("total", 0)
    passed  = run_summary.get("passed", 0)
    failed  = run_summary.get("failed", 0)
    dur_str = _fmt_duration(run_summary.get("duration_ms") or 0)

    all_ok = failed == 0

    if failures_only:
        subject      = f"API Monitor: {failed} failure{'s' if failed != 1 else ''} in \"{col_name}\" [{cron['name']}]"
        subtitle     = f"{failed} API{'s' if failed != 1 else ''} did not match the expected status."
        hero_color   = "#dc2626"
        hero_bg      = "#fee2e2"
        hero_symbol  = "&#10007;"
        status_label = "FAILED"
    else:
        status_word  = "All passed" if all_ok else f"{failed} failed"
        subject      = f"API Monitor run report: {status_word} — \"{col_name}\" [{cron['name']}]"
        subtitle     = "All API checks passed successfully." if all_ok else f"{failed} API{'s' if failed != 1 else ''} did not match the expected status."
        hero_color   = "#16a34a" if all_ok else "#dc2626"
        hero_bg      = "#dcfce7" if all_ok else "#fee2e2"
        hero_symbol  = "&#10003;" if all_ok else "&#10007;"
        status_label = "PASSED" if all_ok else "FAILED"

    # Table rows — cap at 8 for "always", show all for "on_failure"
    MAX_ROWS   = 8 if not failures_only else len(rows_to_show)
    visible    = rows_to_show[:MAX_ROWS]
    more_count = len(rows_to_show) - MAX_ROWS

    rows_html = ""
    for idx, r in enumerate(visible, 1):
        ok         = r.get("passed", False)
        status     = str(r.get("status") or "—")
        reason     = (r.get("failure_reason") or "—")[:200] if not ok else "—"
        resp_time  = _fmt_duration(r.get("duration_ms") or 0)
        row_bg     = "#ffffff" if ok else "#fff5f5"
        icon_bg    = "#16a34a" if ok else "#dc2626"
        icon_sym   = "&#10003;" if ok else "&#10007;"
        pill_bg    = "#dcfce7" if ok else "#fee2e2"
        pill_color = "#16a34a" if ok else "#dc2626"
        rows_html += f"""
      <tr style="background:{row_bg};border-bottom:1px solid #f1f5f9">
        <td style="padding:12px 14px;text-align:center;color:#9ca3af;font-size:12px">{idx}</td>
        <td style="padding:12px 14px">
          <span style="display:inline-block;width:20px;height:20px;border-radius:50%;background:{icon_bg};color:#fff;text-align:center;font-size:11px;font-weight:700;line-height:20px;vertical-align:middle;margin-right:8px">{icon_sym}</span>
          <span style="font-size:13px;color:#0f172a;vertical-align:middle">{r['name']}</span>
        </td>
        <td style="padding:12px 14px;text-align:center">
          <span style="display:inline-block;padding:3px 12px;border-radius:6px;background:{pill_bg};color:{pill_color};font-size:12px;font-weight:700;border:1px solid {pill_color}44">{status}</span>
        </td>
        <td style="padding:12px 14px;color:#6b7280;font-size:12px">{resp_time}</td>
        <td style="padding:12px 14px;color:#6b7280;font-size:12px">{reason}</td>
      </tr>"""

    # Bottom row: "...and N more" / "All passed" banner
    if more_count > 0:
        right_text  = "All passed successfully &#127881;" if all_ok else f"{failed} total failure{'s' if failed != 1 else ''}"
        right_color = "#16a34a" if all_ok else "#dc2626"
        bottom_row  = f"""
      <tr style="border-top:1px solid #e5e7eb;background:#fafafa">
        <td colspan="3" style="padding:12px 14px;color:#9ca3af;font-size:12px">
          <span style="font-size:16px;vertical-align:middle;margin-right:6px">&#8943;</span>
          <span style="vertical-align:middle">... and {more_count} more API{'s' if more_count != 1 else ''}</span>
        </td>
        <td colspan="2" style="padding:12px 14px;text-align:right;color:{right_color};font-size:13px;font-weight:700">{right_text}</td>
      </tr>"""
    elif all_ok and not failures_only:
        bottom_row = f"""
      <tr style="border-top:1px solid #e5e7eb;background:#fafafa">
        <td colspan="5" style="padding:12px 14px;text-align:right;color:#16a34a;font-size:13px;font-weight:700">All passed successfully &#127881;</td>
      </tr>"""
    else:
        bottom_row = ""

    html = f"""
<html>
<body style="margin:0;padding:0;background:#ffffff;font-family:'Segoe UI',Arial,sans-serif">
<div style="width:100%;background:#fff;overflow:hidden">

  <!-- Header -->
  <table width="100%" cellpadding="0" cellspacing="0" style="border-bottom:1px solid #f1f5f9">
    <tr>
      <td style="padding:24px 28px;vertical-align:middle">
        <table cellpadding="0" cellspacing="0">
          <tr>
            <td style="vertical-align:middle;padding-right:16px">
              <div style="width:64px;height:64px;border-radius:16px;background:#ede9fe;text-align:center;line-height:64px;font-size:28px">&#9729;</div>
            </td>
            <td style="vertical-align:middle">
              <div style="font-size:22px;font-weight:800;color:#0f172a;letter-spacing:-0.5px">API Monitor Run Report</div>
              <div style="font-size:13px;color:#6b7280;margin-top:3px">{subtitle}</div>
            </td>
          </tr>
        </table>
      </td>
      <td style="padding:24px 28px;vertical-align:middle;text-align:right;white-space:nowrap;color:#6b7280;font-size:12px">
        &#128197; {ran_at}
      </td>
    </tr>
  </table>

  <!-- Stats -->
  <div style="background:#f8fafc;padding:24px 28px;border-bottom:1px solid #e5e7eb">
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="vertical-align:middle;padding-right:28px">
          <table cellpadding="0" cellspacing="0">
            <tr>
              <td style="vertical-align:middle;padding-right:16px">
                <div style="width:72px;height:72px;border-radius:50%;background:{hero_bg};text-align:center;line-height:72px;font-size:30px;font-weight:900;color:{hero_color}">{hero_symbol}</div>
              </td>
              <td style="vertical-align:middle">
                <div style="font-size:34px;font-weight:900;color:{hero_color};line-height:1">{passed}/{total}</div>
                <div style="font-size:13px;font-weight:800;color:{hero_color};margin-top:2px">{status_label}</div>
                <div style="font-size:11px;color:#6b7280;margin-top:4px;max-width:140px">{subtitle}</div>
              </td>
            </tr>
          </table>
        </td>
        <td style="border-left:1px solid #e5e7eb;padding:0 28px;text-align:center;vertical-align:middle">
          <div style="font-size:20px;margin-bottom:4px">&#128230;</div>
          <div style="font-size:24px;font-weight:800;color:#0f172a">{total}</div>
          <div style="font-size:11px;color:#6b7280;margin-top:2px">Total API</div>
        </td>
        <td style="border-left:1px solid #e5e7eb;padding:0 28px;text-align:center;vertical-align:middle">
          <div style="font-size:20px;margin-bottom:4px">&#9989;</div>
          <div style="font-size:24px;font-weight:800;color:#16a34a">{passed}</div>
          <div style="font-size:11px;color:#6b7280;margin-top:2px">Passed</div>
        </td>
        <td style="border-left:1px solid #e5e7eb;padding:0 28px;text-align:center;vertical-align:middle">
          <div style="font-size:20px;margin-bottom:4px">&#10060;</div>
          <div style="font-size:24px;font-weight:800;color:#dc2626">{failed}</div>
          <div style="font-size:11px;color:#6b7280;margin-top:2px">Failed</div>
        </td>
        <td style="border-left:1px solid #e5e7eb;padding:0 0 0 28px;text-align:center;vertical-align:middle">
          <div style="font-size:20px;margin-bottom:4px">&#9201;</div>
          <div style="font-size:20px;font-weight:800;color:#0f172a">{dur_str}</div>
          <div style="font-size:11px;color:#6b7280;margin-top:2px">Total Duration</div>
        </td>
      </tr>
    </table>
  </div>

  <!-- Cron + Collection -->
  <table width="100%" cellpadding="0" cellspacing="0" style="border-bottom:1px solid #f1f5f9">
    <tr>
      <td style="padding:16px 28px;width:50%;vertical-align:middle">
        <table cellpadding="0" cellspacing="0">
          <tr>
            <td style="padding-right:10px;font-size:20px;vertical-align:middle">&#128451;</td>
            <td style="vertical-align:middle">
              <div style="font-size:10px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.06em;font-weight:600">Cron</div>
              <div style="font-size:14px;font-weight:700;color:#0f172a;margin-top:2px">{cron['name']}</div>
            </td>
          </tr>
        </table>
      </td>
      <td style="border-left:1px solid #e5e7eb;padding:16px 28px;vertical-align:middle">
        <table cellpadding="0" cellspacing="0">
          <tr>
            <td style="padding-right:10px;font-size:20px;vertical-align:middle">&#128193;</td>
            <td style="vertical-align:middle">
              <div style="font-size:10px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.06em;font-weight:600">Collection</div>
              <div style="font-size:13px;font-weight:600;color:#0f172a;margin-top:2px">{col_name}</div>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>

  <!-- API Table -->
  <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
    <thead>
      <tr style="background:#4f46e5">
        <th style="padding:12px 14px;color:#fff;font-size:11px;font-weight:700;text-align:center;width:48px">#</th>
        <th style="padding:12px 14px;color:#fff;font-size:11px;font-weight:700;text-align:left">API</th>
        <th style="padding:12px 14px;color:#fff;font-size:11px;font-weight:700;text-align:center">Status</th>
        <th style="padding:12px 14px;color:#fff;font-size:11px;font-weight:700;text-align:left">Response Time</th>
        <th style="padding:12px 14px;color:#fff;font-size:11px;font-weight:700;text-align:left">Failure Reason</th>
      </tr>
    </thead>
    <tbody>
      {rows_html}
      {bottom_row}
    </tbody>
  </table>

  <!-- Footer -->
  <div style="padding:14px 28px;background:#f8fafc;border-top:1px solid #e5e7eb">
    <span style="font-size:14px;color:#6366f1;vertical-align:middle;margin-right:6px">&#9432;</span>
    <span style="font-size:12px;color:#6b7280;vertical-align:middle">This is an automated report generated by Postman Monitor.</span>
  </div>

</div>
</body>
</html>
"""

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"]    = smtp_doc["from_email"]
    msg["To"]      = ", ".join(recipients)
    msg.set_content(
        f"API Monitor cron '{cron['name']}': {passed}/{total} passed"
        + (f", {failed} failed" if failed else "") + f" — {col_name}"
    )
    msg.add_alternative(html, subtype="html")

    try:
        send_via_smtp(msg, smtp_doc)
        log.info("Cron report sent for '%s': %d/%d passed", cron["name"], passed, total)
    except Exception:
        log.exception("Failed to send cron report for '%s'", cron["name"])


def _resolve_cron_teams_url(cron: dict, db) -> str | None:
    """Return the Teams webhook URL for a cron, resolving by ID if set."""
    webhook_id = cron.get("teams_webhook_id")
    if webhook_id:
        try:
            doc = db["teams_webhooks"].find_one({"_id": ObjectId(webhook_id)})
            if doc:
                return doc["url"]
        except Exception:
            pass
    return cron.get("teams_webhook")  # backward compat


def _send_cron_teams_alert(cron: dict, col_name: str, run_summary: dict, webhook_url: str) -> None:
    failures  = [r for r in run_summary.get("results", []) if not r["passed"]]
    tenant    = cron.get("tenant", "")
    cron_name = cron.get("name", "")
    ran_at    = run_summary.get("ran_at", "")
    total     = run_summary.get("total", 0)
    failed    = run_summary.get("failed", 0)
    passed    = run_summary.get("passed", 0)

    body: list = [
        {
            "type": "TextBlock",
            "text": f"🔴 API Monitor alert — {cron_name}",
            "size": "Large", "weight": "Bolder", "color": "Attention",
        },
        {
            "type": "FactSet",
            "facts": [
                {"title": "Tenant",     "value": tenant},
                {"title": "Collection", "value": col_name},
                {"title": "Total",      "value": str(total)},
                {"title": "Failed",     "value": str(failed)},
                {"title": "Passed",     "value": str(passed)},
                {"title": "Ran at",     "value": ran_at},
            ],
        },
    ]

    if failures:
        body.append({
            "type": "TextBlock", "text": "**Failed APIs:**",
            "weight": "Bolder", "spacing": "Medium",
        })
        for r in failures[:8]:
            body.append({
                "type": "ColumnSet",
                "columns": [{"type": "Column", "width": "stretch", "items": [
                    {"type": "TextBlock", "text": r.get("name", "?"),
                     "weight": "Bolder", "wrap": True},
                    {"type": "TextBlock",
                     "text": f"Status {r.get('status', '?')} — {(r.get('failure_reason') or '')[:80]}",
                     "isSubtle": True, "size": "Small", "wrap": True},
                ]}],
            })

    card = {
        "type":    "AdaptiveCard",
        "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
        "version": "1.4",
        "body":    body,
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
    req  = urllib.request.Request(webhook_url, data=data,
                                   headers={"Content-Type": "application/json"})
    urllib.request.urlopen(req, timeout=10)


def _send_sla_teams_alert(cron: dict, col_name: str, violations: list, webhook_url: str) -> None:
    body: list = [
        {
            "type":   "TextBlock",
            "text":   f"⚠️ SLA Breach — {cron.get('name', '')}",
            "size":   "Large", "weight": "Bolder", "color": "Warning",
        },
        {
            "type":  "FactSet",
            "facts": [
                {"title": "Tenant",     "value": cron.get("tenant", "")},
                {"title": "Collection", "value": col_name},
            ],
        },
    ]
    for vtype, vdata in violations:
        if vtype == "response_time":
            body.append({"type": "TextBlock", "text": "**Slow APIs (exceeded response threshold):**",
                         "weight": "Bolder", "spacing": "Medium"})
            for api_name, dur_ms in vdata[:8]:
                body.append({"type": "TextBlock",
                              "text": f"• {api_name} — {dur_ms:.0f} ms",
                              "isSubtle": True, "size": "Small", "wrap": True})
        elif vtype == "pass_rate":
            body.append({"type": "TextBlock",
                         "text": f"**Pass rate dropped to {vdata:.1f}%** (below configured threshold)",
                         "weight": "Bolder", "color": "Warning", "spacing": "Medium", "wrap": True})

    card = {
        "type": "AdaptiveCard",
        "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
        "version": "1.4", "body": body,
    }
    payload_data = json.dumps({
        "type": "message",
        "attachments": [{"contentType": "application/vnd.microsoft.card.adaptive",
                         "contentUrl": None, "content": card}],
    }).encode()
    req = urllib.request.Request(webhook_url, data=payload_data,
                                 headers={"Content-Type": "application/json"})
    urllib.request.urlopen(req, timeout=10)


def _send_sla_email(cron: dict, col_name: str, violations: list) -> None:
    smtp_doc = load_smtp_config()
    if not smtp_doc:
        log.warning("SLA email skipped — no SMTP config")
        return

    recipients = list({smtp_doc["to_email"]} | set(cron.get("alert_emails") or []))
    subject    = f"SLA Breach: \"{col_name}\" [{cron.get('name', '')}]"

    violation_html = ""
    for vtype, vdata in violations:
        if vtype == "response_time":
            rows = "".join(
                f'<tr><td style="padding:6px 12px;border-bottom:1px solid #f1f5f9">{n}</td>'
                f'<td style="padding:6px 12px;border-bottom:1px solid #f1f5f9;color:#dc2626;font-weight:700">'
                f'{d:.0f} ms</td></tr>'
                for n, d in vdata
            )
            violation_html += (
                '<p style="font-weight:700;color:#92400e;margin:16px 0 8px">Slow APIs (exceeded response threshold):</p>'
                '<table style="width:100%;border-collapse:collapse;font-size:13px">'
                '<tr style="background:#fef3c7"><th style="padding:6px 12px;text-align:left">API Name</th>'
                '<th style="padding:6px 12px;text-align:left">Response Time</th></tr>'
                + rows + '</table>'
            )
        elif vtype == "pass_rate":
            violation_html += (
                f'<p style="font-weight:700;color:#dc2626;margin:16px 0 8px">'
                f'Pass rate dropped to {vdata:.1f}% (below configured SLA threshold)</p>'
            )

    html_body = f"""
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px">
      <div style="background:#fef3c7;border-left:4px solid #f59e0b;padding:16px 20px;border-radius:4px;margin-bottom:20px">
        <h2 style="margin:0 0 4px;font-size:18px;color:#92400e">SLA Breach Detected</h2>
        <p style="margin:0;color:#78350f;font-size:13px">{col_name} — {cron.get('name', '')}</p>
      </div>
      {violation_html}
    </div>"""

    msg              = EmailMessage()
    msg["Subject"]   = subject
    msg["From"]      = smtp_doc.get("from_email", smtp_doc["to_email"])
    msg["To"]        = ", ".join(recipients)
    msg.set_content(subject)
    msg.add_alternative(html_body, subtype="html")
    send_via_smtp(smtp_doc, msg)


def _check_sla(cron: dict, col_name: str, results: dict, db) -> None:
    """Check SLA thresholds and fire alerts independently of the main alert condition."""
    sla_ms  = cron.get("sla_response_ms")
    sla_pct = cron.get("sla_pass_rate_pct")
    if not sla_ms and not sla_pct:
        return

    violations = []
    if sla_ms:
        slow = [
            (r["name"], r.get("duration_ms") or 0)
            for r in results.get("results", [])
            if (r.get("duration_ms") or 0) > sla_ms
        ]
        if slow:
            violations.append(("response_time", slow))

    if sla_pct:
        total = results.get("total") or 0
        if total > 0:
            rate = results.get("passed", 0) / total * 100
            if rate < sla_pct:
                violations.append(("pass_rate", rate))

    if not violations:
        return

    teams_url = _resolve_cron_teams_url(cron, db)
    if cron.get("teams_enabled") and teams_url:
        try:
            _send_sla_teams_alert(cron, col_name, violations, teams_url)
        except Exception:
            log.exception("SLA Teams alert failed for cron '%s'", cron.get("name"))
    else:
        try:
            _send_sla_email(cron, col_name, violations)
        except Exception:
            log.exception("SLA email alert failed for cron '%s'", cron.get("name"))


def _run_one_cron(cron: dict, db) -> dict:
    """Run a single cron job, persist results, and return the run summary."""
    col_doc = db[API_COLL].find_one({"_id": ObjectId(cron["collection_id"])})
    if not col_doc:
        # Collection was deleted and re-uploaded (new _id) — try to find by name + tenant
        col_doc = db[API_COLL].find_one({
            "name":   cron.get("collection_name", ""),
            "tenant": cron.get("tenant", ""),
        })
        if col_doc:
            new_id = str(col_doc["_id"])
            db[CRONS_COLL].update_one(
                {"_id": cron["_id"]},
                {"$set": {"collection_id": new_id}},
            )
            log.info("Auto-healed cron '%s': collection_id updated to %s", cron.get("name"), new_id)
        else:
            raise RuntimeError(f"Collection {cron['collection_id']} not found")

    results = _run_newman(
        col_doc["collection"],
        dict(col_doc.get("variables") or {}),
        col_doc.get("expected_status_codes") or None,
    )

    # Filter to the selected API subset
    api_filter = cron.get("api_filter")
    if api_filter:
        filtered = [r for r in results["results"] if r["name"] in api_filter]
        results["results"] = filtered
        results["total"]   = len(filtered)
        results["passed"]  = sum(1 for r in filtered if r["passed"])
        results["failed"]  = results["total"] - results["passed"]

    now      = datetime.now(timezone.utc)
    next_run = _compute_next_run(cron["schedule"], now)
    failures = [r for r in results["results"] if not r["passed"]]

    condition = cron.get("alert_condition", "on_failure")

    db[CRONS_COLL].update_one(
        {"_id": cron["_id"]},
        {"$set": {
            "last_run_at":  results["ran_at"],
            "last_results": results,
            "next_run_at":  next_run.isoformat(),
        }},
    )

    # Mirror run results onto the collection so the Integrations page stays current.
    # Store full results only when no api_filter is set (filtered runs are partial).
    col_update: dict = {"last_run_at": results["ran_at"]}
    if not api_filter:
        col_update["last_results"] = results
    db[API_COLL].update_one(
        {"_id": col_doc["_id"]},
        {"$set": col_update},
    )

    # Persist this run as a historical record
    db[RUNS_COLL].insert_one({
        "cron_id":         str(cron["_id"]),
        "cron_name":       cron.get("name", ""),
        "collection_id":   cron.get("collection_id", ""),
        "collection_name": col_doc.get("name", ""),
        "tenant":          cron.get("tenant", ""),
        "ran_at":          results.get("ran_at", now.isoformat()),
        "total":           results.get("total", 0),
        "passed":          results.get("passed", 0),
        "failed":          results.get("failed", 0),
        "duration_ms":     results.get("duration_ms", 0),
        "results":         results.get("results", []),
        "alert_condition": condition,
    })

    should_notify = (condition == "always") or (condition == "on_failure" and bool(failures))
    if should_notify:
        teams_url = _resolve_cron_teams_url(cron, db)
        if cron.get("teams_enabled") and teams_url:
            try:
                _send_cron_teams_alert(cron, col_doc.get("name", ""), results, teams_url)
            except Exception:
                log.exception("Teams alert failed for cron '%s'", cron.get("name"))
        elif condition == "always":
            _send_cron_report(cron, col_doc.get("name", ""), results, failures_only=False)
        else:
            _send_cron_report(cron, col_doc.get("name", ""), results, failures_only=True)

    _check_sla(cron, col_doc.get("name", ""), results, db)

    return results


def run_api_monitor_crons() -> None:
    """APScheduler entry point — runs all due cron jobs."""
    db  = get_db()
    now = datetime.now(timezone.utc)

    due = list(db[CRONS_COLL].find({
        "enabled":     True,
        "next_run_at": {"$lte": now.isoformat()},
    }))

    if not due:
        return

    log.info("API monitor crons: %d job(s) due", len(due))
    for cron in due:
        try:
            # Window guard: if a time window is set and we're currently outside it,
            # skip the run and push next_run_at to the next window open.
            schedule     = cron.get("schedule", {})
            window_start = schedule.get("window_start")
            window_end   = schedule.get("window_end")
            if window_start and window_end and not _in_window(now, window_start, window_end):
                next_run = _next_window_start(now, window_start)
                db[CRONS_COLL].update_one(
                    {"_id": cron["_id"]},
                    {"$set": {"next_run_at": next_run.isoformat()}},
                )
                log.info(
                    "Cron '%s' skipped — outside window %s–%s, next run at %s",
                    cron.get("name"), window_start, window_end, next_run,
                )
                continue

            _run_one_cron(cron, db)
            log.info("Cron '%s' completed", cron.get("name", cron["_id"]))
        except Exception:
            log.exception("Cron '%s' failed", cron.get("name", cron["_id"]))
