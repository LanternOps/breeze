import {
  writeAuditEvent,
  type RequestLike,
} from '../auditEvents';
import { Counter, type Registry } from 'prom-client';

export const M365_CUSTOMER_GRAPH_READ_EVENTS = [
  'm365.customer_graph_read.consent_initiated',
  'm365.customer_graph_read.admin_consent_returned',
  'm365.customer_graph_read.tenant_binding_verified',
  'm365.customer_graph_read.verification_failed',
  'm365.customer_graph_read.grant_drift_detected',
  'm365.customer_graph_read.retested',
  'm365.customer_graph_read.disconnected',
] as const;

export type M365CustomerGraphReadEvent = typeof M365_CUSTOMER_GRAPH_READ_EVENTS[number];

export const M365_CUSTOMER_GRAPH_READ_OUTCOMES = [
  'initiated',
  'identity_verification_started',
  'active',
  'degraded',
  'revoked',
  'consent_expired',
  'consent_state_mismatch',
  'consent_cancelled',
  'admin_role_required',
  'tenant_mismatch',
  'tenant_already_bound',
  'credential_unavailable',
  'identity_token_invalid',
  'application_token_invalid',
  'grant_reconciliation_unavailable',
  'grant_missing',
  'grant_unexpected',
  'manifest_stale',
  'organization_probe_failed',
  'executor_unavailable',
] as const;

export type M365CustomerGraphReadOutcome = typeof M365_CUSTOMER_GRAPH_READ_OUTCOMES[number];

interface M365CustomerGraphReadMetricsRecorder {
  onEvent: (
    event: M365CustomerGraphReadEvent,
    outcome: M365CustomerGraphReadOutcome,
  ) => void;
}

const eventSet = new Set<string>(M365_CUSTOMER_GRAPH_READ_EVENTS);
const outcomeSet = new Set<string>(M365_CUSTOMER_GRAPH_READ_OUTCOMES);
const noop = () => {};
let recorder: M365CustomerGraphReadMetricsRecorder = { onEvent: noop };

export function setM365CustomerGraphReadMetricsRecorder(
  next: Partial<M365CustomerGraphReadMetricsRecorder> | null | undefined,
): void {
  recorder = { onEvent: next?.onEvent ?? noop };
}

export function recordM365CustomerGraphReadMetric(
  event: M365CustomerGraphReadEvent,
  outcome: M365CustomerGraphReadOutcome,
): void {
  if (!eventSet.has(event) || !outcomeSet.has(outcome)) return;
  recorder.onEvent(event, outcome);
}

const PROMETHEUS_COUNTER_NAME = 'breeze_m365_customer_graph_read_events_total';

export function registerM365CustomerGraphReadPrometheusCounter(
  registry: Registry,
): Counter<'event' | 'outcome'> {
  const existing = registry.getSingleMetric(PROMETHEUS_COUNTER_NAME);
  const counter = (existing as Counter<'event' | 'outcome'> | undefined) ?? new Counter({
    name: PROMETHEUS_COUNTER_NAME,
    help: 'M365 customer Graph read lifecycle events by fixed event and outcome',
    labelNames: ['event', 'outcome'] as const,
    registers: [registry],
  });
  setM365CustomerGraphReadMetricsRecorder({
    onEvent: (event, outcome) => counter.labels(event, outcome).inc(),
  });
  return counter;
}

export interface M365CustomerGraphReadAuditInput {
  event: M365CustomerGraphReadEvent;
  orgId: string;
  connectionId: string;
  profile: 'customer-graph-read';
  consentAttemptId: string;
  manifestVersion?: number;
  outcome: M365CustomerGraphReadOutcome;
  correlationId?: string;
  verifiedTenantId?: string;
  actorId?: string;
  actorEmail?: string;
}

const SUCCESS_OUTCOMES = new Set<M365CustomerGraphReadOutcome>([
  'initiated',
  'identity_verification_started',
  'active',
  'degraded',
  'revoked',
]);

export function recordM365CustomerGraphReadEvent(
  request: RequestLike,
  input: M365CustomerGraphReadAuditInput,
): void {
  if (!eventSet.has(input.event) || !outcomeSet.has(input.outcome)) return;

  const details: Record<string, unknown> = {
    profile: input.profile,
    consentAttemptId: input.consentAttemptId,
  };
  if (input.manifestVersion !== undefined) details.manifestVersion = input.manifestVersion;
  details.outcome = input.outcome;
  if (input.correlationId !== undefined) details.correlationId = input.correlationId;
  if (input.verifiedTenantId !== undefined) details.tenantId = input.verifiedTenantId;

  writeAuditEvent(request, {
    orgId: input.orgId,
    action: input.event,
    resourceType: 'm365_connection',
    resourceId: input.connectionId,
    details,
    result: SUCCESS_OUTCOMES.has(input.outcome) ? 'success' : 'failure',
    actorType: input.actorId ? 'user' : 'system',
    ...(input.actorId ? { actorId: input.actorId } : {}),
    ...(input.actorEmail ? { actorEmail: input.actorEmail } : {}),
  });
  recordM365CustomerGraphReadMetric(input.event, input.outcome);
}
