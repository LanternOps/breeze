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

/**
 * The lifecycle-outcome enum is identical across the read and actions consent
 * surfaces — both model the same connection lifecycle. Actions-specific write
 * telemetry (if any) lives with the write-action service, not here.
 */
const SUCCESS_OUTCOMES: readonly M365CustomerGraphReadOutcome[] = [
  'initiated',
  'identity_verification_started',
  'active',
  'degraded',
  'revoked',
];

interface M365ConsentMetricsRecorder<Event extends string, Outcome extends string> {
  onEvent: (event: Event, outcome: Outcome) => void;
}

/**
 * Bounded audit input for a single M365 consent lifecycle event. Only the
 * fields enumerated here reach the audit log — everything else a caller might
 * spread in is dropped, keeping executor-only secrets out of observability.
 */
export interface M365ConsentAuditInput<
  Event extends string,
  Outcome extends string,
  Profile extends string,
> {
  event: Event;
  orgId: string;
  connectionId: string;
  profile: Profile;
  consentAttemptId: string;
  manifestVersion?: number;
  outcome: Outcome;
  correlationId?: string;
  verifiedTenantId?: string;
  actorId?: string;
  actorEmail?: string;
}

interface ConsentObservabilityConfig<Event extends string, Outcome extends string> {
  events: readonly Event[];
  outcomes: readonly Outcome[];
  successOutcomes: readonly Outcome[];
  prometheusCounterName: string;
  prometheusCounterHelp: string;
}

interface ConsentObservability<Event extends string, Outcome extends string, Profile extends string> {
  setRecorder: (next: Partial<M365ConsentMetricsRecorder<Event, Outcome>> | null | undefined) => void;
  recordMetric: (event: Event, outcome: Outcome) => void;
  registerPrometheusCounter: (registry: Registry) => Counter<'event' | 'outcome'>;
  recordEvent: (request: RequestLike, input: M365ConsentAuditInput<Event, Outcome, Profile>) => void;
}

/**
 * Builds a profile-scoped consent-observability surface: a bounded metric
 * recorder, an idempotent Prometheus counter, and an allowlisted audit writer.
 * The read and actions surfaces are two instances of this same core so their
 * behavior stays identical apart from the fixed event/counter names.
 */
function createConsentObservability<Event extends string, Outcome extends string, Profile extends string>(
  config: ConsentObservabilityConfig<Event, Outcome>,
): ConsentObservability<Event, Outcome, Profile> {
  const eventSet = new Set<string>(config.events);
  const outcomeSet = new Set<string>(config.outcomes);
  const successSet = new Set<string>(config.successOutcomes);
  const noop = () => {};
  let recorder: M365ConsentMetricsRecorder<Event, Outcome> = { onEvent: noop };

  function setRecorder(next: Partial<M365ConsentMetricsRecorder<Event, Outcome>> | null | undefined): void {
    recorder = { onEvent: next?.onEvent ?? noop };
  }

  function recordMetric(event: Event, outcome: Outcome): void {
    if (!eventSet.has(event) || !outcomeSet.has(outcome)) return;
    recorder.onEvent(event, outcome);
  }

  function registerPrometheusCounter(registry: Registry): Counter<'event' | 'outcome'> {
    const existing = registry.getSingleMetric(config.prometheusCounterName);
    const counter = (existing as Counter<'event' | 'outcome'> | undefined) ?? new Counter({
      name: config.prometheusCounterName,
      help: config.prometheusCounterHelp,
      labelNames: ['event', 'outcome'] as const,
      registers: [registry],
    });
    setRecorder({
      onEvent: (event, outcome) => counter.labels(event, outcome).inc(),
    });
    return counter;
  }

  function recordEvent(request: RequestLike, input: M365ConsentAuditInput<Event, Outcome, Profile>): void {
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
      result: successSet.has(input.outcome) ? 'success' : 'failure',
      actorType: input.actorId ? 'user' : 'system',
      ...(input.actorId ? { actorId: input.actorId } : {}),
      ...(input.actorEmail ? { actorEmail: input.actorEmail } : {}),
    });
    recordMetric(input.event, input.outcome);
  }

  return { setRecorder, recordMetric, registerPrometheusCounter, recordEvent };
}

// --- customer-graph-read surface (public names preserved byte-for-byte) ------

const readObservability = createConsentObservability<
  M365CustomerGraphReadEvent,
  M365CustomerGraphReadOutcome,
  'customer-graph-read'
>({
  events: M365_CUSTOMER_GRAPH_READ_EVENTS,
  outcomes: M365_CUSTOMER_GRAPH_READ_OUTCOMES,
  successOutcomes: SUCCESS_OUTCOMES,
  prometheusCounterName: 'breeze_m365_customer_graph_read_events_total',
  prometheusCounterHelp: 'M365 customer Graph read lifecycle events by fixed event and outcome',
});

export type M365CustomerGraphReadAuditInput = M365ConsentAuditInput<
  M365CustomerGraphReadEvent,
  M365CustomerGraphReadOutcome,
  'customer-graph-read'
>;

export const setM365CustomerGraphReadMetricsRecorder = readObservability.setRecorder;
export const recordM365CustomerGraphReadMetric = readObservability.recordMetric;
export const registerM365CustomerGraphReadPrometheusCounter = readObservability.registerPrometheusCounter;
export const recordM365CustomerGraphReadEvent = readObservability.recordEvent;

// --- customer-graph-actions surface (siblings for Task 7) --------------------

export const M365_CUSTOMER_GRAPH_ACTIONS_EVENTS = [
  'm365.customer_graph_actions.consent_initiated',
  'm365.customer_graph_actions.admin_consent_returned',
  'm365.customer_graph_actions.tenant_binding_verified',
  'm365.customer_graph_actions.verification_failed',
  'm365.customer_graph_actions.grant_drift_detected',
  'm365.customer_graph_actions.retested',
  'm365.customer_graph_actions.disconnected',
] as const;

export type M365CustomerGraphActionsEvent = typeof M365_CUSTOMER_GRAPH_ACTIONS_EVENTS[number];

/** Actions share the read lifecycle-outcome enum (identical connection lifecycle). */
export const M365_CUSTOMER_GRAPH_ACTIONS_OUTCOMES = M365_CUSTOMER_GRAPH_READ_OUTCOMES;
export type M365CustomerGraphActionsOutcome = M365CustomerGraphReadOutcome;

const actionsObservability = createConsentObservability<
  M365CustomerGraphActionsEvent,
  M365CustomerGraphActionsOutcome,
  'customer-graph-actions'
>({
  events: M365_CUSTOMER_GRAPH_ACTIONS_EVENTS,
  outcomes: M365_CUSTOMER_GRAPH_ACTIONS_OUTCOMES,
  successOutcomes: SUCCESS_OUTCOMES,
  prometheusCounterName: 'breeze_m365_customer_graph_actions_events_total',
  prometheusCounterHelp: 'M365 customer Graph actions lifecycle events by fixed event and outcome',
});

export type M365CustomerGraphActionsAuditInput = M365ConsentAuditInput<
  M365CustomerGraphActionsEvent,
  M365CustomerGraphActionsOutcome,
  'customer-graph-actions'
>;

export const setM365CustomerGraphActionsMetricsRecorder = actionsObservability.setRecorder;
export const recordM365CustomerGraphActionsMetric = actionsObservability.recordMetric;
export const registerM365CustomerGraphActionsPrometheusCounter = actionsObservability.registerPrometheusCounter;
export const recordM365CustomerGraphActionsEvent = actionsObservability.recordEvent;
