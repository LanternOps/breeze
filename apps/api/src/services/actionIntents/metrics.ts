import { Counter, type Registry } from 'prom-client';
import { writeAuditEvent, requestLikeFromSnapshot } from '../auditEvents';
import type { ActionIntentSource } from '../../db/schema/actionIntents';

/**
 * Observability for the action-intents durable approval layer (spec
 * docs/superpowers/specs/2026-07-18-action-intents-approval-layer-design.md
 * §7). Pattern-matches
 * services/m365ControlPlane/readActionMetrics.ts: a settable recorder behind
 * a Prometheus counter, plus an audit-event helper that fires both from one
 * call so every call site only has to remember one function.
 *
 * `ActionIntentOutcome` is deliberately restricted to the exact seven audit
 * actions the design spec names (§7) — `created`, `approved`, `rejected`,
 * `expired`, `cancelled`, `executed`, `self_approved_sole_operator` — so the
 * emitted `action_intent.<outcome>` audit action string is always one of
 * those seven. Finer-grained detail (e.g. WHY a cancellation happened, such
 * as `no_eligible_approvers`) belongs in `details.errorCode`, never a new
 * outcome value — keeps the metrics cardinality and the audit vocabulary
 * both bounded and matching the spec exactly.
 *
 * `digest_mismatch` and `approver_unauthorized` are the two deliberate
 * additions beyond the spec's seven: both are decide-time security refusals in
 * the decide handler (routes/approvals.ts) that reject a decision WITHOUT ever
 * calling `transitionIntent`, so none of the seven lifecycle outcomes fit.
 * `digest_mismatch` fires on the tamper-detection tripwire
 * (`existing.boundArgumentDigest !== linkedIntent.argumentDigest`);
 * `approver_unauthorized` fires when the deciding user no longer holds
 * approvals:decide / org access at decide time (a demoted approver reusing a
 * still-visible fanned-out row). Both are failure outcomes (see
 * `FAILURE_OUTCOMES`).
 */
export type ActionIntentOutcome =
  | 'created'
  | 'approved'
  | 'rejected'
  | 'expired'
  | 'cancelled'
  | 'executed'
  | 'self_approved_sole_operator'
  | 'digest_mismatch'
  | 'approver_unauthorized';

interface ActionIntentMetricsRecorder {
  onEvent: (source: ActionIntentSource, action: string, outcome: ActionIntentOutcome) => void;
}

const noop = () => {};
let recorder: ActionIntentMetricsRecorder = { onEvent: noop };

export function setActionIntentMetricsRecorder(
  next: Partial<ActionIntentMetricsRecorder> | null | undefined,
): void {
  recorder = { onEvent: next?.onEvent ?? noop };
}

export function recordActionIntentMetric(
  source: ActionIntentSource,
  action: string,
  outcome: ActionIntentOutcome,
): void {
  recorder.onEvent(source, action, outcome);
}

const PROMETHEUS_COUNTER_NAME = 'breeze_action_intents_total';

/**
 * Registers (or reuses, if already registered on this Registry) the
 * `breeze_action_intents_total{source,action,outcome}` counter named in spec
 * §7. NOT yet wired into `routes/metrics.ts`'s app-wide registry — that one-line
 * addition (mirroring `registerM365GraphReadActionPrometheusCounter` at
 * routes/metrics.ts:92) is left for the task that first needs the counter
 * live in `/metrics`, since this task's scope is the intent service only.
 */
export function registerActionIntentPrometheusCounter(
  registry: Registry,
): Counter<'source' | 'action' | 'outcome'> {
  const existing = registry.getSingleMetric(PROMETHEUS_COUNTER_NAME);
  const counter = (existing as Counter<'source' | 'action' | 'outcome'> | undefined) ?? new Counter({
    name: PROMETHEUS_COUNTER_NAME,
    help: 'Action intents created/decided/executed via the durable approval layer, by source, tool action, and outcome',
    labelNames: ['source', 'action', 'outcome'] as const,
    registers: [registry],
  });
  setActionIntentMetricsRecorder({
    onEvent: (source, action, outcome) => counter.labels(source, action, outcome).inc(),
  });
  return counter;
}

const FAILURE_OUTCOMES = new Set<ActionIntentOutcome>([
  'rejected',
  'expired',
  'cancelled',
  'digest_mismatch',
  'approver_unauthorized',
]);

export interface ActionIntentAuditInput {
  orgId: string;
  intentId: string;
  actionName: string;
  argumentDigest: string;
  source: ActionIntentSource;
  outcome: ActionIntentOutcome;
  /** User who triggered the event (requester or decider); omit for system-driven events (e.g. the reaper). */
  actorId?: string;
  /**
   * Extra audit context — ids, decider, assurance, error codes, counts. Must
   * NEVER carry raw tool argument contents, only the digest/summaries already
   * computed (spec §7: "Details carry ids, action name, digest, decider,
   * assurance — never argument contents beyond the summaries").
   */
  details?: Record<string, unknown>;
}

/**
 * Records both the audit trail (`action_intent.<outcome>`) and the
 * Prometheus counter for one action-intent lifecycle event. No `RequestLike`
 * parameter — callers of the intent service run outside an HTTP request
 * context (chat SDK sessions, MCP dispatch, background workers), so this
 * always builds an empty snapshot-based RequestLike, same as
 * services/deleteTenant.ts and services/aiToolsOrgs.ts.
 */
export function recordActionIntentEvent(input: ActionIntentAuditInput): void {
  writeAuditEvent(requestLikeFromSnapshot({}), {
    orgId: input.orgId,
    action: `action_intent.${input.outcome}`,
    resourceType: 'action_intent',
    resourceId: input.intentId,
    details: {
      actionName: input.actionName,
      argumentDigest: input.argumentDigest,
      source: input.source,
      ...input.details,
    },
    result: FAILURE_OUTCOMES.has(input.outcome) ? 'failure' : 'success',
    actorType: input.actorId ? 'user' : 'system',
    ...(input.actorId ? { actorId: input.actorId } : {}),
  });
  recordActionIntentMetric(input.source, input.actionName, input.outcome);
}
