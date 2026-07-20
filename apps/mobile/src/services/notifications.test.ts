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
  AndroidImportance: { MAX: 5 },
}));
vi.mock('expo-notifications', () => notif);

const api = vi.hoisted(() => ({ registerPushToken: vi.fn() }));
vi.mock('./api', () => ({ registerPushToken: (...a: unknown[]) => api.registerPushToken(...a) }));

import { registerForPushNotifications } from './notifications';

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
