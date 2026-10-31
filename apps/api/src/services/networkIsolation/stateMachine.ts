import {
  isResolvedTerminalIsolationState,
  type ACTIVE_STATES,
  type IsolationDesiredState,
  type IsolationFailureCode,
  type IsolationReleaseKind,
  type IsolationState,
} from '@breeze/shared';

/**
 * The network-isolation episode state machine (spec §3.2, plan W1a Task 3). Pure: no I/O and nothing
 * from the DB layer, so every arrow is table-tested. Callers (reconcile, finalizer, service — W1b) load
 * the row under `withEpisodeLock`, apply one event, and write `next` back.
 *
 * Three things stay apart: the server's intent (`desiredState` + `generation`), what the agent reports
 * (`state`), and ordering (`lastJournalSeq`).
 *
 * - `generation` changes only when intent changes: isolate = 1; extend, a release tombstone and a
 *   server-side `not_delivered` are last + 1; a retransmission keeps it.
 * - An event below the row's generation is `stale_generation`; one above it was never issued, so it is
 *   `invalid_transition` (never adopted). An agent event whose `journalSeq` is at or below
 *   `lastJournalSeq` is `stale_seq`.
 * - Terminal states win. A resolved terminal state (released, expired, failed, uninstalled) accepts
 *   nothing; the only exception is `agent_absent`, which confirms an outstanding tombstone. An
 *   unresolved terminal state (released_locally, self_released) accepts only `acknowledge`, which
 *   resolves it to `released`. Those checks run first, so a late same-generation `agent_verified`
 *   after `failed` can never re-open the episode.
 * - Agent progress may skip states the server never saw (a fast apply can go dispatched → verified
 *   between two heartbeats) but never moves backwards, and never pulls a pending release back.
 * - When the agent itself reports the rules gone (a rollback, expiry, local or dead-man release,
 *   release), `releaseConfirmedAt` is set at once; a server-side decision without agent evidence
 *   (`not_delivered`, `release_requested`) leaves the tombstone unconfirmed until the agent confirms.
 */

export interface EpisodeSnapshot {
  state: IsolationState;
  desiredState: IsolationDesiredState;
  generation: number;
  lastJournalSeq: number;
  failureCode: IsolationFailureCode | null;
  releaseKind: IsolationReleaseKind | null;
  expiresAt: Date;
  dispatchedAt: Date | null;
  appliedAt: Date | null;
  verifiedAt: Date | null;
  releaseRequestedAt: Date | null;
  releasedAt: Date | null;
  releaseConfirmedAt: Date | null;
  acknowledgedAt: Date | null;
  acknowledgedBy: string | null;
}

interface EventBase {
  /** The generation the sender acted on. */
  generation: number;
  /** When it happened (server clock), stamped onto any timestamp the transition sets. */
  at: Date;
}

/** From the agent: every report and command result carries its journal sequence (plan "Ordering key"). */
interface AgentEventBase extends EventBase {
  journalSeq: number;
}

/** Decided by the server; no journal sequence. */
interface ServerEventBase extends EventBase {
  journalSeq?: never;
}

export type EpisodeEvent =
  | (AgentEventBase & (
    | { type: 'agent_ack' }
    | { type: 'agent_applied' }
    | { type: 'agent_verified' }
    | { type: 'agent_failed'; code: IsolationFailureCode }
    | { type: 'agent_released'; kind: IsolationReleaseKind }
    | { type: 'agent_expired' }
    | { type: 'agent_self_released' }
    | { type: 'agent_released_locally'; kind: 'local_code' | 'local_forced' }
  ))
  // The "nothing Breeze-owned is installed" report may omit its journalSeq (networkIsolationReportSchema).
  | (EventBase & { type: 'agent_absent'; journalSeq?: number })
  | (ServerEventBase & (
    | { type: 'dispatched' }
    | { type: 'release_requested'; kind: IsolationReleaseKind }
    | { type: 'uninstalled' }
    | { type: 'not_delivered' }
    | { type: 'extend'; expiresAt: Date }
    // The human who resolved it; the audit trail for the one human gate.
    | { type: 'acknowledge'; userId: string }
  ));

export type EpisodeIgnoredReason = 'stale_generation' | 'stale_seq' | 'invalid_transition' | 'already_terminal';

