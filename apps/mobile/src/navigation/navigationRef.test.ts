import { beforeEach, describe, expect, it, vi } from 'vitest';

// vi.hoisted: the mock factory below is hoisted above normal consts.
const ref = vi.hoisted(() => ({ ready: false, navigate: vi.fn() }));
vi.mock('@react-navigation/native', () => ({
  createNavigationContainerRef: () => ({
    isReady: () => ref.ready,
    navigate: ref.navigate,
  }),
}));

import { __resetPendingForTests, flushPendingNavigation, navigateToTicket } from './navigationRef';

describe('navigateToTicket (#4336)', () => {
  beforeEach(() => {
    ref.ready = false;
    ref.navigate.mockClear();
    __resetPendingForTests();
  });

  it('navigates immediately when the container is ready', () => {
    ref.ready = true;

    navigateToTicket('t-1');

    expect(ref.navigate).toHaveBeenCalledWith('TicketsTab', {
      screen: 'TicketDetail',
      params: { ticketId: 't-1' },
    });
  });

  it('buffers before ready and flushes exactly once on onReady', () => {
    // A cold-start tap resolves before NavigationContainer mounts. Navigating
    // then is a silent no-op — react-navigation drops the call — so the tap
    // that launched the app would open nothing.
    navigateToTicket('t-1');
    navigateToTicket('t-2'); // latest tap wins

    expect(ref.navigate).not.toHaveBeenCalled();

    ref.ready = true;
    flushPendingNavigation();
    flushPendingNavigation(); // more than one flush source; must not double-navigate

    expect(ref.navigate).toHaveBeenCalledTimes(1);
    expect(ref.navigate).toHaveBeenCalledWith('TicketsTab', {
      screen: 'TicketDetail',
      params: { ticketId: 't-2' },
    });
  });

  it('delivers a tap buffered while the navigator was torn down and remounted', () => {
    // The real scenario this exists for: ApprovalGate renders ApprovalScreen
    // INSTEAD of MainNavigator, so the root navigator unmounts and isReady()
    // goes true -> false -> true within one container lifetime. NavigationContainer's
    // onReady fires at most ONCE per container (react-navigation guards it with
    // an onReadyCalledRef it never resets), so the remount is flushed by
    // MainNavigator's own mount effect instead. Without that second flush
    // source, a ticket tap taken during an approval is stranded forever.
    ref.ready = true;
    flushPendingNavigation(); // container's one-and-only onReady, nothing buffered
    expect(ref.navigate).not.toHaveBeenCalled();

    ref.ready = false; // approval takeover unmounts MainNavigator
    navigateToTicket('t-4'); // technician taps a ticket push underneath it
    expect(ref.navigate).not.toHaveBeenCalled();

    ref.ready = true; // approval decided, MainNavigator remounts
    flushPendingNavigation(); // from MainNavigator's mount effect

    expect(ref.navigate).toHaveBeenCalledTimes(1);
    expect(ref.navigate).toHaveBeenCalledWith('TicketsTab', {
      screen: 'TicketDetail',
      params: { ticketId: 't-4' },
    });
  });

  it('flushing with nothing buffered is a no-op', () => {
    ref.ready = true;

    flushPendingNavigation();

    expect(ref.navigate).not.toHaveBeenCalled();
  });

  it('re-buffers rather than dropping when the container is still not ready at flush time', () => {
    // onReady is the only caller today, but a flush from anywhere else must not
    // silently discard the pending tap.
    navigateToTicket('t-3');

    flushPendingNavigation(); // still not ready

    expect(ref.navigate).not.toHaveBeenCalled();

    ref.ready = true;
    flushPendingNavigation();

    expect(ref.navigate).toHaveBeenCalledTimes(1);
    expect(ref.navigate).toHaveBeenCalledWith('TicketsTab', {
      screen: 'TicketDetail',
      params: { ticketId: 't-3' },
    });
  });
});
