import { useEffect, useRef } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import { useAppDispatch, useAppSelector } from '../../store';
import { pruneExpired, refreshPending } from '../../store/approvalsSlice';
import { reconcileApprovalNotifications } from '../../services/notifications';

/**
 * How often to re-poll `/pending` while the takeover screen is up.
 *
 * A request decided in the browser produces no push and no socket event, so
 * the phone only learns by asking. 5s is the gap between "tech approves on
 * their laptop" and "the phone stops demanding a decision" — short enough to
 * feel like it dismissed itself, long enough to be a rounding error on
 * battery given it only runs while a request is actually on screen.
 */
export const TAKEOVER_POLL_MS = 5_000;

/** Wall-clock expiry sweep cadence. Local-only; costs nothing. */
const EXPIRY_SWEEP_MS = 1_000;

/**
 * Keeps the local approvals queue in step with the server.
 *
 * Before this, `/pending` was fetched exactly once when ApprovalGate mounted
 * and the queue was thereafter only ever mutated by decisions made ON THIS
 * PHONE. Anything resolved elsewhere — approved in the web UI, denied from a
 * second device, expired server-side — stayed `pending` locally for the life
 * of the process, so requests piled up behind a takeover the user had already
 * dealt with and could not clear.
 *
 * Three triggers, all cheap:
 *  - foreground: the app was backgrounded while decisions happened elsewhere;
 *  - interval, only while a takeover is visible: catch a browser decision
 *    made with the phone in hand;
 *  - local expiry sweep: age out the whole queue, not just the focused row.
 */
export function useApprovalQueueSync(): void {
  const dispatch = useAppDispatch();
  const hasFocused = useAppSelector((s) =>
    s.approvals.pending.some((a) => a.id === s.approvals.focusId && a.status === 'pending')
  );
  const pendingIds = useAppSelector((s) =>
    s.approvals.pending
      .filter((a) => a.status === 'pending')
      .map((a) => a.id)
      .join(',')
  );
  const hasSynced = useAppSelector((s) => s.approvals.hasSynced);

  // Refresh on background→foreground. AppState fires for 'inactive' too (the
  // app switcher, a Face ID sheet); only a real 'active' transition counts,
  // otherwise every biometric prompt during an approve would refetch.
  const appState = useRef<AppStateStatus>(AppState.currentState);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      const wasBackground = appState.current.match(/inactive|background/) !== null;
      appState.current = next;
      if (wasBackground && next === 'active') {
        void dispatch(refreshPending());
      }
    });
    return () => sub.remove();
  }, [dispatch]);

  // Poll only while a request is actually on screen.
  useEffect(() => {
    if (!hasFocused) return;
    const id = setInterval(() => {
      if (AppState.currentState !== 'active') return;
      void dispatch(refreshPending());
    }, TAKEOVER_POLL_MS);
    return () => clearInterval(id);
  }, [hasFocused, dispatch]);

  useEffect(() => {
    const id = setInterval(() => {
      dispatch(pruneExpired(Date.now()));
    }, EXPIRY_SWEEP_MS);
    return () => clearInterval(id);
  }, [dispatch]);

  // Notification Center should hold exactly the requests still awaiting a
  // decision. Without this, the banner for an approval handled in the browser
  // sits in the shade forever — the most visible half of "they queue up".
  //
  // Gated on `hasSynced`: an empty queue before the first /pending response
  // means "not asked yet", and sweeping on that would clear the banner for a
  // request that is still live.
  useEffect(() => {
    if (!hasSynced) return;
    const ids = pendingIds ? pendingIds.split(',') : [];
    void reconcileApprovalNotifications(ids);
  }, [hasSynced, pendingIds]);
}
