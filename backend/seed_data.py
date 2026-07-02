"""
Dummy dataset for the in-memory mongomock database used by this demo build.

This app normally reads/writes a live MongoDB cluster. For interview/demo
purposes `database.py` swaps that out for mongomock (nothing leaves the
process, no network calls), and this module fills it with fabricated
tenants/apps/metrics on first access so the UI has something to show.
"""
import random
from datetime import datetime, timedelta, timezone

_rng = random.Random(42)

TENANTS = ["acme-corp", "globex-industries"]
APPS = {
    "acme-corp":         ["checkout-service", "inventory-api"],
    "globex-industries": ["billing-portal"],
}
ENVS = ["prod", "uat"]
ERROR_PATHS = ["/api/v1/orders", "/api/v1/payments", "/api/v1/inventory/sync", "/api/v1/users/me"]
PODS = {
    "prod": ["checkout-prod-7f9c8", "checkout-prod-2a1bd"],
    "uat":  ["checkout-uat-01"],
}


def _now():
    return datetime.now(timezone.utc)


def _iso(dt):
    return dt.isoformat()


def _inst_id(tenant, app, env):
    return f"{tenant}-{app}-{env}-inst"


def _timeseries(base_time, slices=4, base_requests=400):
    buckets = []
    for k in range(slices, 0, -1):
        ts = base_time - timedelta(minutes=30 * k)
        requests = max(50, base_requests + _rng.randint(-80, 120))
        errors = _rng.randint(0, 30)
        e4 = _rng.randint(0, errors)
        e5 = errors - e4
        samples = []
        for _ in range(min(3, errors)):
            samples.append({
                "timestamp":             _iso(ts + timedelta(minutes=_rng.randint(0, 29))),
                "method":                _rng.choice(["GET", "POST", "PUT"]),
                "path":                  _rng.choice(ERROR_PATHS),
                "response_code":         _rng.choice([404, 429, 500, 502, 503]),
                "response_code_details": "upstream_reset_before_response_started",
                "response_flags":        "UF",
                "duration":              round(_rng.uniform(50, 900), 1),
                "duration_ms":           _rng.randint(50, 900),
            })
        buckets.append({
            "ts":                  _iso(ts),
            "requests":            requests,
            "errors":              errors,
            "error_4xx":           e4,
            "error_5xx":           e5,
            "error_status_counts": {"500": e5, "404": max(0, e4 - 1), "429": min(1, e4)},
            "error_top_paths":     [{"path": p, "count": _rng.randint(1, 5)} for p in ERROR_PATHS[:2]],
            "error_samples":       samples,
            "avg_latency_ms":      round(_rng.uniform(80, 220), 1),
            "p95_latency_ms":      round(_rng.uniform(220, 480), 1),
        })
    return buckets


def _pod_stats(env):
    out = []
    for pod in PODS.get(env, PODS["prod"]):
        reqs = _rng.randint(200, 900)
        errs = _rng.randint(0, 20)
        out.append({
            "pod":            pod,
            "namespace":      "jiffy-platform",
            "requests":       reqs,
            "errors":         errs,
            "errors_4xx":     _rng.randint(0, errs),
            "errors_5xx":     max(0, errs - _rng.randint(0, errs)),
            "p95_latency_ms": round(_rng.uniform(150, 500), 1),
            "avg_latency_ms": round(_rng.uniform(60, 200), 1),
        })
    return out


