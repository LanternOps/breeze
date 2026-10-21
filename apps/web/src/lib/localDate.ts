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