export type EpisodeTransition = { next: EpisodeSnapshot } | { ignored: EpisodeIgnoredReason };

type IsolatingState = Exclude<(typeof ACTIVE_STATES)[number], 'release_requested'>;

/**
 * Forward order of the isolating states; agent progress only ever moves up it. Keyed by every active
 * state except release_requested, so adding an active state to the shared tuple fails to compile here.
 */
const PROGRESS_RANK: Readonly<Record<IsolatingState, number>> = {
  requested: 0,
  dispatched: 1,
  applying: 2,
  applied: 3,
  verified: 4,
};

function isIsolating(state: IsolationState): state is IsolatingState {
  return Object.prototype.hasOwnProperty.call(PROGRESS_RANK, state);
}

function rank(state: IsolationState): number {
  return isIsolating(state) ? PROGRESS_RANK[state] : -1;
}

const INVALID: EpisodeTransition = Object.freeze({ ignored: 'invalid_transition' as const });
const TERMINAL: EpisodeTransition = Object.freeze({ ignored: 'already_terminal' as const });

function checkOrdering(row: EpisodeSnapshot, ev: EpisodeEvent): EpisodeIgnoredReason | null {
  if (ev.generation < row.generation) return 'stale_generation';
  if (ev.generation > row.generation) return 'invalid_transition';
  if (ev.journalSeq !== undefined && ev.journalSeq <= row.lastJournalSeq) return 'stale_seq';
  return null;
}

/** The agent says nothing Breeze-owned is installed any more: the episode is over and confirmed. */
function ended(
  row: EpisodeSnapshot,
  at: Date,
  state: IsolationState,
  releaseKind: IsolationReleaseKind | null,
): Partial<EpisodeSnapshot> {
  return {
    state,
    desiredState: 'released',
    releaseKind,
    releasedAt: row.releasedAt ?? at,
    releaseConfirmedAt: row.releaseConfirmedAt ?? at,
  };
}