def _make_app_insight(tenant, app, env, analyzed_at, ts_slices):
    total_requests = sum(b["requests"] for b in ts_slices)
    total_4xx = sum(b["error_4xx"] for b in ts_slices)
    total_5xx = sum(b["error_5xx"] for b in ts_slices)
    wf_total = _rng.randint(20, 80)
    wf_failed = _rng.randint(0, 4)
    health = round(max(40.0, 100 - (total_4xx + total_5xx) / max(total_requests, 1) * 100 * 3), 1)

    metrics = {
        "total_requests":          total_requests,
        "total_4xx":               total_4xx,
        "total_5xx":               total_5xx,
        "total_workflow_requests": wf_total,
        "workflow_total":          wf_total,  # alias read by temporal.py's per-appid workflow counter
        "workflow_error_rate_pct": round(wf_failed / wf_total * 100, 2) if wf_total else 0,
        "health_score":            health,
        "latency_ms": {
            "avg": round(_rng.uniform(80, 180), 1),
            "p50": round(_rng.uniform(60, 140), 1),
            "p95": round(_rng.uniform(200, 420), 1),
            "p99": round(_rng.uniform(420, 800), 1),
            "max": round(_rng.uniform(800, 1500), 1),
        },
        "workflow": {
            "total_requests": wf_total,
            "error_count":    wf_failed,
            "success_count":  wf_total - wf_failed,
            "error_rate_pct": round(wf_failed / wf_total * 100, 2) if wf_total else 0,
            "steps": [
                {
                    "name":          "ValidatePayment",
                    "step_name":     "ValidatePayment",
                    "error_count":   wf_failed,
                    "last_error":    "Timeout calling payment-gateway" if wf_failed else None,
                    "error_message": "Timeout calling payment-gateway" if wf_failed else None,
                },
            ] if wf_failed else [],
        },
        "timeseries": ts_slices,
        "pod_stats":  _pod_stats(env),
    }

    insights = {
        "root_cause": {
            "primary_issue": "Elevated 5xx rate on /api/v1/payments during checkout spike"
            if total_5xx else "No significant issues detected",
        },
        "error_analysis": {
            "endpoint_failures": [
                {"path": ERROR_PATHS[0], "error_count": total_5xx, "dominant_code": 502},
            ] if total_5xx else [],
        },
        "endpoint_analysis": {
            "most_error_prone": [
                {"path": ERROR_PATHS[1], "errors": total_4xx},
            ] if total_4xx else [],
        },
        "top_issues": (
            ["Payment gateway latency spikes correlate with 5xx bursts"] if total_5xx else []
        ),
    }

    inst_id = _inst_id(tenant, app, env)
    return {
        "tenant_name":       tenant,
        "app_name":          app,
        "app_display_name":  app.replace("-", " ").title(),
        "app_id":             inst_id,
        "inst_id":           inst_id,
        "authority":         f"{app}.{tenant}.internal",
        "environment":       env,
        "analyzed_at":       _iso(analyzed_at),
        "health_score":      health,
        "error_4xx_count":   total_4xx,
        "error_5xx_count":   total_5xx,
        "total_requests":    total_requests,
        "metrics":           metrics,
        "insights":          insights,
    }


def _make_workflow_executions(tenant, app, env, analyzed_at, inst_id):
    statuses = ["COMPLETED", "COMPLETED", "COMPLETED", "FAILED", "RUNNING"]
    execs = []
    failed = completed = running = 0
    for i, status in enumerate(statuses):
        start = analyzed_at - timedelta(minutes=_rng.randint(5, 180))
        duration = _rng.randint(500, 12000)
        wf_id = f"{tenant[:3]}-{app[:4]}-{env}-{i:04d}"
        entry = {
            "workflow_id":  wf_id,
            "workflowId":   wf_id,
            "process_name": f"{app}-order-flow",
            "workflow_name": f"{app}-order-flow",
            "status":       status,
            "start_time":   _iso(start),
            "end_time":     _iso(start + timedelta(milliseconds=duration)) if status != "RUNNING" else None,
            "duration_ms":  duration,
            "error_message": "Timeout calling payment-gateway (504)" if status == "FAILED" else None,
            "error_message_short": "Timeout calling payment-gateway" if status == "FAILED" else None,
            "exception":    "io.jiffy.exceptions.WorkflowException" if status == "FAILED" else None,
        }
        execs.append(entry)
        if status == "FAILED":
            failed += 1
        elif status == "RUNNING":
            running += 1
        else:
            completed += 1

    return {
        "tenant_name":       tenant,
        "app_name":          app,
        "app_display_name":  app.replace("-", " ").title(),
        "environment":       env,
        "inst_id":           inst_id,
        "analyzed_at":       _iso(analyzed_at),
        "summary": {
            "total":     len(execs),
            "completed": completed,
            "running":   running,
            "failed":    failed,
        },
        "executions": execs,
    }


