import { beforeEach, describe, expect, it, vi } from 'vitest';

// Pure-logic coverage of the token-acquisition branch. Everything RN/Expo is
// mocked with a factory so nothing pulls the React Native runtime into the
// node-only vitest environment (see vitest.config.ts).
// vi.hoisted: these are referenced from vi.mock factories, which are hoisted
// above normal const declarations.
const platform = vi.hoisted(() => ({ OS: 'ios' as 'ios' | 'android' }));
vi.mock('react-native', () => ({ Platform: platform }));

const device = vi.hoisted(() => ({ isDevice: true }));
vi.mock('expo-device', () => ({
  get isDevice() {
    return device.isDevice;
  },
}));

const constants = vi.hoisted(() => ({ expoConfig: { extra: {} } as Record<string, unknown> }));
vi.mock('expo-constants', () => ({ default: constants }));

const notif = vi.hoisted(() => ({
  setNotificationHandler: vi.fn(),
  getPermissionsAsync: vi.fn(),
  requestPermissionsAsync: vi.fn(),
  getDevicePushTokenAsync: vi.fn(),
  getExpoPushTokenAsync: vi.fn(),
  setNotificationChannelAsync: vi.fn(),
  getPresentedNotificationsAsync: vi.fn(),
  dismissNotificationAsync: vi.fn(),
  setBadgeCountAsync: vi.fn(),
  AndroidImportance: { MAX: 5 },
}));
vi.mock('expo-notifications', () => notif);

const api = vi.hoisted(() => ({ registerPushToken: vi.fn() }));
vi.mock('./api', () => ({ registerPushToken: (...a: unknown[]) => api.registerPushToken(...a) }));

import {
  registerForPushNotifications,
  reconcileApprovalNotifications,
  staleApprovalNotificationIds,
} from './notifications';

beforeEach(() => {
  platform.OS = 'ios';
  device.isDevice = true;
  constants.expoConfig = { extra: {} };
  notif.getPermissionsAsync.mockReset().mockResolvedValue({ status: 'granted' });
  notif.requestPermissionsAsync.mockReset().mockResolvedValue({ status: 'granted' });
  notif.getDevicePushTokenAsync.mockReset().mockResolvedValue({ data: 'APNS-TOKEN' });
  notif.getExpoPushTokenAsync.mockReset().mockResolvedValue({ data: 'ExponentPushToken[x]' });
  notif.setNotificationChannelAsync.mockReset().mockResolvedValue(undefined);
  api.registerPushToken.mockReset().mockResolvedValue(undefined);
});

