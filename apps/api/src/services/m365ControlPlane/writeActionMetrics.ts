import type { M365WriteActionId, WriteActionFailureCode } from '@breeze/shared/m365';
import { Counter, type Registry } from 'prom-client';
import { writeAuditEvent, type RequestLike } from '../auditEvents';

/**
 * Observability for executed typed Graph write actions (writeActionService).
 * Mirrors readActionMetrics.ts's pattern exactly, but this counter/audit
 * trail covers the write-action ladder's executor-attempt outcomes (mutating
 * Graph calls), not the read-side connection lifecycle events.
 */

export type M365WriteActionOutcome = 'ok' | WriteActionFailureCode | 'executor_unavailable';

interface M365WriteActionMetricsRecorder {
  onEvent: (action: M365WriteActionId, outcome: M365WriteActionOutcome) => void;
}

const noop = () => {};
let recorder: M365WriteActionMetricsRecorder = { onEvent: noop };

export function setM365WriteActionMetricsRecorder(
  next: Partial<M365WriteActionMetricsRecorder> | null | undefined,
): void {
  recorder = { onEvent: next?.onEvent ?? noop };
}

export function recordM365WriteActionMetric(
  action: M365WriteActionId,
  outcome: M365WriteActionOutcome,
): void {
  recorder.onEvent(action, outcome);
}

const PROMETHEUS_COUNTER_NAME = 'breeze_m365_graph_actions_total';

export function registerM365GraphActionsPrometheusCounter(
  registry: Registry,
): Counter<'action' | 'outcome'> {
  const existing = registry.getSingleMetric(PROMETHEUS_COUNTER_NAME);
  const counter = (existing as Counter<'action' | 'outcome'> | undefined) ?? new Counter({
    name: PROMETHEUS_COUNTER_NAME,
    help: 'M365 typed Graph write (mutating) actions executed via the control-plane executor, by action and outcome',
    labelNames: ['action', 'outcome'] as const,
    registers: [registry],
  });
  setM365WriteActionMetricsRecorder({
    onEvent: (action, outcome) => counter.labels(action, outcome).inc(),
  });
  return counter;
}

export interface M365WriteActionAuditInput {
  orgId: string;
  connectionId: string;
  actionType: M365WriteActionId;
  outcome: M365WriteActionOutcome;
  actorId?: string;
}

/**
 * Records both the audit trail and the Prometheus counter for one executed
 * write-action attempt. `details` is built from a fixed, explicit allowlist
 * (`actionType`, `outcome`) — it must NEVER carry the executor's result
 * payload (e.g. a `reset_password` temporary password) or any Graph request/
 * response body.
 */
export function recordM365WriteActionEvent(
  request: RequestLike,
  input: M365WriteActionAuditInput,
): void {
  writeAuditEvent(request, {
    orgId: input.orgId,
    action: 'm365.customer_graph_actions.action_executed',
    resourceType: 'm365_connection',
    resourceId: input.connectionId,
    details: {
      actionType: input.actionType,
      outcome: input.outcome,
    },
    result: input.outcome === 'ok' ? 'success' : 'failure',
    actorType: 'user',
    ...(input.actorId ? { actorId: input.actorId } : {}),
  });
  recordM365WriteActionMetric(input.actionType, input.outcome);
}
