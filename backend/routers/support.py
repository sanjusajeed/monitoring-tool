"""
Email configuration + issue-report endpoints for the in-app support bot.

- GET  /api/support/email-config   -> stored SMTP config (password masked)
- PUT  /api/support/email-config   -> upsert SMTP config
- POST /api/support/report-issue   -> send an issue email using the stored config
"""
import logging
import smtplib
from email.message import EmailMessage

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from database import get_db

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/support", tags=["support"])

CONFIG_ID = "default"
COLLECTION = "support_config"


class EmailConfig(BaseModel):
    smtp_host: str = Field(..., min_length=1)
    smtp_port: int = Field(..., ge=1, le=65535)
    username: str = Field(..., min_length=1)
    password: str = Field(..., min_length=1)
    from_email: str = Field(..., min_length=3)
    to_email: str = Field(..., min_length=3)
    use_tls: bool = True


class IssueReport(BaseModel):
    message: str = Field(..., min_length=1, max_length=5000)
    user_email: str | None = None


class GraphCredentials(BaseModel):
    tenant_id:     str = Field(..., min_length=1)
    client_id:     str = Field(..., min_length=1)
    client_secret: str = Field(..., min_length=1)


def _mask(pw: str) -> str:
    if not pw:
        return ""
    if len(pw) <= 4:
        return "*" * len(pw)
    return pw[:2] + "*" * (len(pw) - 4) + pw[-2:]


def load_smtp_config() -> dict | None:
    """Return the persisted SMTP config doc (or None if not configured yet).
    Exported so the alert evaluator can reuse the same Mongo source as the
    in-app issue reporter."""
    return get_db()[COLLECTION].find_one({"_id": CONFIG_ID})


def send_via_smtp(msg: EmailMessage, smtp_doc: dict) -> None:
    """Connect with the appropriate transport (STARTTLS vs SMTPS) and send.

    Raises on any smtplib error — callers translate to HTTP / log as they see
    fit. Pulled out of report_issue() so the alert evaluator can reuse it.
    """
    if smtp_doc.get("use_tls", True):
        with smtplib.SMTP(smtp_doc["smtp_host"], int(smtp_doc["smtp_port"]), timeout=15) as s:
            s.starttls()
            s.login(smtp_doc["username"], smtp_doc["password"])
            s.send_message(msg)
    else:
        with smtplib.SMTP_SSL(smtp_doc["smtp_host"], int(smtp_doc["smtp_port"]), timeout=15) as s:
            s.login(smtp_doc["username"], smtp_doc["password"])
            s.send_message(msg)


@router.get("/email-config")
def get_email_config():
    doc = get_db()[COLLECTION].find_one({"_id": CONFIG_ID})
    if not doc:
        return {"configured": False}
    return {
        "configured": True,
        "smtp_host": doc.get("smtp_host", ""),
        "smtp_port": doc.get("smtp_port", 587),
        "username": doc.get("username", ""),
        "password_masked": _mask(doc.get("password", "")),
        "from_email": doc.get("from_email", ""),
        "to_email": doc.get("to_email", ""),
        "use_tls": doc.get("use_tls", True),
    }


@router.put("/email-config")
def save_email_config(cfg: EmailConfig):
    get_db()[COLLECTION].replace_one(
        {"_id": CONFIG_ID},
        {"_id": CONFIG_ID, **cfg.model_dump()},
        upsert=True,
    )
    return {"ok": True}


@router.post("/test-graph-credentials")
def test_graph_credentials(creds: GraphCredentials):
    """Try acquiring an MS Graph token via client_credentials — no side effects."""
    import json as _json
    import urllib.error
    import urllib.parse
    import urllib.request
    url  = f"https://login.microsoftonline.com/{creds.tenant_id}/oauth2/v2.0/token"
    data = urllib.parse.urlencode({
        "grant_type":    "client_credentials",
        "client_id":     creds.client_id,
        "client_secret": creds.client_secret,
        "scope":         "https://graph.microsoft.com/.default",
    }).encode()
    req = urllib.request.Request(
        url, data=data,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            _json.loads(resp.read())
        return {"ok": True, "message": "Credentials are valid — token acquired successfully."}
    except urllib.error.HTTPError as e:
        body = _json.loads(e.read())
        desc = body.get("error_description") or body.get("error") or f"HTTP {e.code}"
        return {"ok": False, "error": desc}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


@router.post("/report-issue")
def report_issue(report: IssueReport):
    doc = get_db()[COLLECTION].find_one({"_id": CONFIG_ID})
    if not doc:
        raise HTTPException(status_code=400, detail="Email is not configured. Open Settings to add SMTP details.")

    msg = EmailMessage()
    msg["Subject"] = "[Monitoring App] New issue report"
    msg["From"] = doc["from_email"]
    msg["To"] = doc["to_email"]
    if report.user_email:
        msg["Reply-To"] = report.user_email

    body = (
        f"A user reported an issue in the Monitoring App.\n\n"
        f"From: {report.user_email or 'anonymous'}\n\n"
        f"Message:\n{report.message}\n"
    )
    msg.set_content(body)

    try:
        send_via_smtp(msg, doc)
    except Exception as e:
        logger.exception("Failed to send issue email")
        raise HTTPException(status_code=502, detail=f"Failed to send email: {e}")

    return {"ok": True}
