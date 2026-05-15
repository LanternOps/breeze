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

import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';
import {
  runChannelTest,
  runChannelSave,
  runChannelDelete,
  runRoutingRuleSave,
  runRoutingRuleDelete,
} from './NotificationChannelsPage';

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
const ON_UNAUTHORIZED = vi.fn();

describe('runChannelSave', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows a success toast when the server returns 200', async () => {
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ id: 'ch-new' }));

    await runChannelSave(
      { url: '/alerts/channels', method: 'POST', payload: { name: 'Slack' }, channelName: '', isCreate: true },
      { onUnauthorized: ON_UNAUTHORIZED }
    );

    expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
    expect(ON_UNAUTHORIZED).not.toHaveBeenCalled();
  });

  it('shows an error toast when the server returns a non-401 error', async () => {
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ error: 'name is required' }, false, 422));

    await expect(
      runChannelSave(
        { url: '/alerts/channels', method: 'POST', payload: {}, channelName: '', isCreate: true },
        { onUnauthorized: ON_UNAUTHORIZED }
      )
    ).rejects.toThrow();

    expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
    expect(ON_UNAUTHORIZED).not.toHaveBeenCalled();
  });

  it('calls onUnauthorized and does not show an error toast on 401', async () => {
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({}, false, 401));
    const onUnauthorized = vi.fn();

    await expect(
      runChannelSave(
        { url: '/alerts/channels', method: 'POST', payload: {}, channelName: '', isCreate: true },
        { onUnauthorized }
      )
    ).rejects.toThrow();

    expect(onUnauthorized).toHaveBeenCalledOnce();
    expect(showToastMock).not.toHaveBeenCalled();
  });
});

describe('runChannelDelete', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows a success toast on successful delete', async () => {
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ success: true }));

    await runChannelDelete(CHANNEL, { onUnauthorized: ON_UNAUTHORIZED });

    expect(showToastMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', message: expect.stringContaining(CHANNEL.name) })
    );
  });

  it('shows an error toast when delete fails with a non-401 error', async () => {
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ error: 'in use' }, false, 409));

    await expect(runChannelDelete(CHANNEL, { onUnauthorized: ON_UNAUTHORIZED })).rejects.toThrow();

    expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });
});

describe('runRoutingRuleSave', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const RULE = { name: 'Critical Only', priority: 1, conditions: {}, channelIds: ['ch-1'], enabled: true };

  it('shows a success toast on create (no id)', async () => {
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ id: 'rr-1' }));

    await runRoutingRuleSave(RULE, { onUnauthorized: ON_UNAUTHORIZED });

    expect(showToastMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', message: 'Routing rule created' })
    );
    expect(fetchWithAuthMock).toHaveBeenCalledWith(
      '/alerts/routing-rules',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('uses PATCH and "saved" copy when rule has an id', async () => {
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ id: 'rr-1' }));

    await runRoutingRuleSave({ ...RULE, id: 'rr-1' }, { onUnauthorized: ON_UNAUTHORIZED });

    expect(showToastMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', message: 'Routing rule saved' })
    );
    expect(fetchWithAuthMock).toHaveBeenCalledWith(
      '/alerts/routing-rules/rr-1',
      expect.objectContaining({ method: 'PATCH' })
    );
  });

  it('shows an error toast on failure', async () => {
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ error: 'bad input' }, false, 400));

    await expect(runRoutingRuleSave(RULE, { onUnauthorized: ON_UNAUTHORIZED })).rejects.toThrow();

    expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });
});

describe('runRoutingRuleDelete', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows a success toast on successful delete', async () => {
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ success: true }));

    await runRoutingRuleDelete('rr-1', { onUnauthorized: ON_UNAUTHORIZED });

    expect(showToastMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', message: 'Routing rule deleted' })
    );
  });

  it('calls onUnauthorized and does not show a toast on 401', async () => {
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({}, false, 401));
    const onUnauthorized = vi.fn();

    await expect(runRoutingRuleDelete('rr-1', { onUnauthorized })).rejects.toThrow();

    expect(onUnauthorized).toHaveBeenCalledOnce();
    expect(showToastMock).not.toHaveBeenCalled();
  });
});

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
      onUnauthorized: vi.fn(),
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
      onUnauthorized: vi.fn(),
    });

    expect(showToastMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success' })
    );
    expect(fetchChannelsMock).toHaveBeenCalledTimes(1);
  });

  it('calls onUnauthorized and skips the refetch when the endpoint returns 401', async () => {
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({}, false, 401));

    const onUnauthorized = vi.fn();
    await runChannelTest(CHANNEL, {
      fetchChannels: fetchChannelsMock,
      onUnauthorized,
    });

    expect(onUnauthorized).toHaveBeenCalledOnce();
    expect(showToastMock).not.toHaveBeenCalled();
    // Page is being replaced by login redirect; do NOT refetch from a just-401'd session
    expect(fetchChannelsMock).not.toHaveBeenCalled();
  });
});
