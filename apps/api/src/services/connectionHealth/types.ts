import type { SQL, SQLWrapper } from 'drizzle-orm';
import type { Permission } from '../permissions';

export const CONNECTION_SOURCE_KINDS = [
  'oauth_grant',
  // W2: existing integrations (spec §3).
  'huntress',
  'sentinelone',
  'pax8',
  'unifi',
  'backup_provider',
  'edr',
  'accounting',
  'dns_filter',
  'm365_connection',
  'm365_sync',
  'ticket_mailbox',
  // W4: connections that fail without writing a failure (spec §3).
  'webhook',
] as const;
export type ConnectionSourceKind = (typeof CONNECTION_SOURCE_KINDS)[number];
export type HealthState = 'healthy' | 'broken' | 'unknown' | 'retired';
export type HealthSeverity = 'permanent' | 'transient';

export type HealthObservation = {
  sourceKind: ConnectionSourceKind;
  sourceId: string;
  partnerId: string;
  orgId: string | null;
  ownerUserId: string | null;
  state: HealthState;
  severity: HealthSeverity;
  condition: string;
  detail: string | null;
  displayName: string;
  fixHref: string;
  ownerFixHref: string | null;
  viewPermission: Permission;
  repairPermission: Permission;
  observedAt: Date;
};

export interface HealthSource {
  kind: ConnectionSourceKind;
  /** Minutes between observations; a multiple of 15 matched to the signal's own cadence (spec §1.3). */
  intervalMinutes: number;
  /** Connection tables this source covers (source-coverage contract, spec §1.1). */
  tables: readonly string[];
  /** Every fixHref / ownerFixHref this source can emit (fix-link contract). */
  fixHrefs: readonly string[];
  /** The broken-set query observe() runs; the index contract EXPLAINs it (spec §1.3). */
  brokenQuery(now: Date): SQL | SQLWrapper;
  observe(now: Date, trackedSourceIds: readonly string[]): Promise<HealthObservation[]>;
}

/** An incident row as the reconciler sees it: open, pending (openedAt null), or resolved within the reopen window. */
export type TrackedIncident = {
  id: string;
  sourceId: string;
  severity: HealthSeverity;
  openedAt: Date | null;
  resolvedAt: Date | null;
  healthyStreak: number;
};

export type PendingNotice = 'opened' | 'escalated' | 'resolved';

export type TransitionAction =
  | { type: 'insertPending'; obs: HealthObservation }
  | { type: 'insertOpen'; obs: HealthObservation; notify: boolean }
  | { type: 'promotePending'; incidentId: string; obs: HealthObservation; notify: boolean }
  | { type: 'update'; incidentId: string; obs: HealthObservation; escalated: boolean }
  | { type: 'healthyTick'; incidentId: string; healthyStreak: number }
  | { type: 'resolve'; incidentId: string; resolution: 'recovered' | 'retired' }
  /** Same episode: keeps opened_at; notifies only when it escalates (spec §1.2, W2). */
  | { type: 'reopen'; incidentId: string; obs: HealthObservation; escalated: boolean }
  | { type: 'deletePending'; incidentId: string };

export const REOPEN_WINDOW_MS = 60 * 60 * 1000;

/**
 * Reopen window for a source (spec §1.2, amended W2): at least an hour, and at
 * least two observation intervals plus 5 minutes of schedule jitter, so a flap
 * on an hourly source is still a reopen of the same episode.
 */
export function reopenWindowMs(intervalMinutes: number): number {
  return Math.max(REOPEN_WINDOW_MS, (2 * intervalMinutes + 5) * 60_000);
}
export const HEALTHY_TO_RESOLVE = 2;
