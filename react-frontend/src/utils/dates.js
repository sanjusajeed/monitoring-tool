// IST-aware date helpers. The whole app treats "the day" as the IST day
// (12:00 AM IST = 18:30 UTC the previous day) regardless of the browser's
// local timezone, so SREs in any timezone see the same labels and counters.

const IST_OFFSET_MIN = 5 * 60 + 30 // 5h30m
const DAY_MS = 86_400_000

// Integer day index in IST. Two timestamps with the same day index are on
// the same IST calendar day; subtracting indices gives a whole-day delta.
export function istDayKey(d) {
  return Math.floor((d.getTime() + IST_OFFSET_MIN * 60_000) / DAY_MS)
}

// Returns the UTC Date for 12:00 AM IST of the IST day containing `d`.
export function istMidnightUtc(d = new Date()) {
  const key = istDayKey(d)
  return new Date(key * DAY_MS - IST_OFFSET_MIN * 60_000)
}

// "Today" / "Yesterday" / "Nd ago" — bucketed by IST day boundaries.
export function relTime(iso) {
  if (!iso) return '—'
  const t = new Date(iso)
  if (Number.isNaN(t.getTime())) return '—'
  const delta = istDayKey(new Date()) - istDayKey(t)
  if (delta === 0) return 'Today'
  if (delta === 1) return 'Yesterday'
  if (delta < 0) return 'Today'
  return `${delta}d ago`
}

// ISO-8601 strings (with Z) for [12:00 AM IST today, now] — useful for
// passing as ?start/?end query params to backend endpoints that require them.
export function istTodayIsoRange() {
  const start = istMidnightUtc(new Date())
  const end = new Date()
  return { start: start.toISOString(), end: end.toISOString() }
}
