import type { M365ReadActionId, ReadActionFailureCode } from '@breeze/shared/m365';
import { Counter, type Registry } from 'prom-client';
import { writeAuditEvent, type RequestLike } from '../auditEvents';

/**
 * Observability for executed typed Graph read actions (readActionService).
 * Pattern-matches metrics.ts, but this counter/audit trail covers the
 * per-call executor outcome (steps 6-7 of the readActionService ladder),
 * not the connection lifecycle events that metrics.ts already owns.
 */

export type M365ReadActionOutcome = 'ok' | ReadActionFailureCode | 'executor_unavailable';

interface M365ReadActionMetricsRecorder {
  onEvent: (action: M365ReadActionId, outcome: M365ReadActionOutcome) => void;
}

const noop = () => {};
let recorder: M365ReadActionMetricsRecorder = { onEvent: noop };

export function setM365ReadActionMetricsRecorder(
  next: Partial<M365ReadActionMetricsRecorder> | null | undefined,
): void {
  recorder = { onEvent: next?.onEvent ?? noop };
}

export function recordM365ReadActionMetric(
  action: M365ReadActionId,
  outcome: M365ReadActionOutcome,
): void {
  recorder.onEvent(action, outcome);
}

const PROMETHEUS_COUNTER_NAME = 'breeze_m365_graph_read_actions_total';

export function registerM365GraphReadActionPrometheusCounter(
  registry: Registry,
): Counter<'action' | 'outcome'> {
  const existing = registry.getSingleMetric(PROMETHEUS_COUNTER_NAME);
  const counter = (existing as Counter<'action' | 'outcome'> | undefined) ?? new Counter({
    name: PROMETHEUS_COUNTER_NAME,
    help: 'M365 typed Graph read actions executed via the control-plane executor, by action and outcome',
    labelNames: ['action', 'outcome'] as const,
    registers: [registry],
  });
  setM365ReadActionMetricsRecorder({
    onEvent: (action, outcome) => counter.labels(action, outcome).inc(),
  });
  return counter;
}

export interface M365ReadActionAuditInput {
  orgId: string;
  connectionId: string;
  actionType: M365ReadActionId;
  outcome: M365ReadActionOutcome;
  itemCount: number;
  truncated: boolean;
  actorId?: string;
}

/**
 * Records both the audit trail and the Prometheus counter for one executed
 * read-action attempt. `details` is built from a fixed, explicit allowlist —
 * it must never carry Graph item payloads, only shape/outcome metadata.
 */
export function recordM365ReadActionEvent(
  request: RequestLike,
  input: M365ReadActionAuditInput,
): void {
  writeAuditEvent(request, {
    orgId: input.orgId,
    action: 'm365.customer_graph_read.action_executed',
    resourceType: 'm365_connection',
    resourceId: input.connectionId,
    details: {
      actionType: input.actionType,
      outcome: input.outcome,
      itemCount: input.itemCount,
      truncated: input.truncated,
    },
    result: input.outcome === 'ok' ? 'success' : 'failure',
    actorType: 'user',
    ...(input.actorId ? { actorId: input.actorId } : {}),
  });
  recordM365ReadActionMetric(input.actionType, input.outcome);
}
