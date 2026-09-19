/**
 * The AI Operator task state machine, spec §6.1, encoded as DATA (#5205 W06).
 *
 * WHY A TABLE AND NOT `switch`: §6.1 is a closed diagram. A `switch` that
 * forgets an arm silently falls through to "allowed"; a table that does not
 * contain `(from, event)` throws. Every transition the coordinator, the
 * reconciler and the wake handler can perform is one lookup in
 * `TASK_TRANSITIONS`, and `taskTransitions.test.ts` walks the full
 * state × event cross-product so a new state or event cannot be added without
 * a deliberate decision about all of its arms.
 *
 * WHY `revision` IS NOT BUMPED BY A TRANSITION (quorum finding Q1a/Q1c,
 * 2026-09-08): `ai_operator_tasks.revision` is the PLAN revision. The shipped
 * dispatch claim (`dispatchClaim.ts`'s `evaluateTaskClaimPredicate`) refuses a
 * dispatch whose approved `ai_operator_operations.plan_revision` no longer
 * equals `tasks.revision`. If a lifecycle transition — taking a lease, waking
 * on an approval, reclaiming after a worker restart — bumped `revision`, then
 * every approval decided while the coordinator happened to tick would become
 * permanently undispatchable, which is exactly acceptance scenario 3's
 * "approve after the browser closed" path. So:
 *
 *  - `revision` changes ONLY on a genuine PLAN change (`bumpPlanRevision`),
 *    which in the thin slice happens when verification fails and a NEW
 *    reasoning attempt is admitted to propose a new operation. Bumping there
 *    is the point: it invalidates any stale approved intent from the old plan.
 *  - Every lifecycle write still CASes ON `revision` as a GUARD (the plan must
 *    not have moved under the writer) and on `lease_epoch` where a lease
 *    holder is writing. Optimistic concurrency is `lease_epoch`, not
 *    `revision`.
 *
 * This module is pure. It performs no I/O so every arm is unit-testable
 * without a database; `taskCoordinator.ts` is what turns a decision here into
 * a conditional UPDATE.
 */

import {
  AI_OPERATOR_TASK_STATES,
  type AiOperatorTaskState,
} from '../../db/schema/aiOperatorTasks';

/** Terminal states: reached once, never left (spec §6.1). */
export const TERMINAL_TASK_STATES = [
  'completed', 'partial', 'handed_off', 'cancelled', 'failed', 'expired',
] as const satisfies readonly AiOperatorTaskState[];

export type TerminalTaskState = (typeof TERMINAL_TASK_STATES)[number];

export function isTerminalTaskState(state: string): state is TerminalTaskState {
  return (TERMINAL_TASK_STATES as readonly string[]).includes(state);
}

/**
 * Every event that may move a task. Named for what HAPPENED, not for the
 * state it lands in, so one event can legitimately resolve differently from
 * two source states (`stop` from `running` fences an in-flight run; `stop`
 * from `queued` has nothing to fence).
 */
export const TASK_TRANSITION_EVENTS = [
  /** The coordinator won the lease CAS and is now advancing the task. */
  'claim',
  /** The coordinator yielded on a typed dependency (approval, execution, …). */
  'wait',
  /** Pause requested; no new reasoning or effect admission (spec §7.3). */
  'pause',
  /** Resume from `paused`; authority rechecked, approvals NOT extended. */
  'resume',
  /** Cancel / expiry / handoff / authority loss begins. Fences admissions. */
  'stop',
  /** `stopping` settled: in-flight work reconciled or recorded unknown. */
  'settle_cancelled',
  /** `stopping` settled because the deadline passed. */
  'settle_expired',
  /** `stopping` settled by naming a human owner and writing the package. */
  'settle_handed_off',
  /** All criteria verified. */
  'complete',
  /** Some scope verified, remainder explicit. */
  'partial',
  /** Unresolved objective handed to a human with evidence, from a live state. */
  'hand_off',
  /** Classified failure. */
  'fail',
] as const;

export type TaskTransitionEvent = (typeof TASK_TRANSITION_EVENTS)[number];

