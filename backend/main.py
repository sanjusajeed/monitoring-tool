import logging
import random
import time
from datetime import datetime, timedelta, timezone

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from jobs.alert_evaluator import evaluate_all_rules
from jobs.api_monitor_cron import run_api_monitor_crons
from jobs.data_retention import run_data_retention
from jobs.large_workflow_detector import detect_large_workflows
from routers import jiffy, insights, timeseries, temporal, dashboard, support, settings, alerts, sev_a, api_monitor, crons, teams_webhooks

log = logging.getLogger(__name__)

app = FastAPI(title="Monitoring App API")

# Single-process scheduler. Deploy with `--workers 1` or add a Mongo lock in
# evaluate_all_rules() before scaling out; otherwise each worker would fire
# the job in parallel and we'd send duplicate emails.
scheduler = AsyncIOScheduler(timezone="UTC")


@app.on_event("startup")
async def _start_scheduler():
    # First run 30 s after boot so a freshly-started backend can evaluate
    # without waiting 30 min for the first tick.
    scheduler.add_job(
        evaluate_all_rules, "interval", minutes=30,
        id="alert_evaluator", max_instances=1, coalesce=True,
        next_run_time=datetime.now(timezone.utc) + timedelta(seconds=30),
    )
    scheduler.add_job(
        run_api_monitor_crons, "interval", minutes=1,
        id="api_monitor_cron", max_instances=1, coalesce=True,
    )
    scheduler.add_job(
        detect_large_workflows, "interval", minutes=5,
        id="large_workflow_detector", max_instances=1, coalesce=True,
        next_run_time=datetime.now(timezone.utc) + timedelta(seconds=60),
    )
    # Nightly cleanup at 12:00 AM IST = 18:30 UTC
    scheduler.add_job(
        run_data_retention, "cron", hour=18, minute=30,
        id="data_retention_nightly", max_instances=1, coalesce=True,
        timezone="UTC",
    )
    scheduler.start()
    next_run = scheduler.get_job("alert_evaluator").next_run_time
    log.info("alert evaluator scheduled — next run at %s", next_run)
    print(f"⏰ alert evaluator scheduled — next run at {next_run}", flush=True)
    print("⏰ api monitor cron runner scheduled — every 1 minute", flush=True)
    print("⏰ large workflow detector scheduled — every 5 minutes (first run in 60 s)", flush=True)
    print("⏰ data retention scheduled — nightly at 12:00 AM IST (18:30 UTC)", flush=True)


@app.on_event("shutdown")
async def _stop_scheduler():
    scheduler.shutdown(wait=False)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ─── Request log ──────────────────────────────────────────────────────────────
# Prints every API hit to stdout (the PowerShell where uvicorn is running) so
# you can see which endpoint the UI is hitting and how long it takes. Each line:
#   → GET /api/insights/summary?start=...
#   ← GET /api/insights/summary 200 in 23.79 s
@app.middleware("http")
async def log_requests(request: Request, call_next):
    method = request.method
    path   = request.url.path
    query  = ("?" + request.url.query) if request.url.query else ""
    print(f"→ {method} {path}{query}", flush=True)
    t0 = time.perf_counter()
    try:
        response = await call_next(request)
    except Exception as e:
        dt = time.perf_counter() - t0
        print(f"✗ {method} {path} FAILED in {dt*1000:.0f} ms: {e!r}", flush=True)
        raise
    dt = time.perf_counter() - t0
    # Use seconds for slow calls, ms for quick ones — easier to scan
    timing = f"{dt:.2f} s" if dt >= 1.0 else f"{dt*1000:.0f} ms"
    print(f"← {method} {path} {response.status_code} in {timing}", flush=True)
    return response


START_TIME = time.time()


@app.get("/api/status")
def get_status():
    uptime_seconds = int(time.time() - START_TIME)
    hours = uptime_seconds // 3600
    minutes = (uptime_seconds % 3600) // 60
    seconds = uptime_seconds % 60

    cpu_usage = round(random.uniform(10.0, 85.0), 1)
    memory_usage = round(random.uniform(30.0, 75.0), 1)
    disk_usage = round(random.uniform(40.0, 70.0), 1)
    network_in = round(random.uniform(1.0, 50.0), 2)
    network_out = round(random.uniform(0.5, 20.0), 2)

    if cpu_usage > 75 or memory_usage > 70:
        status = "warning"
    else:
        status = "healthy"

    return {
        "status": status,
        "cpu_usage": cpu_usage,
        "memory_usage": memory_usage,
        "disk_usage": disk_usage,
        "network_in_mbps": network_in,
        "network_out_mbps": network_out,
        "uptime": f"{hours:02d}:{minutes:02d}:{seconds:02d}",
        "uptime_seconds": uptime_seconds,
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }


app.mount("/static", StaticFiles(directory="static"), name="static")

app.include_router(jiffy.router)
app.include_router(insights.router)
app.include_router(timeseries.router)
app.include_router(temporal.router)
app.include_router(dashboard.router)
app.include_router(support.router)
app.include_router(settings.router)
app.include_router(alerts.router)
app.include_router(sev_a.router)
app.include_router(api_monitor.router)
app.include_router(crons.router)
app.include_router(teams_webhooks.router)


@app.get("/")
def root():
    return {"message": "Monitoring App API is running. Visit /api/status for metrics."}
