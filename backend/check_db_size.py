"""Run from backend/: python check_db_size.py"""
import sys, os
sys.path.insert(0, os.path.dirname(__file__))
from database import get_db

db = get_db()

stats = db.command("dbstats")
print(f"\nDatabase: {db.name}")
print(f"Total size:      {stats['dataSize']/1024/1024:.1f} MB")
print(f"Storage on disk: {stats['storageSize']/1024/1024:.1f} MB")
print(f"Index size:      {stats['indexSize']/1024/1024:.1f} MB")
print(f"Total (data+idx):{(stats['dataSize']+stats['indexSize'])/1024/1024:.1f} MB")

print("\nCollection breakdown (sorted by size):")
print(f"{'Collection':<45} {'Data MB':>8} {'Docs':>10} {'Index MB':>9}")
print("-" * 75)

rows = []
for name in db.list_collection_names():
    try:
        cs = db.command("collstats", name)
        data_mb  = cs.get("size", 0) / 1024 / 1024
        idx_mb   = cs.get("totalIndexSize", 0) / 1024 / 1024
        count    = cs.get("count", 0)
        rows.append((data_mb + idx_mb, name, data_mb, count, idx_mb))
    except Exception as e:
        print(f"  {name}: error — {e}")

for total, name, data_mb, count, idx_mb in sorted(rows, reverse=True):
    print(f"  {name:<43} {data_mb:>8.2f} {count:>10,} {idx_mb:>9.2f}")
