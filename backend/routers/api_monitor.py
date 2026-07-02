"""
API Monitor — store Postman collections + environments per tenant and run them via Newman.
Newman handles chained auth, test scripts, pm.environment.set(), etc. exactly like Postman.
"""
import json
import re
import shutil
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from bson import ObjectId
from bson.errors import InvalidId
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from database import get_db

router = APIRouter(prefix="/api/api-monitor", tags=["api-monitor"])

COLLECTION = "api_monitor_collections"

NEWMAN_BIN = shutil.which("newman") or "newman"


# ─── helpers ──────────────────────────────────────────────────────────────────

def _serialize(doc: dict) -> dict:
    out = dict(doc)
    out["id"] = str(out.pop("_id"))
    return out


def _extract_requests(items: list, prefix: str = "") -> list[dict]:
    """Recursively flatten Postman collection items — used for req_count + API list preview."""
    reqs = []
    for item in items:
        name = (prefix + " / " if prefix else "") + item.get("name", "Unnamed")
        if "item" in item:
            reqs.extend(_extract_requests(item["item"], name))
        elif "request" in item:
            reqs.append({"name": name, "request": item["request"]})
    return reqs


def _parse_env(env_json: dict | None) -> dict[str, str]:
    """Extract key→value pairs from a Postman environment export."""
    if not env_json:
        return {}
    return {
        v["key"]: str(v.get("value") or "")
        for v in env_json.get("values", [])
        if not v.get("disabled") and v.get("key")
    }


def _build_newman_env(variables: dict[str, str]) -> dict:
    """Build a Postman environment JSON from a flat key-value dict."""
    return {
        "id": "api-monitor-env",
        "name": "API Monitor Environment",
        "values": [
            {"key": k, "value": v, "enabled": True}
            for k, v in variables.items()
        ],
    }


def _run_newman(collection: dict, variables: dict[str, str],
                expected_status_codes: dict[str, int] | None = None) -> dict:
    """
    Run a Postman collection via Newman CLI.
    Returns a normalized result dict with per-request pass/fail detail.
    """
    with tempfile.TemporaryDirectory() as tmpdir:
        col_path = Path(tmpdir) / "collection.json"
        env_path = Path(tmpdir) / "environment.json"

        col_path.write_text(json.dumps(collection), encoding="utf-8")
        env_path.write_text(json.dumps(_build_newman_env(variables)), encoding="utf-8")

        cmd = [
            NEWMAN_BIN, "run",
            str(col_path),
            "--environment", str(env_path),
            "--reporters", "json",
            "--reporter-json-export", str(Path(tmpdir) / "results.json"),
            "--timeout-request", "15000",
            "--insecure",
        ]

        proc = subprocess.run(
            cmd, capture_output=True, text=True, timeout=300
        )

        results_path = Path(tmpdir) / "results.json"
        if not results_path.exists():
            raise RuntimeError(
                f"Newman exited with code {proc.returncode}.\n"
                f"stderr: {proc.stderr[:2000]}"
            )

        raw = json.loads(results_path.read_text(encoding="utf-8"))

    return _parse_newman_results(raw, expected_status_codes)


