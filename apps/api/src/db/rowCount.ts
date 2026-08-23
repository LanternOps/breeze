/**
 * Row count out of a driver result, across the three shapes this codebase sees.
 *
 * `drizzle-orm/postgres-js` `execute()` resolves to a postgres-js `Result`,
 * which extends Array and carries `.count` — NOT node-postgres' `.rowCount` /
 * `.rows`. Reading the wrong one yields 0 on every call, which in a batched
 * delete ends the loop early and silently leaves rows behind, and in a lock
 * check reports the exact opposite of the truth.
 *
 * This lives in `db/` rather than in one of the retention jobs so that a
 * REQUEST-PATH service can use it without importing from `jobs/`, which would
 * invert services→jobs and pull BullMQ + ioredis into the module graph of a
 * plain DELETE.
 *
 * Note there are still several private copies of this check in `jobs/` and
 * other services. Consolidating them is worthwhile but is not this change.
 */
export function extractRowCount(result: unknown): number {
  // Deliberately NOT null-safe. postgres-js never resolves a successful
  // statement to null/undefined — a genuine zero-row result is an array-like
  // `Result` with `.count === 0`. Mapping null to 0 would conflate "broken
  // driver/adapter/mock" with "no rows", and 0 is load-bearing in both kinds of
  // caller: here it means "the parent lock was not held", and in the batched
  // retention loops it TERMINATES the loop and leaves old rows behind. Letting
  // the property read throw keeps a broken contract loud.
  const raw = result as { rowCount?: number; count?: number };
  if (typeof raw.rowCount === 'number') return raw.rowCount;
  if (typeof raw.count === 'number') return raw.count;
  return Array.isArray(result) ? (result as unknown[]).length : 0;
}
