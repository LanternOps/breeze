import { beforeEach, describe, expect, it, vi } from 'vitest';

const secureStore = vi.hoisted(() => ({ getItemAsync: vi.fn(), setItemAsync: vi.fn() }));
vi.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked-this-device-only',
  getItemAsync: (...args: unknown[]) => secureStore.getItemAsync(...args),
  setItemAsync: (...args: unknown[]) => secureStore.setItemAsync(...args),
}));
vi.mock('./serverConfig', () => ({ getServerUrl: vi.fn(async () => 'https://api.example.com') }));
vi.mock('./installationId', () => ({ getOrCreateInstallationId: vi.fn(async () => 'install-1') }));

import { logout } from './api';

describe('mobile logout request identity', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    secureStore.getItemAsync.mockReset().mockResolvedValue(null);
    secureStore.setItemAsync.mockReset().mockResolvedValue(undefined);
  });

  it('uses the explicitly captured bearer after SecureStore has already been wiped', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await logout('captured-access-token');

    expect(secureStore.getItemAsync).toHaveBeenCalledOnce();
    expect(secureStore.getItemAsync).toHaveBeenCalledWith('breeze_native_auth_binding_v1');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.com/api/v1/auth/logout',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer captured-access-token' }),
      }),
    );
  });

  it('keeps the stable native binding header after the access credential is wiped', async () => {
    const nativeBinding = 'b'.repeat(64);
    secureStore.getItemAsync.mockImplementation(async (key: string) =>
      key === 'breeze_native_auth_binding_v1' ? nativeBinding : null);
    const fetchMock = vi.fn(async () => new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await logout('captured-access-token');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.com/api/v1/auth/logout',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer captured-access-token',
          'x-breeze-native-auth-binding': nativeBinding,
        }),
      }),
    );
  });

  it('does not bootstrap or retry logout across a terminal boundary', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', {
      status: 428,
      headers: { 'x-breeze-native-auth-binding': 'c'.repeat(64) },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(logout('captured-access-token')).rejects.toMatchObject({ statusCode: 428 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(secureStore.setItemAsync).not.toHaveBeenCalled();
  });
});