def _parse_newman_results(raw: dict, expected_status_codes: dict[str, int] | None = None) -> dict:
    """Convert Newman JSON reporter output to our normalized schema."""
    run     = raw.get("run", {})
    stats   = run.get("stats", {})
    timings = run.get("timings", {})

    executions = run.get("executions", [])
    results = []
    for ex in executions:
        item    = ex.get("item", {})
        req     = (ex.get("request") or {})
        resp    = (ex.get("response") or {})
        name    = item.get("name", "Unnamed")
        method  = (req.get("method") or "GET").upper()
        url_obj = req.get("url") or {}
        url     = url_obj if isinstance(url_obj, str) else url_obj.get("raw", "")

        status      = resp.get("code")
        duration_ms = resp.get("responseTime") or 0
        resp_size   = resp.get("responseSize") or 0

        # Response body — Newman stores it as a Buffer-like dict or string
        resp_body_raw = resp.get("stream") or resp.get("body") or ""
        resp_body = ""
        if isinstance(resp_body_raw, dict) and "data" in resp_body_raw:
            try:
                resp_body = bytes(resp_body_raw["data"]).decode("utf-8", errors="replace")
            except Exception:
                resp_body = ""
        elif isinstance(resp_body_raw, str):
            resp_body = resp_body_raw

        # Try to pretty-print JSON responses
        resp_body_display = resp_body[:2000]  # cap at 2KB for UI
        try:
            parsed_body = json.loads(resp_body)
            resp_body_display = json.dumps(parsed_body, indent=2)[:2000]
        except Exception:
            pass

        # Collect assertion results
        assertions = ex.get("assertions") or []
        assertion_results = []
        for a in assertions:
            err = a.get("error")
            assertion_results.append({
                "name":   a.get("assertion", ""),
                "passed": err is None,
                "error":  err.get("message") if err else None,
            })

        # Errors from the execution itself (network errors, timeouts, etc.)
        exec_errors = [e.get("message", str(e)) for e in (ex.get("requestError") or []) if e]
        if ex.get("requestError") and not exec_errors:
            exec_errors = [str(ex["requestError"])]

        if expected_status_codes and name in expected_status_codes:
            status_ok = status == expected_status_codes[name]
        else:
            status_ok = status is not None and status < 400
        passed = (not exec_errors) and all(a["passed"] for a in assertion_results) and status_ok

        # Failure reason: assertion errors + HTTP error body
        failure_reason = None
        if not passed:
            failed_assertions = [a["error"] for a in assertion_results if not a["passed"] and a["error"]]
            if exec_errors:
                failure_reason = exec_errors[0]
            elif failed_assertions:
                failure_reason = " | ".join(failed_assertions)
            elif status and status >= 400 and resp_body_display:
                failure_reason = resp_body_display

        results.append({
            "name":               name,
            "method":             method,
            "url":                url,
            "status":             status,
            "duration_ms":        duration_ms,
            "response_size":      resp_size,
            "passed":             passed,
            "assertions":         assertion_results,
            "error":              exec_errors[0] if exec_errors else None,
            "failure_reason":     failure_reason,
            "response_body":      resp_body_display or None,
        })

    total_requests  = stats.get("requests",   {}).get("total",  len(results))
    total_passed    = sum(1 for r in results if r["passed"])
    total_failed    = total_requests - total_passed
    total_duration  = timings.get("completed", 0) - timings.get("started", 0)

    return {
        "ran_at":           datetime.now(timezone.utc).isoformat(),
        "total":            total_requests,
        "passed":           total_passed,
        "failed":           total_failed,
        "duration_ms":      total_duration,
        "results":          results,
    }


# ─── schemas ──────────────────────────────────────────────────────────────────

class SaveCollectionIn(BaseModel):
    name:                  str
    collection:            dict
    environment:           dict | None = None
    variables:             dict | None = None
    expected_status_codes: dict[str, int] | None = None  # { "Request Name": 200 }


class UpdateVariablesIn(BaseModel):
    variables:             dict
    environment:           dict | None = None
    expected_status_codes: dict[str, int] | None = None  # { "Request Name": 200 }


# ─── endpoints ────────────────────────────────────────────────────────────────

@router.get("/tenants-with-collections")
def get_tenants_with_collections():
    """Return tenant names that have at least one API monitor collection."""
    db = get_db()
    tenants = db[COLLECTION].distinct("tenant")
    return {"tenants": sorted(tenants)}


@router.get("/{tenant}/collections")
def list_collections(tenant: str):
    db   = get_db()
    docs = list(db[COLLECTION].find({"tenant": tenant}).sort("created_at", -1))
    return {"collections": [_serialize(d) for d in docs]}


@router.post("/{tenant}/collections", status_code=201)
def save_collection(tenant: str, payload: SaveCollectionIn):
    db        = get_db()
    items     = payload.collection.get("item", [])
    req_count = len(_extract_requests(items))

    env_vars = _parse_env(payload.environment)
    if payload.variables:
        env_vars.update(payload.variables)
    for v in payload.collection.get("variable", []):
        key = v.get("key")
        if key and key not in env_vars:
            env_vars[key] = str(v.get("value") or "")

    doc = {
        "tenant":                tenant,
        "name":                  payload.name.strip() or payload.collection.get("info", {}).get("name", "Unnamed"),
        "collection":            payload.collection,
        "variables":             env_vars,
        "req_count":             req_count,
        "expected_status_codes": payload.expected_status_codes or {},
        "created_at":            datetime.now(timezone.utc).isoformat(),
        "last_run_at":           None,
        "last_results":          None,
    }
    res      = db[COLLECTION].insert_one(doc)
    doc["_id"] = res.inserted_id
    return _serialize(doc)