describe('registerForPushNotifications', () => {
  it('iOS uses the NATIVE APNs token, never the Expo relay', async () => {
    const out = await registerForPushNotifications();

    expect(out).toEqual({ status: 'ok', token: 'APNS-TOKEN' });
    expect(notif.getDevicePushTokenAsync).toHaveBeenCalledTimes(1);
    // The whole point of the native-APNs switch: no Expo account involvement.
    expect(notif.getExpoPushTokenAsync).not.toHaveBeenCalled();
    expect(api.registerPushToken).toHaveBeenCalledWith('APNS-TOKEN', 'ios');
  });

  it('iOS does not need an EAS projectId', async () => {
    constants.expoConfig = { extra: {} }; // no eas.projectId anywhere
    await expect(registerForPushNotifications()).resolves.toMatchObject({ status: 'ok' });
  });

  it('Android without a projectId reports UNSUPPORTED, not failed', async () => {
    // Regression: this used to throw 'EAS projectId missing', get caught, and
    // surface as status:'failed' — showing a red "push failed" banner for a
    // feature that was never wired after app.json dropped extra.eas.projectId.
    platform.OS = 'android';

    const out = await registerForPushNotifications();

    expect(out).toEqual({ status: 'unsupported', reason: 'android_push_not_configured' });
    expect(api.registerPushToken).not.toHaveBeenCalled();
  });

  it('Android WITH a projectId still uses the Expo relay', async () => {
    platform.OS = 'android';
    constants.expoConfig = { extra: { eas: { projectId: 'proj-1' } } };

    const out = await registerForPushNotifications();

    expect(out).toEqual({ status: 'ok', token: 'ExponentPushToken[x]' });
    expect(notif.getExpoPushTokenAsync).toHaveBeenCalledWith({ projectId: 'proj-1' });
    expect(api.registerPushToken).toHaveBeenCalledWith('ExponentPushToken[x]', 'android');
  });

  it('reports unsupported on a simulator', async () => {
    device.isDevice = false;

    await expect(registerForPushNotifications()).resolves.toEqual({
      status: 'unsupported',
      reason: 'not_physical_device',
    });
  });

  it('reports failed when the user denies permission', async () => {
    notif.getPermissionsAsync.mockResolvedValue({ status: 'denied' });
    notif.requestPermissionsAsync.mockResolvedValue({ status: 'denied' });

    await expect(registerForPushNotifications()).resolves.toEqual({
      status: 'failed',
      reason: 'permission_denied',
    });
  });

  it('reports failed when the token call throws', async () => {
    notif.getDevicePushTokenAsync.mockRejectedValue(new Error('APNs unavailable'));

    await expect(registerForPushNotifications()).resolves.toEqual({
      status: 'failed',
      reason: 'APNs unavailable',
    });
  });
});

/**
 * A request approved in the web UI leaves its push banner sitting in
 * Notification Center on the phone. Clearing it is the visible half of "the
 * approval dismissed itself"; alert banners must survive the sweep.
 */
function presented(identifier: string, data: Record<string, unknown> | null) {
  return { request: { identifier, content: { data } } };
}

describe('staleApprovalNotificationIds', () => {
  it('selects approval banners whose request is no longer pending', () => {
    const list = [
      presented('n1', { type: 'approval', approvalId: 'a' }),
      presented('n2', { type: 'approval', approvalId: 'b' }),
    ];
    expect(staleApprovalNotificationIds(list, ['b'])).toEqual(['n1']);
  });

  it('never touches alert banners or payload-less notifications', () => {
    const list = [
      presented('n1', { type: 'alert', alertId: 'x', eventType: 'alert.triggered' }),
      presented('n2', null),
      presented('n3', { type: 'approval', approvalId: 'gone' }),
    ];
    expect(staleApprovalNotificationIds(list, [])).toEqual(['n3']);
  });

  it('returns nothing when every delivered approval is still pending', () => {
    const list = [presented('n1', { type: 'approval', approvalId: 'a' })];
    expect(staleApprovalNotificationIds(list, ['a', 'b'])).toEqual([]);
  });
});

describe('reconcileApprovalNotifications', () => {
  beforeEach(() => {
    notif.getPresentedNotificationsAsync.mockReset().mockResolvedValue([]);
    notif.dismissNotificationAsync.mockReset().mockResolvedValue(undefined);
    notif.setBadgeCountAsync.mockReset().mockResolvedValue(undefined);
  });

  it('dismisses resolved approval banners and syncs the badge', async () => {
    notif.getPresentedNotificationsAsync.mockResolvedValue([
      presented('n1', { type: 'approval', approvalId: 'decided-in-browser' }),
      presented('n2', { type: 'approval', approvalId: 'still-waiting' }),
    ]);

    await reconcileApprovalNotifications(['still-waiting']);

    expect(notif.dismissNotificationAsync).toHaveBeenCalledTimes(1);
    expect(notif.dismissNotificationAsync).toHaveBeenCalledWith('n1');
    expect(notif.setBadgeCountAsync).toHaveBeenCalledWith(1);
  });

  it('degrades quietly when the notification APIs throw', async () => {
    notif.getPresentedNotificationsAsync.mockRejectedValue(new Error('no permission'));
    await expect(reconcileApprovalNotifications([])).resolves.toBeUndefined();
  });
});
