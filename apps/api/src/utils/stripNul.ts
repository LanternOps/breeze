/**
 * Recursively remove U+0000 from strings, array items, and object keys.
 *
 * Postgres rejects U+0000 in text (22021) and jsonb (22P05), and one bad value
 * aborts a whole multi-row insert. Agent ingest strips instead of rejecting so
 * one bad value does not cost every other row in the batch (#8020 change
 * batches; agent diagnostic logs, where Windows UTF-16 command output was
 * decoded byte-wise into the log fields).
 */
export function stripNul<T>(value: T): T {
  if (typeof value === 'string') {
    return (value.includes('\u0000') ? value.replaceAll('\u0000', '') : value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => stripNul(item)) as T;
  }
  if (value !== null && typeof value === 'object') {
    // fromEntries defines own properties, so a literal "__proto__" key survives.
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [stripNul(k), stripNul(v)]),
    ) as T;
  }
  return value;
}
