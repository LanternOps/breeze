import { describe, expect, it, vi } from 'vitest';

// pushRouting imports the parser out of services/notifications, which pulls
// expo-notifications (and friends) in at module top. Same factory block as
// services/notifications.test.ts so nothing drags the React Native runtime into
// the node-only vitest environment.
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('expo-device', () => ({ isDevice: true }));
vi.mock('expo-constants', () => ({ default: { expoConfig: { extra: {} } } }));
vi.mock('expo-notifications', () => ({
  setNotificationHandler: vi.fn(),
  getPermissionsAsync: vi.fn(),
  requestPermissionsAsync: vi.fn(),
  getDevicePushTokenAsync: vi.fn(),
  getExpoPushTokenAsync: vi.fn(),
  setNotificationChannelAsync: vi.fn(),
  getPresentedNotificationsAsync: vi.fn(),
  dismissNotificationAsync: vi.fn(),
  setBadgeCountAsync: vi.fn(),
  AndroidImportance: { MAX: 5, HIGH: 4 },
}));
vi.mock('../services/api', () => ({ registerPushToken: vi.fn() }));

import { resolvePushRoute, shouldHandleTap, shouldReplayResponse } from './pushRouting';

describe('resolvePushRoute (#4336)', () => {
  it('routes ticket data to TicketDetail', () => {
    expect(resolvePushRoute({ type: 'ticket', ticketId: 't-1', reason: 'assigned' })).toEqual({
      kind: 'ticket',
      ticketId: 't-1',
    });
    expect(
      resolvePushRoute({ type: 'ticket', ticketId: 't-2', reason: 'sla_breached', target: 'resolution' })
    ).toEqual({ kind: 'ticket', ticketId: 't-2' });
  });

  it('ignores approvals, alerts, time suggestions and garbage', () => {
    // ApprovalGate owns approval pushes; routing them here would navigate
    // underneath the approval takeover for no reason.
    expect(resolvePushRoute({ type: 'approval', approvalId: 'a' })).toBeNull();
    expect(resolvePushRoute({ alertId: 'x', eventType: 'alert.triggered' })).toBeNull();
    expect(resolvePushRoute({ type: 'time_suggestions', date: '2026-08-29' })).toBeNull();
    expect(resolvePushRoute({ type: 'ticket', ticketId: '', reason: 'assigned' })).toBeNull();
    expect(resolvePushRoute(null)).toBeNull();
    expect(resolvePushRoute(undefined)).toBeNull();
  });
});

describe('shouldReplayResponse (#4336)', () => {
  it('replays a never-seen identifier once', () => {
    expect(shouldReplayResponse('r-1', null)).toBe(true);
    expect(shouldReplayResponse('r-1', 'r-1')).toBe(false);
    expect(shouldReplayResponse('r-2', 'r-1')).toBe(true);
  });

  it('never replays without an identifier', () => {
    // getLastNotificationResponseAsync keeps returning the SAME response on
    // every mount, so a missing identifier means we cannot tell a fresh cold
    // start from a remount — navigating on every remount is the worse failure.
    expect(shouldReplayResponse(undefined, null)).toBe(false);
    expect(shouldReplayResponse(null, null)).toBe(false);
    expect(shouldReplayResponse('', 'r-1')).toBe(false);
  });
});

describe('shouldHandleTap (#4336)', () => {
  it('skips a tap for the identifier we already acted on', () => {
    // expo delivers the app-LAUNCHING response to the response listener as well
    // as through getLastNotificationResponseAsync, so without this the cold
    // start handles the same tap twice.
    expect(shouldHandleTap('r-1', 'r-1')).toBe(false);
  });

  it('handles a genuinely new tap', () => {
    expect(shouldHandleTap('r-2', 'r-1')).toBe(true);
    expect(shouldHandleTap('r-1', null)).toBe(true);
  });

  it('handles an identifier-less tap rather than dropping it', () => {
    // Opposite default to shouldReplayResponse, deliberately: a live tap is a
    // real user action, so failing to dedupe it must not mean discarding it.
    // The worst case is one redundant navigation to a screen they asked for.
    expect(shouldHandleTap(undefined, 'r-1')).toBe(true);
    expect(shouldHandleTap('', 'r-1')).toBe(true);
  });
});