@router.patch("/{tenant}/collections/{col_id}/variables")
def update_variables(tenant: str, col_id: str, payload: UpdateVariablesIn):
    try:
        oid = ObjectId(col_id)
    except InvalidId:
        raise HTTPException(400, "Invalid collection id")

    db  = get_db()
    doc = db[COLLECTION].find_one({"_id": oid, "tenant": tenant})
    if not doc:
        raise HTTPException(404, "Collection not found")

    merged = dict(doc.get("variables") or {})
    merged.update(_parse_env(payload.environment))
    merged.update(payload.variables or {})

    expected = payload.expected_status_codes if payload.expected_status_codes is not None else doc.get("expected_status_codes", {})
    db[COLLECTION].update_one({"_id": oid}, {"$set": {"variables": merged, "expected_status_codes": expected}})
    return {"ok": True, "variables": merged, "expected_status_codes": expected}


class ExpectedStatusIn(BaseModel):
    expected_status_codes: dict[str, int]


@router.patch("/{tenant}/collections/{col_id}/expected-status")
def update_expected_status(tenant: str, col_id: str, payload: ExpectedStatusIn):
    try:
        oid = ObjectId(col_id)
    except InvalidId:
        raise HTTPException(400, "Invalid collection id")
    db  = get_db()
    if not db[COLLECTION].find_one({"_id": oid, "tenant": tenant}):
        raise HTTPException(404, "Collection not found")
    db[COLLECTION].update_one({"_id": oid}, {"$set": {"expected_status_codes": payload.expected_status_codes}})
    return {"ok": True, "expected_status_codes": payload.expected_status_codes}


@router.delete("/{tenant}/collections/{col_id}")
def delete_collection(tenant: str, col_id: str):
    try:
        oid = ObjectId(col_id)
    except InvalidId:
        raise HTTPException(400, "Invalid collection id")
    res = get_db()[COLLECTION].delete_one({"_id": oid, "tenant": tenant})
    if res.deleted_count == 0:
        raise HTTPException(404, "Collection not found")
    return {"ok": True}


@router.post("/{tenant}/collections/{col_id}/run")
def run_collection(tenant: str, col_id: str):
    try:
        oid = ObjectId(col_id)
    except InvalidId:
        raise HTTPException(400, "Invalid collection id")

    db  = get_db()
    doc = db[COLLECTION].find_one({"_id": oid, "tenant": tenant})
    if not doc:
        raise HTTPException(404, "Collection not found")

    try:
        run_summary = _run_newman(
            doc["collection"],
            dict(doc.get("variables") or {}),
            doc.get("expected_status_codes") or None,
        )
    except subprocess.TimeoutExpired:
        raise HTTPException(504, "Newman run timed out (>5 min)")
    except Exception as exc:
        raise HTTPException(500, f"Newman error: {exc}")

    db[COLLECTION].update_one(
        {"_id": oid},
        {"$set": {"last_run_at": run_summary["ran_at"], "last_results": run_summary}},
    )

    return run_summary


@router.get("/{tenant}/collections/{col_id}/runs")
def get_collection_runs(tenant: str, col_id: str, limit: int = 20):
    """Return recent runs for a collection (both manual and cron-triggered)."""
    try:
        oid = ObjectId(col_id)
    except InvalidId:
        raise HTTPException(400, "Invalid collection id")
    db = get_db()
    if not db[COLLECTION].find_one({"_id": oid, "tenant": tenant}):
        raise HTTPException(404, "Collection not found")
    docs = list(
        db["api_monitor_cron_runs"]
        .find({"collection_id": str(oid)})
        .sort("ran_at", -1)
        .limit(limit)
    )
    for d in docs:
        d["id"] = str(d.pop("_id"))
    return {"runs": docs}


