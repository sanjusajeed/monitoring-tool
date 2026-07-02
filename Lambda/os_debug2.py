"""Targeted diagnostic: compare what OpenSearch has vs what log_analysis.py captured.
Find ALL failed workflows in this time range, determine which axosclearing inst_id
they belong to, and identify any that are being missed."""
import yaml, json, re, httpx
from pathlib import Path
from opensearchpy import OpenSearch

cfg = yaml.safe_load(open(Path(__file__).parent / "config.yml"))
os_cfg = cfg["opensearch"]
client = OpenSearch(
    hosts=[{"host": os_cfg["host"].replace("https://","").rstrip("/"), "port": os_cfg["port"]}],
    http_auth=(os_cfg["username"], os_cfg["password"]),
    use_ssl=os_cfg.get("use_ssl", True),
    verify_certs=os_cfg.get("verify_certs", True),
    headers={"securitytenant": "global"},
    timeout=30,
)

START = "2026-04-09T00:00:00Z"
END   = "2026-04-10T23:59:59Z"
WF_RE = re.compile(r"((?:Jiffy|JM)_\d+)")

# ── 1. Get axosclearing inst_ids from Jiffy API ─────────────────────────────
print("="*80)
print("1. AXOSCLEARING INSTANCE IDS FROM JIFFY API")
print("="*80)
jiffy_cfg = cfg["jiffy"]
token_resp = httpx.post(
    f"{jiffy_cfg['url'].rstrip('/')}/apexiam/v1/auth/token",
    params={"tenantId": "jiffy"},
    data={
        "grant_type": "client_credentials",
        "client_id": jiffy_cfg["client_id"],
        "client_secret": jiffy_cfg["client_secret"],
        "scope": "openid",
    },
    headers={"Content-Type": "application/x-www-form-urlencoded"},
    timeout=15,
)
token_data = token_resp.json()
token = token_data.get("access_token") or token_data.get("token")
apps_resp = httpx.get(
    f"{jiffy_cfg['url'].rstrip('/')}/pam/tenant/axosclearing/app/list",
    params={"offset": 0, "limit": 50, "inst": "true"},
    headers={"Authorization": f"Bearer {token}", "Origin": "jiffy.ai"},
    timeout=15,
)
raw_apps = apps_resp.json()
apps = raw_apps if isinstance(raw_apps, list) else (
    raw_apps.get("apps") or raw_apps.get("applications") or raw_apps.get("data") or []
)

inst_ids = {}
for app in apps:
    app_name = app.get("displayName") or app.get("name") or "?"
    for inst in app.get("insts") or app.get("instances") or []:
        iid = str(inst.get("id") or "").strip()
        env = str(inst.get("environment") or "").strip()
        if iid:
            inst_ids[iid] = f"{app_name}/{env}"
            print(f"  {iid}  ->  {app_name}/{env}")

# ── 2. Find ALL failed workflow IDs in OpenSearch (no appId filter) ──────────
print("\n" + "="*80)
print("2. ALL FAILED WORKFLOWS IN OPENSEARCH (no tenant filter)")
print("="*80)
r = client.search(index="platform-*", body={
    "size": 2000,
    "sort": [{"@timestamp": {"order": "desc"}}],
    "_source": ["@timestamp", "message", "level", "correlationId", "appId",
                "tenantId", "processName", "workflowName"],
    "query": {"bool": {
        "must": [{"range": {"@timestamp": {"gte": START, "lte": END}}}],
        "should": [
            {"match_phrase": {"message": "Workflow execution failed"}},
            {"match_phrase": {"message": "Workflow execution failure"}},
            {"match_phrase": {"message": "Work FLow execution Failed"}},
            {"match_phrase": {"message": "WORKFLOW_EXECUTION_FAILED"}},
            {"match_phrase": {"message": "WorkflowException"}},
        ],
        "minimum_should_match": 1,
    }},
})
all_hits = r["hits"]["hits"]
print(f"Total hits: {r['hits']['total']['value']}, returned: {len(all_hits)}")

# Group by workflow ID -> collect all appIds
wf_map = {}
for h in all_hits:
    src = h["_source"]
    msg = str(src.get("message", ""))
    corr = str(src.get("correlationId", ""))
    m = WF_RE.search(corr) or WF_RE.search(msg)
    wf_id = m.group(1) if m else None
    if not wf_id:
        continue
    if wf_id not in wf_map:
        wf_map[wf_id] = {"app_ids": set(), "tenant_ids": set(), "process": "", "wf_name": "", "levels": set(), "msgs": []}
    entry = wf_map[wf_id]
    if src.get("appId"):
        entry["app_ids"].add(src["appId"])
    if src.get("tenantId"):
        entry["tenant_ids"].add(str(src["tenantId"]))
    entry["levels"].add(src.get("level", "?"))
    if not entry["process"] and src.get("processName"):
        entry["process"] = src["processName"]
    if not entry["wf_name"] and src.get("workflowName"):
        entry["wf_name"] = src["workflowName"]
    entry["msgs"].append(msg[:100])

