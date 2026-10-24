import { useEffect, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Sentry from '@sentry/react-native';

import { store, useAppDispatch } from '../store';
import { fetchTickets } from '../store/ticketsSlice';
import {
  addNotificationReceivedListener,
  addNotificationResponseReceivedListener,
  getLastNotificationResponse,
  parseTicketNotification,
  removeNotificationSubscription,
} from '../services/notifications';
import { navigateToTicket, navigateToWispThread } from './navigationRef';
import {
  LAST_HANDLED_RESPONSE_KEY,
  resolvePushRoute,
  shouldHandleTap,
  shouldReplayResponse,
  type PushRoute,
} from './pushRouting';

type Routable = NonNullable<PushRoute>;

function routeOf(notification: { request: { content: { data?: unknown } } }): Routable | null {
  return resolvePushRoute(notification.request.content.data as Record<string, unknown> | undefined);
}

/**
 * W10 (#4336). Ticket push listeners; Wisp W06 adds `wisp_nudge` taps, which
 * open the Wisp thread inside the Home stack. One dedupe key covers both kinds
 * (a response identifier is unique per notification, whatever its type).
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

    const handleTap = async (identifier: string, route: Routable) => {
      lastHandled.current = identifier;
      try {
        // Persisted so a relaunch does not replay the same launching tap. A
        // storage failure only costs one redundant navigation, so it must not
        // block the navigation itself.
        await AsyncStorage.setItem(LAST_HANDLED_RESPONSE_KEY, identifier);
      } catch (err) {
        console.warn('[PushTapRouter] could not persist last handled response', err);
      }
      // Re-checked after the await: a sign-out (or any teardown) mid-write must
      // not navigate a tree that has already been swapped out.
      if (cancelled) return;
      if (route.kind === 'ticket') {
        navigateToTicket(route.ticketId);
        return;
      }
      navigateToWispThread({
        threadId: route.threadId,
        grantId: route.grantId,
        concernId: route.concernId,
        approvalIntentId: route.approvalIntentId,
      });
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

        const route = routeOf(last.notification);
        if (!route) return;

        const identifier = last.notification.request.identifier;
        if (!shouldReplayResponse(identifier, lastHandled.current)) return;
        await handleTap(identifier, route);
      } catch (err) {
        // Reported, not just logged: a failure here means the push that
        // launched the app silently opened nothing, which is invisible to us
        // and looks to the technician like the notification did not work.
        console.warn('[PushTapRouter] cold-start replay failed', err);
        Sentry.captureException(err, { tags: { area: 'push-tap-cold-start' } });
      }
    })();

    const received = addNotificationReceivedListener((notification) => {
      // A foreground wisp nudge has no list on screen to refresh: the thread
      // screen loads its concerns on open. Only ticket pushes act here.
      if (!parseTicketNotification(notification)) return;
      // Foreground: the OS still presents the banner, so all this owes the
      // technician is a list that already reflects the change when they look.
      // Read the live filters rather than closing over them — the effect must
      // not re-run (and tear down its subscriptions) on every filter change.
      const { queue, assignee } = store.getState().tickets;
      void dispatch(fetchTickets({ statusGroup: queue, assignee }));
    });

    const tapped = addNotificationResponseReceivedListener((response) => {
      const route = routeOf(response.notification);
      if (!route) return;
      const identifier = response.notification.request.identifier;
      // expo also delivers the app-LAUNCHING response here, so without this the
      // cold-start branch above and this listener both act on the same tap.
      if (!shouldHandleTap(identifier, lastHandled.current)) return;
      void handleTap(identifier, route);
    });

    return () => {
      cancelled = true;
      removeNotificationSubscription(received);
      removeNotificationSubscription(tapped);
    };
  }, [dispatch]);

  return null;
}
