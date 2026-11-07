/**
 * Request-pool size, shared by the pool itself (`db/index.ts`) and by workers
 * that size their concurrency against it (the alert worker, #10859).
 *
 * Kept in its own module so a worker can read it without importing the pool.
 *
 * Pool sizing: postgres-js defaults to max=10, which causes cascading 504s
 * under heartbeat storms (e.g. a 1000-agent fleet reconnecting at once).
 * Default to 30 and allow tuning via DB_POOL_MAX.
 */
export const DEFAULT_DB_POOL_MAX = 30;

export function getDbPoolMax(): number {
  const raw = Number.parseInt(process.env.DB_POOL_MAX ?? '', 10);
  if (!Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_DB_POOL_MAX;
  }
  return raw;
}
