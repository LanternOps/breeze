/**
 * Domain vocabulary for the M365 tenant sync (spec §3.1, §5.2, §5.7).
 *
 * Pure constants: this module is reachable from the `@breeze/shared` root
 * barrel, which apps/web bundles for the browser, so it must not import
 * node:crypto or anything else Node-only.
 */

export const M365_SYNC_DOMAINS = [
  'users',
  'signin_activity',
  'intune_devices',
  'ca_policies',
  'skus',
  'secure_score',
  'signin_events',
] as const;

export type M365SyncDomain = typeof M365_SYNC_DOMAINS[number];

const HOUR = 3600;

/** Starting cadence for a freshly seeded connection. Adaptive cadence (§5.7) moves within the bounds below. */
export const M365_SYNC_DOMAIN_DEFAULT_INTERVAL_SECONDS: Record<M365SyncDomain, number> = {
  users: 6 * HOUR,
  signin_activity: 24 * HOUR,
  intune_devices: 6 * HOUR,
  ca_policies: 24 * HOUR,
  skus: 24 * HOUR,
  secure_score: 24 * HOUR,
  signin_events: 24 * HOUR,
};

/**
 * Adaptive cadence may never leave these. signin_activity's floor is a full
 * day because Graph throttles /users?$select=signInActivity at 10 requests per
 * minute PER APP ACROSS ALL TENANTS (spec §0.1) — a per-tenant hourly cadence
 * would exhaust the app-wide budget at a few hundred connections.
 */
export const M365_SYNC_DOMAIN_INTERVAL_BOUNDS: Record<M365SyncDomain, { min: number; max: number }> = {
  users: { min: HOUR, max: 48 * HOUR },
  signin_activity: { min: 24 * HOUR, max: 7 * 24 * HOUR },
  intune_devices: { min: HOUR, max: 48 * HOUR },
  ca_policies: { min: HOUR, max: 48 * HOUR },
  skus: { min: HOUR, max: 48 * HOUR },
  secure_score: { min: HOUR, max: 48 * HOUR },
  // #5784 W05. /auditLogs/signIns is a DIFFERENT Graph surface from
  // signin_activity's /users?$select=signInActivity and has its own token
  // bucket in the executor, but it is the other expensive identity surface, so
  // it carries the same full-day floor.
  signin_events: { min: 24 * HOUR, max: 7 * 24 * HOUR },
};

const DOMAIN_SET: ReadonlySet<string> = new Set(M365_SYNC_DOMAINS);

export function isM365SyncDomain(value: string): value is M365SyncDomain {
  return DOMAIN_SET.has(value);
}