export function applyEpisodeEvent(row: EpisodeSnapshot, ev: EpisodeEvent): EpisodeTransition {
  const at = ev.at;

  // 1. Terminal states take precedence over everything, including ordering.
  if (isResolvedTerminalIsolationState(row.state)) {
    if (ev.type !== 'agent_absent' || row.releaseConfirmedAt !== null) return TERMINAL;
    const order = checkOrdering(row, ev);
    if (order) return { ignored: order };
    return { next: withSeq(row, ev, { releaseConfirmedAt: at }) };
  }
  if (row.state === 'released_locally' || row.state === 'self_released') {
    if (ev.type !== 'acknowledge') return TERMINAL;
    const order = checkOrdering(row, ev);
    if (order) return { ignored: order };
    return {
      next: withSeq(row, ev, {
        state: 'released',
        desiredState: 'released',
        acknowledgedAt: at,
        acknowledgedBy: ev.userId,
      }),
    };
  }

  // 2. Ordering.
  const order = checkOrdering(row, ev);
  if (order) return { ignored: order };

  const releasing = row.state === 'release_requested';
  const isolating = isIsolating(row.state);
  if (!releasing && !isolating) return INVALID; // unreachable: every non-terminal state is one of the two

  // 3. Transitions.
  switch (ev.type) {
    case 'dispatched':
      if (row.state === 'requested') return { next: withSeq(row, ev, { state: 'dispatched', dispatchedAt: row.dispatchedAt ?? at }) };
      // Re-sending the same intent: no change, same generation.
      return isolating ? { next: withSeq(row, ev, {}) } : INVALID;

    case 'agent_ack':
      return progress(row, ev, 'applying', {});

    case 'agent_applied':
      return progress(row, ev, 'applied', { appliedAt: row.appliedAt ?? at });

    case 'agent_verified':
      return progress(row, ev, 'verified', { appliedAt: row.appliedAt ?? at, verifiedAt: row.verifiedAt ?? at });

    case 'agent_failed':
      // A failure is an apply-time outcome: the agent rolled back, so nothing is installed.
      if (!isolating || row.state === 'verified') return INVALID;
      return { next: withSeq(row, ev, { ...ended(row, at, 'failed', null), releasedAt: row.releasedAt, failureCode: ev.code }) };

    case 'not_delivered':
      // Server-side: the command never reached the agent. The agent may still have acted on the
      // heartbeat's desired state, so a tombstone at last + 1 is owed until the agent confirms absence.
      if (row.state !== 'requested' && row.state !== 'dispatched') return INVALID;
      return {
        next: withSeq(row, ev, {
          state: 'failed',
          failureCode: 'not_delivered',
          desiredState: 'released',
          generation: row.generation + 1,
        }),
      };

    case 'release_requested':
      if (releasing) return { next: withSeq(row, ev, {}) }; // retransmission of the tombstone
      return {
        next: withSeq(row, ev, {
          state: 'release_requested',
          desiredState: 'released',
          generation: row.generation + 1,
          releaseKind: ev.kind,
          releaseRequestedAt: at,
        }),
      };

    case 'extend':
      if (!isolating || Number.isNaN(ev.expiresAt.getTime())) return INVALID;
      return { next: withSeq(row, ev, { generation: row.generation + 1, expiresAt: ev.expiresAt }) };

    case 'agent_released':
    case 'agent_absent':
      // Only an answer to a pending release. While isolation is still desired, an agent with no rules is
      // a local or dead-man release, which reconcile (W1b) classifies and sends as its own event.
      if (!releasing) return INVALID;
      return { next: withSeq(row, ev, ended(row, at, 'released', row.releaseKind ?? (ev.type === 'agent_released' ? ev.kind : 'system'))) };

    case 'agent_expired':
      return { next: withSeq(row, ev, ended(row, at, 'expired', 'expired')) };

    case 'agent_self_released':
      return releasing
        ? { next: withSeq(row, ev, ended(row, at, 'released', row.releaseKind)) }
        : { next: withSeq(row, ev, ended(row, at, 'self_released', 'dead_man')) };

    case 'agent_released_locally':
      // A local release while a console/AI release was pending simply satisfies that release.
      return releasing
        ? { next: withSeq(row, ev, ended(row, at, 'released', row.releaseKind)) }
        : { next: withSeq(row, ev, ended(row, at, 'released_locally', ev.kind)) };

    case 'uninstalled':
      return { next: withSeq(row, ev, ended(row, at, 'uninstalled', 'uninstall')) };

    case 'acknowledge':
      return INVALID;

    default: {
      const unhandled: never = ev;
      void unhandled;
      return INVALID;
    }
  }
}

/** Agent progress up PROGRESS_RANK; same state is an idempotent repeat; down, or during a release, is invalid. */
function progress(
  row: EpisodeSnapshot,
  ev: EpisodeEvent,
  target: IsolationState,
  patch: Partial<EpisodeSnapshot>,
): EpisodeTransition {
  if (!isIsolating(row.state)) return INVALID;
  if (rank(row.state) > rank(target)) return INVALID;
  if (row.state === target) return { next: withSeq(row, ev, {}) };
  return { next: withSeq(row, ev, { ...patch, state: target }) };
}

/**
 * The next snapshot: exactly the EpisodeSnapshot fields, so a caller that hands in a wider row (a full
 * DB row is structurally assignable) never gets id, org_id or the secret back to write.
 */
function withSeq(row: EpisodeSnapshot, ev: EpisodeEvent, patch: Partial<EpisodeSnapshot>): EpisodeSnapshot {
  const lastJournalSeq = ev.journalSeq !== undefined ? Math.max(row.lastJournalSeq, ev.journalSeq) : row.lastJournalSeq;
  const merged = { ...row, ...patch };
  return {
    state: merged.state,
    desiredState: merged.desiredState,
    generation: merged.generation,
    lastJournalSeq,
    failureCode: merged.failureCode,
    releaseKind: merged.releaseKind,
    expiresAt: merged.expiresAt,
    dispatchedAt: merged.dispatchedAt,
    appliedAt: merged.appliedAt,
    verifiedAt: merged.verifiedAt,
    releaseRequestedAt: merged.releaseRequestedAt,
    releasedAt: merged.releasedAt,
    releaseConfirmedAt: merged.releaseConfirmedAt,
    acknowledgedAt: merged.acknowledgedAt,
    acknowledgedBy: merged.acknowledgedBy,
  };
}