/**
 * The state table. Read it as spec §6.1's diagram, one row per source state.
 *
 * `claim` from `running` is deliberately present and IS a self-transition: a
 * lease reclaim after an expired lease (or after a worker restart) leaves the
 * task `running` and advances `lease_epoch` only — never `attempt_ordinal`,
 * never `revision` (spec §6.2).
 */
export const TASK_TRANSITIONS: Readonly<
  Record<AiOperatorTaskState, Readonly<Partial<Record<TaskTransitionEvent, AiOperatorTaskState>>>>
> = {
  queued: {
    claim: 'running',
    pause: 'paused',
    stop: 'stopping',
  },
  running: {
    // Lease reclaim of a running task: same state, new epoch.
    claim: 'running',
    wait: 'waiting',
    pause: 'paused',
    stop: 'stopping',
    complete: 'completed',
    partial: 'partial',
    hand_off: 'handed_off',
    fail: 'failed',
  },
  waiting: {
    claim: 'running',
    // A wake that finds the dependency still unsatisfied re-arms the wait
    // without a round-trip through `running`.
    wait: 'waiting',
    pause: 'paused',
    stop: 'stopping',
  },
  paused: {
    resume: 'running',
    stop: 'stopping',
  },
  stopping: {
    // A reclaim while settling is legitimate: the reconciler takes over an
    // abandoned `stopping` task to finish observing its in-flight effects.
    claim: 'stopping',
    settle_cancelled: 'cancelled',
    settle_expired: 'expired',
    settle_handed_off: 'handed_off',
  },
  // Terminal. No arms, by construction — `nextTaskState` throws for all of
  // them, which is what makes "terminal records do not restart in place"
  // (spec §6.1) a mechanical property rather than a convention.
  completed: {},
  partial: {},
  handed_off: {},
  cancelled: {},
  failed: {},
  expired: {},
};

export class TaskTransitionError extends Error {
  readonly code = 'task_transition_not_allowed';
  readonly from: string;
  readonly event: string;

  constructor(from: string, event: string) {
    super(`[aiOperator] transition '${event}' is not allowed from task state '${from}'`);
    this.name = 'TaskTransitionError';
    this.from = from;
    this.event = event;
  }
}

/**
 * The one lookup. Returns the destination state, or THROWS — a transition not
 * in the table is a programming error, never a runtime condition to recover
 * from. Callers that legitimately need "may I?" use `canTransition` below.
 */
export function nextTaskState(
  from: AiOperatorTaskState | string,
  event: TaskTransitionEvent,
): AiOperatorTaskState {
  const arms = (TASK_TRANSITIONS as Record<string, Partial<Record<TaskTransitionEvent, AiOperatorTaskState>>>)[from];
  const to = arms?.[event];
  if (!to) throw new TaskTransitionError(String(from), event);
  return to;
}

export function canTransition(from: AiOperatorTaskState | string, event: TaskTransitionEvent): boolean {
  const arms = (TASK_TRANSITIONS as Record<string, Partial<Record<TaskTransitionEvent, AiOperatorTaskState>>>)[from];
  return Boolean(arms?.[event]);
}

/**
 * States from which a coordinator may take a lease at all. NOT the same as
 * "the lease CAS will win" — the CAS additionally requires the state-specific
 * door (a `running` task must have an EXPIRED lease; a `waiting` task must
 * either be past `next_wake_at` or be woken by an outbox event). See
 * `taskCoordinator.ts`.
 */
export const LEASABLE_TASK_STATES = [
  'queued', 'running', 'waiting', 'stopping',
] as const satisfies readonly AiOperatorTaskState[];

export function isLeasableTaskState(state: string): boolean {
  return (LEASABLE_TASK_STATES as readonly string[]).includes(state);
}

/**
 * States in which admission of NEW reasoning or NEW effects is fenced
 * (spec §7.3). `paused` blocks admission but reconciliation continues;
 * `stopping` and every terminal state block it permanently.
 */
export function admissionFenced(state: AiOperatorTaskState | string): boolean {
  return state === 'paused' || state === 'stopping' || isTerminalTaskState(String(state));
}

/** Exhaustiveness helper for the contract test — every declared state has a row. */
export const ALL_TASK_STATES = AI_OPERATOR_TASK_STATES;
