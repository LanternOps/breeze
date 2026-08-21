import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn().mockResolvedValue('tok'),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));
vi.mock('@sentry/react-native', () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));
vi.mock('./serverConfig', () => ({ getServerUrl: vi.fn().mockResolvedValue('https://example.test') }));
vi.mock('./installationId', () => ({ getOrCreateInstallationId: vi.fn().mockResolvedValue('i') }));

const fetchWithTimeout = vi.fn();
vi.mock('./fetchWithTimeout', () => ({
  fetchWithTimeout: (...a: unknown[]) => fetchWithTimeout(...a),
}));

import { getDevices } from './api';

const row = (id: string) => ({ id, hostname: id, status: 'online', orgId: 'o1' });
function page(rows: unknown[], nextCursor: string | null) {
  return () =>
    Promise.resolve(
      new Response(JSON.stringify({ data: rows, pagination: { page: 1, limit: 200, total: 999, nextCursor } }), {
        status: 200,
      })
    );
}

beforeEach(() => fetchWithTimeout.mockReset());

describe('getDevices paging', () => {
  it('follows nextCursor past the server page cap', async () => {
    // 210 devices cannot arrive in one page (server caps limit at 200), and a
    // single request silently truncated the fleet before this walk existed.
    fetchWithTimeout
      .mockImplementationOnce(page([row('a'), row('b')], 'cur1'))
      .mockImplementationOnce(page([row('c')], null));
    const devices = await getDevices();
    expect(devices.map((d) => d.id)).toEqual(['a', 'b', 'c']);
    expect(fetchWithTimeout).toHaveBeenCalledTimes(2);
    expect(String(fetchWithTimeout.mock.calls[1][0])).toContain('cursor=cur1');
  });

  it('requests the maximum page size', async () => {
    fetchWithTimeout.mockImplementationOnce(page([], null));
    await getDevices();
    expect(String(fetchWithTimeout.mock.calls[0][0])).toContain('limit=200');
  });

  it('scopes to an org server-side rather than filtering a truncated page', async () => {
    fetchWithTimeout.mockImplementationOnce(page([row('a')], null));
    await getDevices('org-9');
    expect(String(fetchWithTimeout.mock.calls[0][0])).toContain('orgId=org-9');
  });

  it('stops when the cursor does not advance, instead of spinning to the page cap', async () => {
    fetchWithTimeout.mockImplementation(page([row('a')], 'same'));
    const devices = await getDevices();
    // Second response repeats the cursor -> stop.
    expect(fetchWithTimeout.mock.calls.length).toBeLessThanOrEqual(2);
    expect(devices.length).toBeGreaterThan(0);
  });

  it('stops on a null cursor without a second request', async () => {
    fetchWithTimeout.mockImplementationOnce(page([row('a')], null));
    await getDevices();
    expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
  });
});
