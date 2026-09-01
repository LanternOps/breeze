import { useEffect, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { store, useAppDispatch } from '../store';
import { fetchTickets } from '../store/ticketsSlice';
import {
  addNotificationReceivedListener,
  addNotificationResponseReceivedListener,
  getLastNotificationResponse,
  parseTicketNotification,
  removeNotificationSubscription,
} from '../services/notifications';
import { navigateToTicket } from './navigationRef';
import { LAST_HANDLED_RESPONSE_KEY, shouldReplayResponse } from './pushRouting';

/**
 * W10 (#4336). Ticket-only push listeners.
 *
 * Sibling of {@link ApprovalGate}, never a child: `ApprovalGate` returns
 * `<ApprovalScreen />` instead of its children while an approval is focused, so
 * a nested router would unmount and tear down these subscriptions exactly when
 * an approval is on screen — the one case the spec requires taps to survive (a
 * ticket tap during an approval navigates underneath and is revealed when the
 * decision clears). Expo subscriptions are independently removable, so a second
 * type-filtered listener coexists with ApprovalGate's own.
 *
 * Renders nothing. All decisions live in `pushRouting.ts` /
 * `services/notifications.ts` so they are unit-tested; this file is wiring.
 */
export function PushTapRouter() {
  const dispatch = useAppDispatch();
  /** Response identifier we have already navigated for, in this process. */
  const lastHandled = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const handleTap = async (identifier: string, ticketId: string) => {
      lastHandled.current = identifier;
      try {
        // Persisted so a relaunch does not replay the same launching tap. A
        // storage failure only costs one redundant navigation, so it must not
        // block the navigation itself.
        await AsyncStorage.setItem(LAST_HANDLED_RESPONSE_KEY, identifier);
      } catch (err) {
        console.warn('[PushTapRouter] could not persist last handled response', err);
      }
      navigateToTicket(ticketId);
    };

    // Cold start: the response that launched the app is only available here,
    // never through the tap listener. Identifier-guarded so a remount does not
    // re-navigate (getLastNotificationResponseAsync returns the same response
    // for the life of the process).
    void (async () => {
      try {
        const stored = await AsyncStorage.getItem(LAST_HANDLED_RESPONSE_KEY);
        if (cancelled) return;
        // Do not clobber a live tap that landed while storage was being read.
        if (lastHandled.current === null) lastHandled.current = stored;

        const last = await getLastNotificationResponse();
        if (cancelled || !last) return;

        const parsed = parseTicketNotification(last.notification);
        if (!parsed) return;

        const identifier = last.notification.request.identifier;
        if (!shouldReplayResponse(identifier, lastHandled.current)) return;
        await handleTap(identifier, parsed.ticketId);
      } catch (err) {
        console.warn('[PushTapRouter] cold-start replay failed', err);
      }
    })();

    const received = addNotificationReceivedListener((notification) => {
      if (!parseTicketNotification(notification)) return;
      // Foreground: the OS still presents the banner, so all this owes the
      // technician is a list that already reflects the change when they look.
      // Read the live filters rather than closing over them — the effect must
      // not re-run (and tear down its subscriptions) on every filter change.
      const { queue, assignee } = store.getState().tickets;
      void dispatch(fetchTickets({ statusGroup: queue, assignee }));
    });

    const tapped = addNotificationResponseReceivedListener((response) => {
      const parsed = parseTicketNotification(response.notification);
      if (!parsed) return;
      void handleTap(response.notification.request.identifier, parsed.ticketId);
    });

    return () => {
      cancelled = true;
      removeNotificationSubscription(received);
      removeNotificationSubscription(tapped);
    };
  }, [dispatch]);

  return null;
}
