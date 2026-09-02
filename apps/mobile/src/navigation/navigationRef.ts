import { createNavigationContainerRef } from '@react-navigation/native';

import type { MainTabParamList } from './MainNavigator';

/**
 * W10 (#4336). Module-level navigation ref so non-screen code (PushTapRouter)
 * can navigate.
 *
 * No `linking` config is wired: nothing produces Breeze URLs, and a deep-link
 * config would be a second, untested route table to keep in step with this one.
 */
export const navigationRef = createNavigationContainerRef<MainTabParamList>();

/**
 * The latest ticket a tap asked for while the container was not yet mounted.
 *
 * Exactly one slot, not a queue: a technician who taps two pushes during a cold
 * start wants the last one they touched, and replaying both would flash a
 * ticket they already moved past.
 */
let pendingTicketId: string | null = null;

export function navigateToTicket(ticketId: string): void {
  // react-navigation silently DROPS navigate() calls before the container is
  // ready, so a cold-start tap would open nothing at all. Buffer instead.
  if (!navigationRef.isReady()) {
    pendingTicketId = ticketId;
    return;
  }
  navigationRef.navigate('TicketsTab', {
    screen: 'TicketDetail',
    params: { ticketId },
  });
}

/** Call from `NavigationContainer`'s `onReady`. Safe to call repeatedly. */
export function flushPendingNavigation(): void {
  if (!pendingTicketId) return;
  const ticketId = pendingTicketId;
  pendingTicketId = null;
  // Re-buffers itself if the container somehow still is not ready, so an early
  // flush cannot swallow the tap.
  navigateToTicket(ticketId);
}

export function __resetPendingForTests(): void {
  pendingTicketId = null;
}
