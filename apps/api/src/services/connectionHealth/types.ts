import type { Permission } from '../permissions';

export const CONNECTION_SOURCE_KINDS = ['oauth_grant'] as const;   // W2+ appends
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
  intervalMinutes: number;
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
  | { type: 'reopen'; incidentId: string; obs: HealthObservation }
  | { type: 'deletePending'; incidentId: string };

export const REOPEN_WINDOW_MS = 60 * 60 * 1000;
export const HEALTHY_TO_RESOLVE = 2;
