import { createNavigationContainerRef } from '@react-navigation/native';

import type { MainTabParamList, TicketDetailParams } from './MainNavigator';

/**
 * W10 (#4336). Module-level navigation ref so non-screen code (PushTapRouter)
 * can navigate.
 *
 * No `linking` config is wired: nothing produces Breeze URLs, and a deep-link
 * config would be a second, untested route table to keep in step with this one.
 */
export const navigationRef = createNavigationContainerRef<MainTabParamList>();

/**
 * How the ticket should open, beyond which ticket it is (#5366).
 *
 * Optional and omitted-not-undefined when absent: a push tap must produce the
 * exact same params it always did, so nothing about the notification path
 * changes just because the timer path wants more.
 */
export interface TicketOpenOptions {
  composeMode?: TicketDetailParams['composeMode'];
  focusComposer?: boolean;
}

/**
 * The latest ticket a tap asked for while the container was not yet mounted,
 * together with how that caller wanted it opened.
 *
 * Exactly one slot, not a queue: a technician who taps two pushes during a cold
 * start wants the last one they touched, and replaying both would flash a
 * ticket they already moved past. The options travel in the same slot rather
 * than a parallel variable, so a later plain tap cannot inherit an earlier
 * caller's focus request.
 */
let pending: { ticketId: string; options: TicketOpenOptions } | null = null;

export function navigateToTicket(ticketId: string, options: TicketOpenOptions = {}): void {
  // react-navigation silently DROPS navigate() calls before the container is
  // ready, so a cold-start tap would open nothing at all. Buffer instead.
  if (!navigationRef.isReady()) {
    pending = { ticketId, options };
    return;
  }
  const params: TicketDetailParams = { ticketId };
  // Built key by key rather than spread: an `undefined` property is not the
  // same as an absent one to `route.params` consumers that test with `in`, and
  // the plain-open shape is asserted to carry `ticketId` alone.
  if (options.composeMode !== undefined) params.composeMode = options.composeMode;
  if (options.focusComposer !== undefined) params.focusComposer = options.focusComposer;
  navigationRef.navigate('TicketsTab', {
    screen: 'TicketDetail',
    params,
  });
}

/** Call from `NavigationContainer`'s `onReady`. Safe to call repeatedly. */
export function flushPendingNavigation(): void {
  if (!pending) return;
  const { ticketId, options } = pending;
  pending = null;
  // Re-buffers itself if the container somehow still is not ready, so an early
  // flush cannot swallow the tap.
  navigateToTicket(ticketId, options);
}

export function __resetPendingForTests(): void {
  pending = null;
}