@router.get("/{tenant}/collections/{col_id}/stats")
def get_collection_stats(
    tenant: str, col_id: str,
    limit: int = 100,
    start: str | None = None,
    end:   str | None = None,
):
    """Return trend data + per-API response time stats.
    If start/end (ISO strings) are provided they take priority; otherwise returns last `limit` runs.
    """
    try:
        oid = ObjectId(col_id)
    except InvalidId:
        raise HTTPException(400, "Invalid collection id")
    db = get_db()
    if not db[COLLECTION].find_one({"_id": oid, "tenant": tenant}):
        raise HTTPException(404, "Collection not found")

    query: dict = {"collection_id": str(oid)}
    if start or end:
        date_filter: dict = {}
        if start: date_filter["$gte"] = start
        if end:   date_filter["$lte"] = end
        query["ran_at"] = date_filter

    cursor = db["api_monitor_cron_runs"].find(query).sort("ran_at", -1)
    if not (start or end):
        cursor = cursor.limit(limit)
    runs = list(cursor)
    runs = sorted(runs, key=lambda r: r.get("ran_at", ""))

    trend = []
    for run in runs:
        total  = run.get("total") or 0
        passed = run.get("passed") or 0
        trend.append({
            "ran_at":      run.get("ran_at", ""),
            "passed":      passed,
            "failed":      run.get("failed") or 0,
            "total":       total,
            "duration_ms": run.get("duration_ms") or 0,
            "pass_rate":   round(passed / total * 100, 1) if total else 0,
        })

    api_durations: dict[str, list[float]] = {}
    api_pass:      dict[str, int]         = {}
    api_total:     dict[str, int]         = {}

    for run in runs:
        for req in (run.get("results") or []):
            name = req.get("name") or "Unknown"
            dur  = float(req.get("duration_ms") or 0)
            api_durations.setdefault(name, []).append(dur)
            api_total[name] = api_total.get(name, 0) + 1
            if req.get("passed"):
                api_pass[name] = api_pass.get(name, 0) + 1

    api_stats = []
    for name, durations in api_durations.items():
        n        = len(durations)
        sorted_d = sorted(durations)
        p95_idx  = max(0, int(n * 0.95) - 1)
        tc       = api_total.get(name, 0)
        pc       = api_pass.get(name, 0)
        api_stats.append({
            "name":         name,
            "avg_duration": round(sum(durations) / n, 1),
            "min_duration": sorted_d[0],
            "max_duration": sorted_d[-1],
            "p95_duration": sorted_d[p95_idx],
            "pass_count":   pc,
            "total_count":  tc,
            "uptime_pct":   round(pc / tc * 100, 1) if tc else 0,
        })

    api_stats.sort(key=lambda x: x["avg_duration"], reverse=True)

    # Per-run per-API timing matrix for the line chart.
    # Each entry is one run: { ran_at, label, <api_name>: duration_ms, ... }
    per_run_api: list[dict] = []
    for run in runs:
        entry: dict = {"ran_at": run.get("ran_at", "")}
        for req in (run.get("results") or []):
            name = req.get("name") or "Unknown"
            entry[name] = round(float(req.get("duration_ms") or 0) / 1000, 3)
        per_run_api.append(entry)

    return {"trend": trend, "api_stats": api_stats, "per_run_api": per_run_api}


def _get_anthropic_key() -> str | None:
    import os
    try:
        from config import get_config
        key = (get_config().get("anthropic") or {}).get("api_key")
        if key and key != "YOUR_ANTHROPIC_API_KEY_HERE":
            return key
    except Exception:
        pass
    return os.environ.get("ANTHROPIC_API_KEY")


@router.post("/{tenant}/collections/{col_id}/insights")
def get_collection_insights(tenant: str, col_id: str):
    """Generate an AI trend analysis paragraph for this collection's run history."""
    import json as _json
    import anthropic as _anthropic
    try:
        oid = ObjectId(col_id)
    except InvalidId:
        raise HTTPException(400, "Invalid collection id")
    db      = get_db()
    col_doc = db[COLLECTION].find_one({"_id": oid, "tenant": tenant})
    if not col_doc:
        raise HTTPException(404, "Collection not found")

    api_key = _get_anthropic_key()
    if not api_key:
        raise HTTPException(503, "Anthropic API key not configured")

    runs = list(
        db["api_monitor_cron_runs"]
        .find({"collection_id": str(oid)})
        .sort("ran_at", -1)
        .limit(30)
    )
    runs = sorted(runs, key=lambda r: r.get("ran_at", ""))

    trend = []
    for run in runs:
        total  = run.get("total") or 0
        passed = run.get("passed") or 0
        trend.append({
            "ran_at":      run.get("ran_at", ""),
            "passed":      passed,
            "total":       total,
            "duration_ms": run.get("duration_ms") or 0,
            "pass_rate":   round(passed / total * 100, 1) if total else 0,
            "failures": [
                {"name": r["name"], "reason": r.get("failure_reason") or ""}
                for r in (run.get("results") or [])
                if not r.get("passed")
            ],
        })

    payload_json = _json.dumps({
        "collection_name": col_doc.get("name", ""),
        "tenant":          tenant,
        "run_count":       len(trend),
        "trend":           trend,
    })

    client  = _anthropic.Anthropic(api_key=api_key)
    message = client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=256,
        system=(
            "You are an API reliability analyst. Given this API monitor run history, "
            "provide a 3-4 sentence insight: highlight trends, flag degrading endpoints, "
            "note consistent failures, and call out any improvement. Be concise and actionable."
        ),
        messages=[{"role": "user", "content": payload_json}],
    )
    insight = message.content[0].text if message.content else "No insight available."
    return {"insight": insight}