def seed_demo_data(db) -> None:
    """Populate every collection the app reads from with fabricated demo
    data. No-op if already seeded (idempotent — safe to call on every
    get_db(), only runs once per process since mongomock is in-memory)."""
    if db["app_insights"].count_documents({}) > 0:
        return

    now = _now()
    app_insight_docs = []
    workflow_exec_docs = []
    tenant_slice_agg: dict[tuple, dict] = {}
    all_inst_ids = []

    for tenant in TENANTS:
        for app in APPS[tenant]:
            for env in ENVS:
                ts_slices = _timeseries(now, slices=4, base_requests=_rng.randint(300, 900))
                analyzed_at = now
                doc = _make_app_insight(tenant, app, env, analyzed_at, ts_slices)
                app_insight_docs.append(doc)
                all_inst_ids.append(doc["inst_id"])

                workflow_exec_docs.append(
                    _make_workflow_executions(tenant, app, env, analyzed_at, doc["inst_id"])
                )

                key = (tenant, analyzed_at.isoformat())
                agg = tenant_slice_agg.setdefault(key, {
                    "tenant_name": tenant, "analyzed_at": analyzed_at,
                    "app_names": set(), "total_requests": 0, "total_4xx": 0,
                    "total_5xx": 0, "total_workflow_requests": 0, "wf_failed": 0,
                    "health_scores": [],
                })
                m = doc["metrics"]
                agg["app_names"].add(app)
                agg["total_requests"] += m["total_requests"]
                agg["total_4xx"] += m["total_4xx"]
                agg["total_5xx"] += m["total_5xx"]
                agg["total_workflow_requests"] += m["total_workflow_requests"]
                agg["wf_failed"] += m["workflow"]["error_count"]
                agg["health_scores"].append(m["health_score"])

    db["app_insights"].insert_many(app_insight_docs)
    db["workflow_executions"].insert_many(workflow_exec_docs)

    tenant_insight_docs = []
    for (tenant, _), agg in tenant_slice_agg.items():
        wf_total = agg["total_workflow_requests"]
        tenant_insight_docs.append({
            "tenant_name":     agg["tenant_name"],
            "analyzed_at":     _iso(agg["analyzed_at"]),
            "app_count":       len(agg["app_names"]),
            "app_names":       sorted(agg["app_names"]),
            "app_insight_ids": [],
            "metrics": {
                "total_requests":          agg["total_requests"],
                "total_4xx":               agg["total_4xx"],
                "total_5xx":               agg["total_5xx"],
                "total_workflow_requests": wf_total,
                "workflow_error_rate_pct": round(agg["wf_failed"] / wf_total * 100, 2) if wf_total else 0,
                "health_score":            round(sum(agg["health_scores"]) / len(agg["health_scores"]), 1),
            },
            "insights": {
                "root_cause":        {"primary_issue": "No significant issues detected"},
                "error_analysis":    {"endpoint_failures": []},
                "endpoint_analysis": {"most_error_prone": []},
                "top_issues":        [],
            },
        })
    db["tenant_insights"].insert_many(tenant_insight_docs)

    # Large workflows (K8s CronJob detector output)
    large_file_docs = []
    for i, tenant in enumerate(TENANTS):
        app = APPS[tenant][0]
        large_file_docs.append({
            "workflow_id":        f"{tenant}-large-wf-{i:03d}",
            "run_id":             f"run-{i:03d}",
            "workflow_type":      f"{app}-order-flow",
            "tenant_id":          tenant,
            "app_id":             _inst_id(tenant, app, "prod"),
            "tenant_name":        tenant,
            "app_name":           app,
            "environment":        "prod",
            "history_size_bytes": _rng.randint(31_000_000, 80_000_000),
            "history_length":     _rng.randint(2000, 6000),
            "status":             "COMPLETED",
            "start_time":         _iso(now - timedelta(hours=_rng.randint(1, 6))),
            "close_time":         _iso(now - timedelta(minutes=_rng.randint(5, 90))),
            "analyzed_at":        _iso(now),
        })
    db["large_file_workflows"].insert_many(large_file_docs)

    # Alert rules — demo examples, disabled Teams/SMTP so nothing fires outbound.
    db["alert_rules"].insert_many([
        {
            "tenant":            TENANTS[0],
            "envs":              ["prod"],
            "conditions": [
                {"key": "error_5xx", "label": "5xx errors", "unit": "count", "threshold": 50},
                {"key": "workflow_failed", "label": "Workflow failures", "unit": "count", "threshold": 0},
            ],
            "window_minutes":    60,
            "extra_emails":      [],
            "teams_enabled":     False,
            "teams_webhook_id":  None,
            "state":             {},
            "last_evaluated_at": None,
            "created_at":        _iso(now),
            "created_by":        "demo",
        },
    ])
    db["sev_a_rules"].insert_many([
        {
            "tenant":            TENANTS[0],
            "envs":              ["prod"],
            "conditions": [
                {"key": "workflow_failed", "label": "Workflow failures", "unit": "count", "threshold": 0},
            ],
            "window_minutes":    60,
            "workflow_names":    [],
            "extra_emails":      [],
            "teams_enabled":     False,
            "teams_webhook_id":  None,
            "state":             {},
            "last_evaluated_at": None,
            "created_at":        _iso(now),
            "created_by":        "demo",
        },
    ])

    # API monitor: one collection + a cron + a few past runs, per tenant.
    for tenant in TENANTS:
        app = APPS[tenant][0]
        postman_collection = {
            "info": {"name": f"{app} health checks"},
            "item": [
                {"name": "Get health", "request": {"method": "GET", "url": "{{base_url}}/health"}},
                {"name": "List orders", "request": {"method": "GET", "url": "{{base_url}}/api/v1/orders"}},
                {"name": "Create order", "request": {"method": "POST", "url": "{{base_url}}/api/v1/orders"}},
            ],
            "variable": [],
        }
        col_doc = {
            "tenant":                tenant,
            "name":                  f"{app} health checks",
            "collection":            postman_collection,
            "variables":             {"base_url": f"https://{app}.{tenant}.internal"},
            "req_count":             3,
            "expected_status_codes": {"Get health": 200, "List orders": 200, "Create order": 201},
            "created_at":            _iso(now - timedelta(days=3)),
            "last_run_at":           _iso(now - timedelta(minutes=15)),
            "last_results":          None,
        }
        col_res = db["api_monitor_collections"].insert_one(col_doc)
        col_id = col_res.inserted_id

        run_docs = []
        for i in range(3):
            ran_at = now - timedelta(minutes=15 + i * 60)
            passed = 2 if i > 0 else 3
            results = [
                {
                    "name": "Get health", "method": "GET", "url": "https://.../health",
                    "status": 200, "duration_ms": _rng.randint(40, 120), "response_size": 128,
                    "passed": True, "assertions": [], "error": None,
                    "failure_reason": None, "response_body": '{"status":"ok"}',
                },
                {
                    "name": "List orders", "method": "GET", "url": "https://.../api/v1/orders",
                    "status": 200, "duration_ms": _rng.randint(80, 300), "response_size": 2048,
                    "passed": True, "assertions": [], "error": None,
                    "failure_reason": None, "response_body": "[...]",
                },
                {
                    "name": "Create order", "method": "POST", "url": "https://.../api/v1/orders",
                    "status": 201 if i > 0 else 502,
                    "duration_ms": _rng.randint(100, 900), "response_size": 256,
                    "passed": i > 0, "assertions": [],
                    "error": None if i > 0 else "Bad Gateway",
                    "failure_reason": None if i > 0 else "Upstream returned 502",
                    "response_body": '{"error":"bad gateway"}' if i == 0 else '{"id":"ord_123"}',
                },
            ]
            run_docs.append({
                "collection_id": str(col_id),
                "cron_id":       None,
                "ran_at":        _iso(ran_at),
                "total":         3,
                "passed":        passed,
                "failed":        3 - passed,
                "duration_ms":   _rng.randint(300, 1200),
                "results":       results,
            })
        last_result_summary = {k: v for k, v in run_docs[0].items() if k != "_id"}
        db["api_monitor_cron_runs"].insert_many(run_docs)
        db["api_monitor_collections"].update_one(
            {"_id": col_id}, {"$set": {"last_results": last_result_summary}}
        )

        db["api_monitor_crons"].insert_one({
            "name":              f"{app} health check — every 15 min",
            "tenant":            tenant,
            "collection_id":     str(col_id),
            "collection_name":   col_doc["name"],
            "api_filter":        None,
            "schedule":          {"type": "interval", "interval_minutes": 15},
            "alert_emails":      [],
            "alert_condition":   "on_failure",
            "enabled":           True,
            "teams_enabled":     False,
            "teams_webhook_id":  None,
            "sla_response_ms":   None,
            "sla_pass_rate_pct": None,
            "created_at":        _iso(now - timedelta(days=3)),
            "last_run_at":       _iso(now - timedelta(minutes=15)),
            "last_results":      last_result_summary,
            "next_run_at":       _iso(now + timedelta(minutes=15)),
        })

    # Settings singletons — same defaults the app would create on first use.
    db["monitoring_settings"].insert_many([
        {
            "_id":               "large_workflow_detector",
            "threshold_bytes":   30_000_000,
            "interval_minutes":  30,
            "last_run_at":       _iso(now - timedelta(minutes=12)),
            "last_match_count":  len(large_file_docs),
        },
        {
            "_id":                          "data_retention",
            "retention_days":               14,
            "last_run_at":                  _iso(now - timedelta(hours=8)),
            "last_deleted_app_insights":    0,
            "last_deleted_tenant_insights": 0,
            "last_trimmed_wf_docs":        0,
        },
        {
            "_id":               "api_monitor_retention",
            "retention_days":    30,
            "last_run_at":       _iso(now - timedelta(hours=8)),
            "last_deleted_runs": 0,
        },
    ])

    # Jiffy integration — obviously fake/local target; "test connection" will
    # fail offline as expected, no live endpoint is ever contacted.
    db["jiffy_integrations"].insert_one({
        "env_name":      "demo",
        "url":           "https://demo.jiffy.local",
        "client_id":     "demo-client-id",
        "client_secret": "demo-client-secret",
    })

    # support_config / teams_webhooks intentionally left empty — the Settings
    # pages show their normal "not configured yet" empty state, and the
    # scheduled alert evaluator skips sending mail/Teams messages entirely.