print(f"\nTotal unique workflow IDs: {len(wf_map)}")

# ── 3. Filter to axosclearing only ──────────────────────────────────────────
print("\n" + "="*80)
print("3. WORKFLOWS BELONGING TO AXOSCLEARING (appId matches an inst_id)")
print("="*80)
axos_wfs = {}
for wf_id, info in wf_map.items():
    matching_inst = info["app_ids"] & set(inst_ids.keys())
    if matching_inst:
        axos_wfs[wf_id] = (info, matching_inst)

print(f"Axosclearing workflows: {len(axos_wfs)}")
for wf_id, (info, matching) in sorted(axos_wfs.items()):
    inst_labels = [inst_ids.get(iid, iid) for iid in matching]
    print(f"\n  {wf_id}")
    print(f"    app: {', '.join(inst_labels)}")
    print(f"    process: {info['process']}")
    print(f"    levels: {info['levels']}")
    print(f"    all appIds: {info['app_ids']}")

# ── 4. Check for workflows with NO appId at all ─────────────────────────────
print("\n" + "="*80)
print("4. WORKFLOWS WITH NO appId ON ANY LOG")
print("="*80)
no_appid = {wf_id: info for wf_id, info in wf_map.items() if not info["app_ids"]}
print(f"Workflows with no appId at all: {len(no_appid)}")
for wf_id, info in sorted(no_appid.items()):
    print(f"  {wf_id}  tenantIds={info['tenant_ids']}  levels={info['levels']}")
    print(f"    msg: {info['msgs'][0][:120]}")

# ── 5. Check for workflows with appId that doesn't match ANY inst_id ────────
print("\n" + "="*80)
print("5. WORKFLOWS WITH appId NOT MATCHING ANY AXOSCLEARING INST_ID")
print("="*80)
unmatched = {}
for wf_id, info in wf_map.items():
    if info["app_ids"] and not (info["app_ids"] & set(inst_ids.keys())):
        unmatched[wf_id] = info
print(f"Unmatched workflows (belong to other tenants): {len(unmatched)}")
# Just show unique appIds from unmatched
other_app_ids = set()
for info in unmatched.values():
    other_app_ids |= info["app_ids"]
print(f"Unique non-axosclearing appIds: {len(other_app_ids)}")
for aid in sorted(other_app_ids)[:20]:
    count = sum(1 for info in unmatched.values() if aid in info["app_ids"])
    print(f"  {aid}  ({count} workflows)")

# ── 6. Check tenantId on the axos workflows ─────────────────────────────────
print("\n" + "="*80)
print("6. AXOSCLEARING tenantId VALUES (for potential alternative filtering)")
print("="*80)
all_tenant_ids = set()
for wf_id, (info, _) in axos_wfs.items():
    all_tenant_ids |= info["tenant_ids"]
print(f"Unique tenantId values on axosclearing workflows: {all_tenant_ids}")

# ── 7. Summary by inst_id ───────────────────────────────────────────────────
print("\n" + "="*80)
print("7. WORKFLOW COUNT PER AXOSCLEARING APP/INSTANCE")
print("="*80)
per_inst = {iid: [] for iid in inst_ids}
for wf_id, (info, matching) in axos_wfs.items():
    for iid in matching:
        per_inst[iid].append(wf_id)
for iid, wfs in per_inst.items():
    label = inst_ids[iid]
    print(f"  {label}: {len(wfs)} workflow(s)")
    for wf_id in wfs[:5]:
        print(f"    - {wf_id}")
    if len(wfs) > 5:
        print(f"    ... and {len(wfs) - 5} more")

# ── 8. Compare with what log_analysis.py would find ─────────────────────────
print("\n" + "="*80)
print("8. STEP 1a SIMULATION: what the appId-filtered query finds per inst_id")
print("="*80)
for iid, label in inst_ids.items():
    r_sim = client.search(index="platform-*", body={
        "size": 500,
        "_source": ["correlationId", "message", "level"],
        "query": {"bool": {
            "must": [
                {"range": {"@timestamp": {"gte": START, "lte": END}}},
                {"term": {"appId.keyword": iid}},
            ],
            "should": [
                {"match_phrase": {"message": "Workflow execution failed"}},
                {"match_phrase": {"message": "Workflow execution failure"}},
                {"match_phrase": {"message": "Work FLow execution Failed"}},
                {"match_phrase": {"message": "WORKFLOW_EXECUTION_FAILED"}},
                {"match_phrase": {"message": "WorkflowException"}},
            ],
            "minimum_should_match": 1,
        }},
    })
    found_ids = set()
    for h in r_sim["hits"]["hits"]:
        src = h["_source"]
        corr = str(src.get("correlationId", ""))
        msg = str(src.get("message", ""))
        m = WF_RE.search(corr) or WF_RE.search(msg)
        if m:
            found_ids.add(m.group(1))
    print(f"  {label}: {len(found_ids)} workflow(s) found by Step 1a query")
    for wf in sorted(found_ids):
        print(f"    - {wf}")
