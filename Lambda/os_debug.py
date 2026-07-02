"""Quick OpenSearch diagnostic: find ALL workflow failure logs for axosclearing time range."""
import yaml, json, re
from pathlib import Path
from opensearchpy import OpenSearch

cfg = yaml.safe_load(open(Path(__file__).parent / "config.yml"))
os_cfg = cfg["opensearch"]
client = OpenSearch(
    hosts=[{"host": os_cfg["host"].replace("https://",""), "port": os_cfg["port"]}],
    http_auth=(os_cfg["username"], os_cfg["password"]),
    use_ssl=os_cfg.get("use_ssl", True),
    verify_certs=os_cfg.get("verify_certs", True),
)

START = "2026-04-09T00:00:00Z"
END   = "2026-04-10T23:59:59Z"
WF_RE = re.compile(r"((?:Jiffy|JM)_\d+)")

# Query 1: ALL workflow failure logs without appId restriction
print("="*80)
print("QUERY 1: All workflow failure messages (no appId filter)")
print("="*80)
r = client.search(index="platform-*", body={
    "size": 500,
    "sort": [{"@timestamp": {"order": "desc"}}],
    "_source": ["@timestamp", "message", "level", "correlationId", "appId", "tenantId",
                "processName", "workflowName", "logger_name", "kubernetes.pod_name",
                "kubernetes.labels.apex-app", "stack_trace"],
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
hits = r["hits"]["hits"]
print(f"Total hits: {r['hits']['total']['value']}, returned: {len(hits)}")

# Group by workflow ID
wf_map = {}
for h in hits:
    src = h["_source"]
    msg = str(src.get("message",""))
    corr = str(src.get("correlationId",""))
    m = WF_RE.search(corr) or WF_RE.search(msg)
    wf_id = m.group(1) if m else "UNKNOWN"
    if wf_id not in wf_map:
        wf_map[wf_id] = []
    wf_map[wf_id].append({
        "ts": src.get("@timestamp",""),
        "level": src.get("level",""),
        "appId": src.get("appId"),
        "tenantId": src.get("tenantId"),
        "processName": src.get("processName"),
        "pod": (src.get("kubernetes") or {}).get("pod_name"),
        "apex_app": ((src.get("kubernetes") or {}).get("labels") or {}).get("apex-app"),
        "logger": src.get("logger_name","")[:60],
        "msg_snippet": msg[:150],
        "has_stack": bool(src.get("stack_trace")),
    })

print(f"\nUnique workflow IDs found: {len(wf_map)}")
for wf_id, logs in sorted(wf_map.items()):
    app_ids = set(l["appId"] for l in logs if l["appId"])
    pods = set(l["pod"] for l in logs if l["pod"])
    apex_apps = set(l["apex_app"] for l in logs if l["apex_app"])
    levels = set(l["level"] for l in logs)
    proc = next((l["processName"] for l in logs if l.get("processName")), "")
    print(f"\n  {wf_id}  ({len(logs)} logs)")
    print(f"    appId: {app_ids or 'NONE'}")
    print(f"    pods: {pods}")
    print(f"    apex-app labels: {apex_apps}")
    print(f"    levels: {levels}")
    print(f"    processName: {proc}")
    for l in logs[:3]:
        print(f"    [{l['ts']}] [{l['level']}] {l['msg_snippet']}")

# Query 2: Check which appIds exist for axosclearing
print("\n" + "="*80)
print("QUERY 2: All unique appIds that have workflow-related logs")
print("="*80)
r2 = client.search(index="platform-*", body={
    "size": 0,
    "query": {"bool": {
        "must": [
            {"range": {"@timestamp": {"gte": START, "lte": END}}},
        ],
        "should": [
            {"match_phrase": {"message": "Workflow execution"}},
            {"match_phrase": {"message": "workflowId"}},
        ],
        "minimum_should_match": 1,
    }},
    "aggs": {
        "appIds": {"terms": {"field": "appId.keyword", "size": 50}},
    }
})
for b in r2["aggregations"]["appIds"]["buckets"]:
    print(f"  appId: {b['key']}  count: {b['doc_count']}")

# Query 3: Workflow failure logs WITHOUT appId field
print("\n" + "="*80)
print("QUERY 3: Workflow failure logs that have NO appId field")
print("="*80)
r3 = client.search(index="platform-*", body={
    "size": 100,
    "sort": [{"@timestamp": {"order": "desc"}}],
    "_source": ["@timestamp", "message", "level", "correlationId", "processName",
                "kubernetes.pod_name", "kubernetes.labels.apex-app", "stack_trace"],
    "query": {"bool": {
        "must": [{"range": {"@timestamp": {"gte": START, "lte": END}}}],
        "must_not": [{"exists": {"field": "appId"}}],
        "should": [
            {"match_phrase": {"message": "Workflow execution failed"}},
            {"match_phrase": {"message": "Workflow execution failure"}},
            {"match_phrase": {"message": "WORKFLOW_EXECUTION_FAILED"}},
            {"match_phrase": {"message": "WorkflowException"}},
        ],
        "minimum_should_match": 1,
    }},
})
hits3 = r3["hits"]["hits"]
print(f"Total: {r3['hits']['total']['value']}, returned: {len(hits3)}")
no_appid_wfs = set()
for h in hits3:
    src = h["_source"]
    msg = str(src.get("message",""))
    m = WF_RE.search(str(src.get("correlationId",""))) or WF_RE.search(msg)
    wf_id = m.group(1) if m else "?"
    no_appid_wfs.add(wf_id)
    pod = (src.get("kubernetes") or {}).get("pod_name","")
    print(f"  [{src.get('@timestamp','')}] [{src.get('level','')}] pod={pod} wf={wf_id}")
    print(f"    msg: {msg[:200]}")

print(f"\nWorkflow IDs with NO appId: {no_appid_wfs}")
# Check which of these also have logs WITH appId
for wf_id in no_appid_wfs:
    if wf_id in wf_map:
        app_ids = set(l["appId"] for l in wf_map[wf_id] if l["appId"])
        if app_ids:
            print(f"  {wf_id}: also has logs WITH appId={app_ids}")
        else:
            print(f"  {wf_id}: *** ALL logs lack appId - this workflow is INVISIBLE to current queries ***")
