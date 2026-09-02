/**
 * Undo-window bookkeeping for acknowledge.
 *
 * An acknowledge cannot be reversed: there is no unacknowledge route, so a
 * stray swipe on a phone — one-handed, in a list — is unrecoverable. The fix is
 * to not send the request yet. The row hides immediately (see `pendingAcks`), a
 * toast holds the request for its lifetime, and the dispatch happens only when
 * that window closes. Undo simply means the request is never made.
 *
 * This module is the pure part: which ids are waiting, and which ids a given
 * event releases. No timers, no React — the component owns those, so the
 * ordering rules below stay testable.
 *
 * ONE batch at a time, deliberately. A per-row toast stack for a 30-alert
 * selection is its own bug, so a new acknowledge does not open a second window:
 * it flushes the batch already waiting (that operator moved on) and starts a
 * fresh one. Undo therefore always means "the thing I just did", which is the
 * only reading a one-button toast can support.
 */

export interface UndoBatch {
  /**
   * Identifies THIS window. A timer, an undo tap and an unmount can all fire
   * against a batch that has already been released, and without a token the
   * late one would act on the wrong ids — restoring rows whose request is
   * already in flight, or sending a batch the operator undid.
   */
  readonly token: number;
  readonly ids: readonly string[];
}

export interface UndoState {
  readonly batch: UndoBatch | null;
  readonly nextToken: number;
}

export const emptyUndo: UndoState = { batch: null, nextToken: 1 };

export interface ScheduleResult {
  readonly state: UndoState;
  /** Ids whose window was cut short by this one. Send them now. */
  readonly flush: readonly string[];
  /** Token of the newly opened window, for the caller's timer. */
  readonly token: number;
}

/** Open an undo window, closing any window already open. */
export function scheduleUndo(state: UndoState, ids: readonly string[]): ScheduleResult {
  if (ids.length === 0) {
    return { state, flush: [], token: state.batch?.token ?? 0 };
  }
  const token = state.nextToken;
  return {
    state: { batch: { token, ids: [...ids] }, nextToken: token + 1 },
    flush: state.batch?.ids ?? [],
    token,
  };
}

export interface ReleaseResult {
  readonly state: UndoState;
  readonly ids: readonly string[];
}

/**
 * The window closed on its own: the ids must now be sent.
 *
 * A token that no longer matches means this timer belongs to a window that was
 * already undone or replaced, so it releases nothing.
 */
export function flushUndo(state: UndoState, token: number): ReleaseResult {
  if (!state.batch || state.batch.token !== token) return { state, ids: [] };
  return { state: { ...state, batch: null }, ids: state.batch.ids };
}

/**
 * The operator tapped Undo: the ids are never sent and must become visible
 * again. Stale tokens release nothing, for the same reason as `flushUndo` —
 * here it matters more, because restoring a row whose request already went out
 * shows an active alert that is about to be acknowledged.
 */
export function cancelUndo(state: UndoState, token: number): ReleaseResult {
  if (!state.batch || state.batch.token !== token) return { state, ids: [] };
  return { state: { ...state, batch: null }, ids: state.batch.ids };
}

/**
 * Leaving the screen FLUSHES; it does not cancel.
 *
 * Dropping a held request on unmount would make swipe-then-navigate silently do
 * nothing — a new silent failure in a change whose whole point was closing
 * those. The operator asked for the acknowledge; only an explicit Undo retracts
 * it.
 */
export function flushAllUndo(state: UndoState): ReleaseResult {
  if (!state.batch) return { state, ids: [] };
  return { state: { ...state, batch: null }, ids: state.batch.ids };
}

/** Toast copy. Plural only when it earns it. */
export function undoToastLabel(count: number): string {
  return count <= 1 ? 'Alert acknowledged' : `${count} alerts acknowledged`;
}
