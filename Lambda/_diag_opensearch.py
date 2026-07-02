"""
Quick diagnostic — counts Istio ingress logs in OpenSearch for the last 30 min,
broken down by authority. Run directly from a machine with VPN access.

    python _diag_opensearch.py
"""
from datetime import datetime, timedelta, timezone

from log_analysis import _build_opensearch_client, _load_config

cfg = _load_config()
os_client = _build_opensearch_client(cfg["opensearch"])

end = datetime.now(timezone.utc).replace(second=0, microsecond=0)
start = end - timedelta(minutes=30)
fmt = "%Y-%m-%dT%H:%M:%SZ"
s_iso, e_iso = start.strftime(fmt), end.strftime(fmt)

print(f"Window: {s_iso} -> {e_iso}")
print(f"Index:  {cfg['opensearch']['index_pattern']}\n")

# Total doc count in window
body_total = {
    "size": 0,
    "query": {"range": {"@timestamp": {"gte": s_iso, "lte": e_iso}}},
    "aggs": {
        "by_authority": {
            "terms": {"field": "authority.keyword", "size": 25, "order": {"_count": "desc"}}
        }
    },
}
r = os_client.search(index=cfg["opensearch"]["index_pattern"], body=body_total)
total = r.get("hits", {}).get("total", {}).get("value", 0)
print(f"Total docs in window: {total}\n")

buckets = r.get("aggregations", {}).get("by_authority", {}).get("buckets", [])
if not buckets:
    print("No authority breakdown — either zero traffic or field mapping differs.")
else:
    print("Top authorities (top 25):")
    for b in buckets:
        print(f"  {b['doc_count']:>8}   {b['key']}")
