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
    flushPendingNavigation(); // onReady can fire again on a container remount

    expect(ref.navigate).toHaveBeenCalledTimes(1);
    expect(ref.navigate).toHaveBeenCalledWith('TicketsTab', {
      screen: 'TicketDetail',
      params: { ticketId: 't-2' },
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
