import { beforeEach, describe, expect, it, vi } from 'vitest';

import { listAiSessions } from './aiChat';
import { refreshToken } from './api';
import { storeToken } from './auth';
import { fetchWithTimeout } from './fetchWithTimeout';

vi.mock('./serverConfig', () => ({
  getServerUrl: vi.fn().mockResolvedValue('https://api.test'),
}));

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn().mockResolvedValue('stale-token'),
}));

vi.mock('./fetchWithTimeout', () => ({
  fetchWithTimeout: vi.fn(),
}));

// api.ts pulls in Sentry/installation-id modules that don't exist in the node
// test environment — mock the whole module, we only need refreshToken.
vi.mock('./api', () => ({
  refreshToken: vi.fn(),
}));

vi.mock('./auth', () => ({
  storeToken: vi.fn().mockResolvedValue(undefined),
}));

const fetchMock = vi.mocked(fetchWithTimeout);
const refreshMock = vi.mocked(refreshToken);
const storeTokenMock = vi.mocked(storeToken);

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const sessionsBody = { data: [{ id: 's1', title: 'hi', status: 'active', turnCount: 1, lastActivityAt: null, createdAt: 'now' }] };

beforeEach(() => {
  vi.clearAllMocks();
  storeTokenMock.mockResolvedValue(undefined);
});

describe('authedFetch 401 refresh-and-retry (via listAiSessions)', () => {
  it('does not refresh when the request succeeds', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(sessionsBody));

    const sessions = await listAiSessions();

    expect(sessions).toHaveLength(1);
    expect(refreshMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refreshes on 401, persists the new token, and retries once with it', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: 'Unauthorized' }, 401))
      .mockResolvedValueOnce(jsonResponse(sessionsBody));
    refreshMock.mockResolvedValueOnce({ token: 'fresh-token' });

    const sessions = await listAiSessions();

    expect(sessions).toHaveLength(1);
    expect(refreshMock).toHaveBeenCalledTimes(1);
    expect(storeTokenMock).toHaveBeenCalledWith('fresh-token');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstHeaders = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    const retryHeaders = (fetchMock.mock.calls[1][1] as RequestInit).headers as Record<string, string>;
    expect(firstHeaders.Authorization).toBe('Bearer stale-token');
    expect(retryHeaders.Authorization).toBe('Bearer fresh-token');
  });

  it('surfaces the original 401 when the refresh itself fails', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'Unauthorized' }, 401));
    refreshMock.mockRejectedValueOnce({ message: 'Failed to refresh token' });

    await expect(listAiSessions()).rejects.toThrow('listAiSessions failed: 401');
    expect(fetchMock).toHaveBeenCalledTimes(1); // no retry without a new token
  });

  it('retries only once — a second 401 is returned, not re-refreshed', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: 'Unauthorized' }, 401))
      .mockResolvedValueOnce(jsonResponse({ error: 'Unauthorized' }, 401));
    refreshMock.mockResolvedValueOnce({ token: 'fresh-token' });

    await expect(listAiSessions()).rejects.toThrow('listAiSessions failed: 401');
    expect(refreshMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('still retries with the refreshed token when persisting it fails', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: 'Unauthorized' }, 401))
      .mockResolvedValueOnce(jsonResponse(sessionsBody));
    refreshMock.mockResolvedValueOnce({ token: 'fresh-token' });
    storeTokenMock.mockRejectedValueOnce(new Error('Failed to store authentication token'));

    const sessions = await listAiSessions();

    expect(sessions).toHaveLength(1);
    const retryHeaders = (fetchMock.mock.calls[1][1] as RequestInit).headers as Record<string, string>;
    expect(retryHeaders.Authorization).toBe('Bearer fresh-token');
  });

  it('single-flights concurrent 401s into one refresh call', async () => {
    // Both concurrent requests 401 first, then both retries succeed.
    fetchMock.mockImplementation(async (_url, init) => {
      const headers = (init as RequestInit).headers as Record<string, string>;
      return headers.Authorization === 'Bearer fresh-token'
        ? jsonResponse(sessionsBody)
        : jsonResponse({ error: 'Unauthorized' }, 401);
    });
    let resolveRefresh: (v: { token: string }) => void;
    refreshMock.mockImplementationOnce(
      () => new Promise((resolve) => { resolveRefresh = resolve; }),
    );

    const p1 = listAiSessions();
    const p2 = listAiSessions();
    // Let both initial requests hit the 401 and enter the refresh path.
    await new Promise((r) => setTimeout(r, 0));
    resolveRefresh!({ token: 'fresh-token' });

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toHaveLength(1);
    expect(r2).toHaveLength(1);
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });
});
