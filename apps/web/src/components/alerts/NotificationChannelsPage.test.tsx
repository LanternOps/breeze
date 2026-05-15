import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock heavy sub-components that load on module init (NotificationChannelForm
// imports @breeze/shared validators; AlertsTabStrip imports routing hooks).
vi.mock('./NotificationChannelList', () => ({ default: () => null }));
vi.mock('./NotificationChannelForm', () => ({ default: () => null }));
vi.mock('./AlertsTabStrip', () => ({ default: () => null }));
vi.mock('../../stores/orgStore', () => ({
  useOrgStore: vi.fn(() => ({ currentOrgId: 'org-1' })),
}));

// Core mocks
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

vi.mock('../shared/Toast', () => ({
  showToast: vi.fn(),
}));

vi.mock('@/lib/navigation', () => ({
  navigateTo: vi.fn(),
}));

import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';
import { navigateTo } from '@/lib/navigation';
import { runChannelTest } from './NotificationChannelsPage';

const fetchWithAuthMock = vi.mocked(fetchWithAuth);
const showToastMock = vi.mocked(showToast);

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

const CHANNEL = { id: 'ch-abc-123', name: 'My Slack Channel' };

describe('runChannelTest', () => {
  let fetchChannelsMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchChannelsMock = vi.fn().mockResolvedValue(undefined);
  });

  it('shows an ERROR toast with the testResult message when testResult.success is false', async () => {
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse({
        testResult: { success: false, message: 'application token is invalid' },
      })
    );

    await runChannelTest(CHANNEL, {
      fetchChannels: fetchChannelsMock,
      onUnauthorized: () => { void navigateTo('/login', { replace: true }); },
    });

    expect(showToastMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', message: 'application token is invalid' })
    );
    // List must be refetched even on failure so last_tested_at updates
    expect(fetchChannelsMock).toHaveBeenCalledTimes(1);
  });

  it('shows a SUCCESS toast when testResult.success is true', async () => {
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse({
        testResult: { success: true },
      })
    );

    await runChannelTest(CHANNEL, {
      fetchChannels: fetchChannelsMock,
      onUnauthorized: () => { void navigateTo('/login', { replace: true }); },
    });

    expect(showToastMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success' })
    );
    expect(fetchChannelsMock).toHaveBeenCalledTimes(1);
  });

  it('calls onUnauthorized and does not show a toast when the endpoint returns 401', async () => {
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({}, false, 401));

    const onUnauthorized = vi.fn();
    await runChannelTest(CHANNEL, {
      fetchChannels: fetchChannelsMock,
      onUnauthorized,
    });

    expect(onUnauthorized).toHaveBeenCalled();
    expect(showToastMock).not.toHaveBeenCalled();
    // Still refetch after auth redirect attempt
    expect(fetchChannelsMock).toHaveBeenCalledTimes(1);
  });
});
