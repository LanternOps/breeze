/**
 * Wisp Prometheus series (W07 Task 8).
 *
 * A LEAF module by construction — it imports `metricsRegistry` and nothing
 * else (see aiWorkspaceMetrics.ts; `workerEntrypointClosure.contract.test.ts`
 * enforces the invariant). Pause reasons are therefore a copied string-literal
 * union rather than an import of `WispGrantPauseReason`.
 *
 * No partner/org label on any series (cardinality). Per-partner figures come
 * from the platform-admin overview, not from here.
 */
import { Counter, Gauge } from 'prom-client';

import { metricsRegistry } from './metricsRegistry';

export type WispSpecialistKindLabel =
  | 'sweep'
  | 'analysis'
  | 'operator_recipe'
  | 'patch_plan'
  | 'remediation_research'
  | 'bulk_ticket_reply'
  | 'device_troubleshooting'
  | 'assessment';

/** Copy of `WispGrantPauseReason` (db/schema/wisp.ts) — keep in sync. */
export type WispGrantPauseReasonLabel =
  | 'grantor_access_lost'
  | 'grantor_suspended'
  | 'factor_expired'
  | 'entitlement_lost'
  | 'budget_exhausted'
  | 'user_paused'
  | 'partner_disabled';

const assessmentsTotal = new Counter({
  name: 'wisp_assessments_total',
  help: 'Wisp assessment enqueue decisions, by outcome (admitted or the reason it was skipped)',
  labelNames: ['outcome'] as const,
  registers: [metricsRegistry],
});

const nudgesTotal = new Counter({
  name: 'wisp_nudges_total',
  help: 'Wisp nudge delivery decisions, by result (sent or the suppression reason)',
  labelNames: ['result'] as const,
  registers: [metricsRegistry],
});

const concernsTotal = new Counter({
  name: 'wisp_concerns_total',
  help: 'Wisp concern lifecycle transitions (opened, updated, resolved, dismissed, snoozed)',
  labelNames: ['transition'] as const,
  registers: [metricsRegistry],
});

const grantPausesTotal = new Counter({
  name: 'wisp_grant_pauses_total',
  help: 'Wisp grants transitioned to paused, by pause reason',
  labelNames: ['reason'] as const,
  registers: [metricsRegistry],
});

const budgetExhaustedTotal = new Counter({
  name: 'wisp_budget_exhausted_total',
  help: 'Times a Wisp grant was refused because its daily budget was exhausted',
  registers: [metricsRegistry],
});

const specialistRequestsTotal = new Counter({
  name: 'wisp_specialist_requests_total',
  help: 'Wisp specialist requests, by specialist kind and admission outcome',
  labelNames: ['kind', 'outcome'] as const,
  registers: [metricsRegistry],
});

const dispatchUnverifiedTotal = new Counter({
  name: 'wisp_dispatch_unverified_total',
  help: 'Wisp dispatch-class tool results that came back without a job, command or intent id (#10427), by tool',
  labelNames: ['tool'] as const,
  registers: [metricsRegistry],
});

const promiseCorrectionsTotal = new Counter({
  name: 'wisp_promise_corrections_total',
  help: 'Wisp replies corrected at turn end for a promise no tool result backed (#10427), by promise class',
  labelNames: ['class'] as const,
  registers: [metricsRegistry],
});

const grantsActive = new Gauge({
  name: 'wisp_grants_active',
  help: 'Active Wisp grants seen by the most recent wake-scheduler tick',
  registers: [metricsRegistry],
});

export function incWispAssessment(
  outcome: 'admitted' | 'skipped_budget' | 'skipped_grant' | 'skipped_admission' | 'skipped_no_changes',
): void {
  assessmentsTotal.inc({ outcome });
}

export function incWispNudge(
  result: 'sent' | 'suppressed_quiet_hours' | 'suppressed_prefs' | 'suppressed_backoff',
): void {
  nudgesTotal.inc({ result });
}

export function incWispConcern(
  transition: 'opened' | 'updated' | 'resolved' | 'dismissed' | 'snoozed',
): void {
  concernsTotal.inc({ transition });
}

export function incWispGrantPause(reason: WispGrantPauseReasonLabel): void {
  grantPausesTotal.inc({ reason });
}

export function incWispBudgetExhausted(): void {
  budgetExhaustedTotal.inc();
}

export function incSpecialistRequest(
  kind: WispSpecialistKindLabel,
  outcome: 'admitted' | 'needs_approval' | 'refused',
): void {
  specialistRequestsTotal.inc({ kind, outcome });
}

/** `tool` is always a DISPATCH_EVIDENCE key (wisp/dispatchEvidence.ts), so the label set is closed. */
export function incWispDispatchUnverified(tool: string): void {
  dispatchUnverifiedTotal.inc({ tool });
}

/** Copy of `PromiseClass` (wisp/promiseLinter.ts) — keep in sync. */
export function incWispPromiseCorrection(promiseClass: 'follow_up' | 'dispatched' | 'concern'): void {
  promiseCorrectionsTotal.inc({ class: promiseClass });
}

export function setWispGrantsActive(count: number): void {
  grantsActive.set(count);
}
