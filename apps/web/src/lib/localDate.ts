/**
 * `YYYY-MM-DD` for the user's LOCAL calendar day, suitable for `<input type="date">`
 * defaults. `toISOString().slice(0, 10)` is the UTC day and pre-fills tomorrow
 * in the evening for anyone west of UTC (#9263).
 */
export function localDateInputValue(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Converts a `YYYY-MM-DD` value from `<input type="date">` into an ISO datetime
 * for the last millisecond of that day in the user's LOCAL timezone (#9654), so
 * an expiry "on the 30th" holds through the whole of the 30th where the user
 * is. Returns null for anything that is not a real calendar date (malformed, or
 * a rollover such as 2026-02-31).
 */
export function endOfLocalDayIso(date: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const end = new Date(year, month - 1, day, 23, 59, 59, 999);
  if (end.getFullYear() !== year || end.getMonth() !== month - 1 || end.getDate() !== day) {
    return null;
  }
  return end.toISOString();
}
