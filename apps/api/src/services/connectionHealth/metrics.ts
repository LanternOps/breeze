import { Counter, type Registry } from 'prom-client';
import { CONNECTION_SOURCE_KINDS } from './types';

/**
 * Prometheus surface for connection health (spec 2026-10-15 §8). Same shape as
 * services/m365Sync/metrics.ts: a settable recorder so the notifier emits
 * without importing routes/metrics, and one register* the route calls at
 * startup. Until then every record* is a no-op.
 *
 * The daily zero-recipient count of §8 is
 * `increase(breeze_connection_health_zero_recipient_incidents_total[24h])`.
 */
export const ZERO_RECIPIENT_METRIC = 'breeze_connection_health_zero_recipient_incidents_total';

export interface ConnectionHealthMetricsRecorder {
  onZeroRecipientIncident: (sourceKind: string) => void;
}

const emptyRecorder: ConnectionHealthMetricsRecorder = { onZeroRecipientIncident: () => {} };
let recorder: ConnectionHealthMetricsRecorder = emptyRecorder;

export function setConnectionHealthMetricsRecorder(next: Partial<ConnectionHealthMetricsRecorder> | null | undefined): void {
  recorder = { ...emptyRecorder, ...(next ?? {}) };
}

const KNOWN_KINDS: ReadonlySet<string> = new Set(CONNECTION_SOURCE_KINDS);

/** An incident delivered its notice to nobody (no user holds its repair permission). */
export function recordZeroRecipientIncident(sourceKind: string): void {
  recorder.onZeroRecipientIncident(KNOWN_KINDS.has(sourceKind) ? sourceKind : 'other');
}

export function registerConnectionHealthMetrics(registry: Registry): void {
  const zeroRecipients = (registry.getSingleMetric(ZERO_RECIPIENT_METRIC) as Counter<'source_kind'> | undefined)
    ?? new Counter({
      name: ZERO_RECIPIENT_METRIC,
      help: 'Connection health incidents whose notice reached no user (nobody holds the repair permission), by source kind',
      labelNames: ['source_kind'] as const,
      registers: [registry],
    });
  setConnectionHealthMetricsRecorder({
    onZeroRecipientIncident: (sourceKind) => zeroRecipients.labels(sourceKind).inc(),
  });
}
