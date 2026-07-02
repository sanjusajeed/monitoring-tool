import mongomock

from config import get_config
from seed_data import seed_demo_data

_client: mongomock.MongoClient | None = None
_db = None


def get_db():
    """In-memory mock database for this demo build — no live MongoDB
    connection is made. Seeded once per process with fabricated demo data
    (see seed_data.py) so the UI has something to render."""
    global _client, _db
    if _db is None:
        mongo_cfg = get_config()["mongodb"]
        _client = mongomock.MongoClient()
        _db = _client[mongo_cfg["database"]]
        seed_demo_data(_db)
    return _db
