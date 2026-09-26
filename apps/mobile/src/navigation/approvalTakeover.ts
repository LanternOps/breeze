import type { ApprovalRequest } from '../services/approvals';

/** The slice of `state.approvals` this module needs. */
export interface ApprovalTakeoverQueueState {
  pending: ApprovalRequest[];
  focusId: string | null;
}

/**
 * The single derivation of "is there a focused pending approval right now",
 * shared by BOTH `ApprovalGate` (drives its takeover `Modal`'s `visible`
 * prop) and `ApprovalScreen` (drives its content branch) — #5172.
 *
 * Before this module existed, the two components each wrote their own
 * inline `state.approvals.pending.find(...)` selector. The formulas were
 * identical, so this was never a redux-level race — `dropAndRefocus` clears
 * `pending` membership and `focusId` in the same reducer update, so any
 * subscriber reads a consistent snapshot. The bug this module exists to
 * make impossible to reintroduce is a maintenance one: a future edit to one
 * copy (e.g. adding an extra status check) silently drifting from the
 * other, which would let the Modal's visibility and the screen's own idea
 * of "focused" disagree for a render.
 */
export function selectFocusedApproval(
  state: ApprovalTakeoverQueueState
): ApprovalRequest | undefined {
  return state.pending.find((a) => a.id === state.focusId && a.status === 'pending');
}

/** Whether the takeover `Modal` should be visible. Derived from the same
 * selector as `selectFocusedApproval` so the two can never disagree. */
export function selectTakeoverVisible(state: ApprovalTakeoverQueueState): boolean {
  return selectFocusedApproval(state) !== undefined;
}

/**
 * "N of M" position of the focused approval among still-pending rows, for the
 * takeover's pager (#6212). Null when nothing is focused.
 */
export function selectQueuePosition(
  state: ApprovalTakeoverQueueState
): { index: number; total: number } | null {
  if (!selectFocusedApproval(state)) return null;
  const live = state.pending.filter((a) => a.status === 'pending');
  return { index: live.findIndex((a) => a.id === state.focusId) + 1, total: live.length };
}
