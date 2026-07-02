"""
Teams Webhook configuration — store named webhook URLs that can be
referenced by alert rules, Sev-A rules, and cron jobs.
"""
import json
import urllib.request
from datetime import datetime, timezone

from bson import ObjectId
from bson.errors import InvalidId
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from database import get_db

router = APIRouter(prefix="/api/settings/teams-webhooks", tags=["teams-webhooks"])
COLLECTION = "teams_webhooks"


class WebhookIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    url:  str = Field(..., min_length=1)


def _serialize(doc: dict) -> dict:
    return {**doc, "_id": str(doc["_id"])}


@router.get("")
def list_webhooks():
    db   = get_db()
    docs = list(db[COLLECTION].find().sort("created_at", 1))
    return {"webhooks": [_serialize(d) for d in docs]}


@router.post("", status_code=201)
def create_webhook(payload: WebhookIn):
    db  = get_db()
    doc = {
        "name":       payload.name.strip(),
        "url":        payload.url.strip(),
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    res = db[COLLECTION].insert_one(doc)
    doc["_id"] = res.inserted_id
    return _serialize(doc)


@router.put("/{webhook_id}")
def update_webhook(webhook_id: str, payload: WebhookIn):
    db = get_db()
    try:
        oid = ObjectId(webhook_id)
    except InvalidId:
        raise HTTPException(400, "Invalid ID")
    result = db[COLLECTION].find_one_and_update(
        {"_id": oid},
        {"$set": {"name": payload.name.strip(), "url": payload.url.strip()}},
        return_document=True,
    )
    if not result:
        raise HTTPException(404, "Webhook not found")
    return _serialize(result)


@router.delete("/{webhook_id}", status_code=204)
def delete_webhook(webhook_id: str):
    db = get_db()
    try:
        oid = ObjectId(webhook_id)
    except InvalidId:
        raise HTTPException(400, "Invalid ID")
    db[COLLECTION].delete_one({"_id": oid})


@router.post("/{webhook_id}/test")
def test_webhook(webhook_id: str):
    db = get_db()
    try:
        oid = ObjectId(webhook_id)
    except InvalidId:
        raise HTTPException(400, "Invalid ID")
    doc = db[COLLECTION].find_one({"_id": oid})
    if not doc:
        raise HTTPException(404, "Webhook not found")
    payload = {
        "@type":      "MessageCard",
        "@context":   "http://schema.org/extensions",
        "themeColor": "0078D4",
        "summary":    "Jiffy APM — test notification",
        "sections":   [{
            "activityTitle": "✅ Jiffy APM — webhook test",
            "facts": [
                {"name": "Webhook", "value": doc["name"]},
                {"name": "Status",  "value": "Connected successfully"},
            ],
        }],
    }
    data = json.dumps(payload).encode()
    req  = urllib.request.Request(
        doc["url"], data=data, headers={"Content-Type": "application/json"}
    )
    try:
        urllib.request.urlopen(req, timeout=10)
    except Exception as exc:
        raise HTTPException(502, f"Delivery failed: {exc}")
    return {"ok": True}
