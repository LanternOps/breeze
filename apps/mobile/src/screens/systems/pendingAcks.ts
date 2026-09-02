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

export interface PendingAckState {
  /**
   * Ids optimistically hidden, REFERENCE-COUNTED.
   *
   * A plain set loses overlapping operations: if the same id is started twice
   * and the first finishes, an unconditional delete un-hides a row whose second
   * request is still running. Counting keeps it hidden until the last one ends.
   */
  pending: ReadonlyMap<string, number>;
}

export const emptyPendingAcks: PendingAckState = { pending: new Map() };

export function beginAck(state: PendingAckState, ids: readonly string[]): PendingAckState {
  if (ids.length === 0) return state;
  const next = new Map(state.pending);
  for (const id of ids) next.set(id, (next.get(id) ?? 0) + 1);
  return { pending: next };
}

/**
 * Drop ids from the pending set.
 *
 * Used for both outcomes: on success the server's own refetch supplies the new
 * truth, and on failure the rows must come back. Callers distinguish the two by
 * whether they also surface an error — this function only stops hiding.
 */
export function endAck(state: PendingAckState, ids: readonly string[]): PendingAckState {
  if (ids.length === 0) return state;
  const next = new Map(state.pending);
  for (const id of ids) {
    const count = next.get(id);
    if (count === undefined) continue;
    if (count <= 1) next.delete(id);
    else next.set(id, count - 1);
  }
  return { pending: next };
}

/** Hide optimistically-acknowledged rows from a rendered list. */
export function visibleAlerts(alerts: readonly Alert[], state: PendingAckState): Alert[] {
  if (state.pending.size === 0) return alerts as Alert[];
  return alerts.filter((a) => !isPending(state, a.id));
}

export function isPending(state: PendingAckState, id: string): boolean {
  return (state.pending.get(id) ?? 0) > 0;
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
