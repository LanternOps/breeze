import { beforeEach, describe, expect, it, vi } from 'vitest';

const secureStore = vi.hoisted(() => ({ getItemAsync: vi.fn() }));
vi.mock('expo-secure-store', () => ({
  getItemAsync: (...args: unknown[]) => secureStore.getItemAsync(...args),
}));
vi.mock('./serverConfig', () => ({ getServerUrl: vi.fn(async () => 'https://api.example.com') }));
vi.mock('./installationId', () => ({ getOrCreateInstallationId: vi.fn(async () => 'install-1') }));

import { logout } from './api';

describe('mobile logout request identity', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    secureStore.getItemAsync.mockReset().mockResolvedValue(null);
  });

  it('uses the explicitly captured bearer after SecureStore has already been wiped', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await logout('captured-access-token');

    expect(secureStore.getItemAsync).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.com/api/v1/auth/logout',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer captured-access-token' }),
      }),
    );
  });
});
