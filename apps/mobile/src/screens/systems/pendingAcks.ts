import type { Alert } from '../../services/api';

/**
 * Optimistic acknowledge bookkeeping.
 *
 * Acknowledging is slow on a real deployment — the write returns 200 but has
 * been measured at 13-15s because the API publishes its event inside the
 * request path. Waiting on that per row makes triaging a screen of alerts
 * unusable, and a bulk action over N alerts multiplies it.
 *
 * So the UI removes rows immediately and reconciles when the server answers.
 * This module is the pure part of that: which ids are in flight, and how the
 * visible list is derived from them. Kept renderer-free so the rollback
 * semantics are testable.
 */

interface PendingEntry {
  /**
   * Overlapping optimistic-hide operations still in flight for this id.
   *
   * A plain set loses overlapping operations: if the same id is started twice
   * and the first finishes, an unconditional delete un-hides a row whose second
   * request is still running. Counting keeps it hidden until the last one ends.
   */
  count: number;
  /**
   * The activeAlerts fetch generation this id's most recently CONFIRMED
   * acknowledge must see superseded before `releaseStaleAcks` may un-hide it.
   * `null` while no confirmed ack is on record for this id — those ids only
   * come back via an explicit `endAck` (failure, unmount, undo), never
   * automatically. See #3782.
   */
  releaseAfterGeneration: number | null;
}

export interface PendingAckState {
  pending: ReadonlyMap<string, PendingEntry>;
}

export const emptyPendingAcks: PendingAckState = { pending: new Map() };

export function beginAck(state: PendingAckState, ids: readonly string[]): PendingAckState {
  if (ids.length === 0) return state;
  const next = new Map(state.pending);
  for (const id of ids) {
    const existing = next.get(id);
    next.set(id, {
      count: (existing?.count ?? 0) + 1,
      // A brand-new operation on this id supersedes whatever an earlier one
      // recorded: it must not release until THIS operation's own outcome is
      // confirmed and a fresh snapshot proves it, not an earlier one's.
      releaseAfterGeneration: null,
    });
  }
  return { pending: next };
}

/**
 * Drop ids from the pending set immediately, unconditionally.
 *
 * Used for outcomes that need no proof from a fresh fetch: a failed
 * acknowledge (the row must come back now), an unmount, or an undo that never
 * sent a request. A successful/unknown-outcome acknowledge instead goes
 * through `markAckConfirmed` + `releaseStaleAcks`, which wait for evidence.
 */
export function endAck(state: PendingAckState, ids: readonly string[]): PendingAckState {
  if (ids.length === 0) return state;
  const next = new Map(state.pending);
  for (const id of ids) {
    const entry = next.get(id);
    if (entry === undefined) continue;
    if (entry.count <= 1) next.delete(id);
    else next.set(id, { ...entry, count: entry.count - 1 });
  }
  return { pending: next };
}

/**
 * Record that an acknowledge for these ids has been confirmed by the server
 * (or its outcome is unknown, which must be treated as possibly-committed) as
 * of `generation` — the activeAlerts fetch generation observed at that
 * moment.
 *
 * This does NOT release anything. It only sets the bar a later fetch has to
 * clear. `refresh()` resolving is not proof of freshness by itself — it can
 * coalesce into a fetch that was already in flight before this confirmation,
 * whose response may predate it. What the bar actually guarantees is weaker
 * but sufficient in practice: AT LEAST ONE activeAlerts fetch has completed
 * since confirmation, so a fetch issued (not merely landed) before this call
 * cannot be the one satisfying it forever — a following one will, and further
 * fetches keep arriving from push/WS/focus/pull. A residual one-fetch window
 * where an in-flight response still predates the ack is possible; that is a
 * BRIEFLY stale visible row, which #3782 treats as acceptable — permanent
 * concealment is the outcome this guards against, not a perfect proof.
 *
 * `Math.max` merges overlapping confirmations on the same id (see
 * `beginAck`) to the LATER, stricter requirement — release only fires once
 * proof exists for the most recent operation, which is also sufficient proof
 * for any earlier one on the same id.
 */
export function markAckConfirmed(
  state: PendingAckState,
  ids: readonly string[],
  generation: number
): PendingAckState {
  if (ids.length === 0) return state;
  const next = new Map(state.pending);
  for (const id of ids) {
    const entry = next.get(id);
    if (entry === undefined) continue;
    next.set(id, {
      ...entry,
      releaseAfterGeneration: Math.max(entry.releaseAfterGeneration ?? -1, generation),
    });
  }
  return { pending: next };
}

/**
 * Release every id whose confirmed acknowledge has been superseded by a newer
 * activeAlerts snapshot than the one recorded at confirmation time.
 *
 * Meant to be called whenever the generation advances, regardless of which
 * caller's fetch advanced it — a push, a WS event, a tab-focus refresh, and
 * the acknowledge's own `refresh()` call all count equally. That is what
 * makes a coalesced refresh harmless: SOME fetch will eventually land and
 * bump the generation, and release happens against that one instead of
 * requiring the specific call that issued the ack to be the one that
 * resolved freshly.
 *
 * Releases the WHOLE entry once its bar is passed, not one reference-count
 * unit per call. `markAckConfirmed` already merged every overlapping
 * operation on the id down to a single (the strictest) bar, so passing it is
 * proof for all of them at once — draining the count one generation-tick at a
 * time would just add stalls with no extra safety.
 */
export function releaseStaleAcks(state: PendingAckState, generation: number): PendingAckState {
  let next: Map<string, PendingEntry> | undefined;
  for (const [id, entry] of state.pending) {
    if (entry.releaseAfterGeneration === null) continue;
    if (generation <= entry.releaseAfterGeneration) continue;
    if (next === undefined) next = new Map(state.pending);
    next.delete(id);
  }
  return next === undefined ? state : { pending: next };
}

/** Hide optimistically-acknowledged rows from a rendered list. */
export function visibleAlerts(alerts: readonly Alert[], state: PendingAckState): Alert[] {
  if (state.pending.size === 0) return alerts as Alert[];
  return alerts.filter((a) => !isPending(state, a.id));
}

export function isPending(state: PendingAckState, id: string): boolean {
  return (state.pending.get(id)?.count ?? 0) > 0;
}

/**
 * Keep only ids that are still actionable.
 *
 * A selection can outlive the rows it names — another operator acknowledges
 * one, or a refresh drops it — and submitting a stale id makes the server skip
 * it while the UI claims success.
 */
export function reconcileSelection(
  selected: ReadonlySet<string>,
  visible: readonly { id: string }[]
): Set<string> {
  const present = new Set(visible.map((v) => v.id));
  const next = new Set<string>();
  for (const id of selected) if (present.has(id)) next.add(id);
  return next;
}

/** Selection-mode toggle. Returns a new set; never mutates. */
export function toggleSelection(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** "Acknowledge 3" / "Acknowledge alert" — plural only when it earns it. */
export function bulkActionLabel(count: number): string {
  if (count <= 1) return 'Acknowledge alert';
  return `Acknowledge ${count} alerts`;
}
