/** Per-process exponential backoff for topology sites whose turn failed.
 * The repair and reconcile workers tick every 2 s; a site that fails for a
 * non-transient reason (BREEZE-4B/4C: "Conflicting pins stop canonical merge")
 * used to reload and roll back its whole graph on every tick and report each
 * failure to Sentry. Progress state stays in the database; this only spaces
 * out the attempts and is forgotten on restart or the first success. */
export function createTopologySiteBackoff(options: { baseMs: number; maxMs: number }) {
  const sites = new Map<string, { failures: number; retryAt: number }>();
  const key = (row: { org_id: string; site_id: string }) => `${row.org_id}:${row.site_id}`;
  return {
    ready(row: { org_id: string; site_id: string }): boolean {
      const entry = sites.get(key(row));
      return !entry || Date.now() >= entry.retryAt;
    },
    /** Returns the delay before the site's next attempt. */
    failed(row: { org_id: string; site_id: string }): number {
      const failures = (sites.get(key(row))?.failures ?? 0) + 1;
      const delayMs = Math.min(options.maxMs, options.baseMs * 2 ** Math.min(failures - 1, 30));
      sites.set(key(row), { failures, retryAt: Date.now() + delayMs });
      return delayMs;
    },
    succeeded(row: { org_id: string; site_id: string }): void {
      sites.delete(key(row));
    },
    clear(): void {
      sites.clear();
    },
  };
}

export const TOPOLOGY_SITE_BACKOFF = { baseMs: 2000, maxMs: 15 * 60_000 };
