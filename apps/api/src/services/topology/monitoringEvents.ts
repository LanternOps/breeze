/**
 * Typed recurring-monitoring outbox events (M3-D15). A dependency-free leaf.
 *
 * Every event is inserted with `delivered_at` pre-stamped so the legacy graph
 * replay never consumes it; its own consumer selects on `event_kind` and the
 * payload `state`, and retention never prunes a `pending` one
 * (`legacyRetention.ts`). The outbox idempotency key is derived from the
 * occurrence key, so a crash/redelivery can never double-apply or double-notify.
 */
export const TOPOLOGY_MONITORING_GAP_EVENT = 'monitoring.gap' as const;
export const TOPOLOGY_MONITORING_ALERT_EVENT = 'monitoring.alert_transition' as const;

export type TopologyMonitoringEventState = 'pending' | 'applied';

/** A scheduled slot that produced no measurement (missed, budget, no collector, drift). */
export type TopologyMonitoringGapEvent = {
  version: 1;
  kind: typeof TOPOLOGY_MONITORING_GAP_EVENT;
  state: TopologyMonitoringEventState;
  policyId: string;
  policyRevision: string;
  contextKey: string;
  family: 'ipv4' | 'ipv6';
  scheduledFor: string;
  occurrenceKey: string;
  reason: string;
  missedCount: number;
  missedFrom: string | null;
  missedTo: string | null;
};

/** A committed site-owned alert transition waiting for notification fan-out. */
export type TopologyMonitoringAlertEvent = {
  version: 1;
  kind: typeof TOPOLOGY_MONITORING_ALERT_EVENT;
  state: TopologyMonitoringEventState;
  action: 'open' | 'recover';
  alertId: string;
  policyId: string;
  contextKey: string;
  family: 'ipv4' | 'ipv6';
  occurrenceKey: string;
};
