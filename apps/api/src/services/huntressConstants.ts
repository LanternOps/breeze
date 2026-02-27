/**
 * Shared constants for Huntress integration.
 *
 * These are referenced by the sync job, route handlers, and AI tools.
 * Keep them in one place so changes propagate consistently.
 */

/** Agent statuses that indicate the agent is offline/unreachable. */
export const HUNTRESS_OFFLINE_STATUSES = ['offline', 'inactive', 'disconnected', 'dead'] as const;

/** Incident statuses that indicate resolution. */
export const HUNTRESS_RESOLVED_STATUSES = ['resolved', 'closed', 'dismissed'] as const;

/** Known normalized severity values produced by the Huntress client. */
export const HUNTRESS_SEVERITY_VALUES = ['critical', 'high', 'medium', 'low'] as const;

/** Known normalized incident status values produced by the Huntress client. */
export const HUNTRESS_INCIDENT_STATUS_VALUES = ['open', 'in_progress', 'resolved', 'dismissed'] as const;

/** SQL fragment helpers for use in raw SQL conditions. */
export function offlineStatusSqlList(): string {
  return HUNTRESS_OFFLINE_STATUSES.map(s => `'${s}'`).join(', ');
}

export function resolvedStatusSqlList(): string {
  return HUNTRESS_RESOLVED_STATUSES.map(s => `'${s}'`).join(', ');
}
