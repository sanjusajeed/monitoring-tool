"""Retry workflow_executions trim after space was freed. Run once."""
import sys, os
sys.path.insert(0, os.path.dirname(__file__))
from datetime import datetime, timezone, timedelta
from database import get_db

db = get_db()

stats = db.command("dbstats")
data_mb = stats["dataSize"] / 1024 / 1024
idx_mb  = stats["indexSize"] / 1024 / 1024
print(f"Current DB: {data_mb + idx_mb:.1f} MB  (data {data_mb:.1f} + index {idx_mb:.1f})")

cutoff = (datetime.now(timezone.utc) - timedelta(days=14)).isoformat()
print(f"\nTrimming workflow_executions older than {cutoff[:10]} (using server-side $pull)...")

result = db["workflow_executions"].update_many(
    {"executions.start_time": {"$lt": cutoff}},
    {"$pull": {"executions": {"start_time": {"$lt": cutoff}}}},
)
print(f"\nDone. Modified {result.modified_count} docs.")

stats2 = db.command("dbstats")
d2 = stats2["dataSize"] / 1024 / 1024
i2 = stats2["indexSize"] / 1024 / 1024
print(f"Final DB: {d2 + i2:.1f} MB  (data {d2:.1f} + index {i2:.1f})")
