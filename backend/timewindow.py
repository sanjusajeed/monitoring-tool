"""IST-aware day-window helpers used by the API to compute 'today' counters."""
from datetime import datetime, timezone, timedelta
from zoneinfo import ZoneInfo

IST = ZoneInfo("Asia/Kolkata")


def ist_day_window(now_utc: datetime | None = None) -> tuple[datetime, datetime]:
    """Return (start_utc, end_utc) covering the current IST day [00:00 IST, now].

    'Today' rolls over at 12:00 AM IST (= 18:30 UTC the previous day).
    Both returned datetimes are timezone-aware UTC.
    """
    if now_utc is None:
        now_utc = datetime.now(timezone.utc)
    elif now_utc.tzinfo is None:
        now_utc = now_utc.replace(tzinfo=timezone.utc)

    now_ist = now_utc.astimezone(IST)
    start_ist = now_ist.replace(hour=0, minute=0, second=0, microsecond=0)
    start_utc = start_ist.astimezone(timezone.utc)
    return start_utc, now_utc


def parse_iso_to_utc(value) -> datetime | None:
    """Parse an ISO-8601 string (or pass through a datetime) into a UTC datetime."""
    if value is None:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, str):
        s = value.replace("Z", "+00:00")
        try:
            dt = datetime.fromisoformat(s)
        except ValueError:
            return None
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    return None
