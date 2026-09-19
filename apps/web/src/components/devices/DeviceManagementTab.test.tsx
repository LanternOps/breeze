import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DeviceManagementTab from './DeviceManagementTab';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  registerOrgIdProvider: vi.fn(),
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

const makeJsonResponse = (payload: unknown): Response =>
  ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

const postureResponse = (identity: Record<string, unknown>) => ({
  deviceId: 'dev-1',
  hostname: 'host-1',
  collected: true,
  posture: {
    collectedAt: '2026-09-12T10:00:00.000Z',
    scanDurationMs: 120,
    categories: {},
    identity: {
      joinType: 'none',
      azureAdJoined: false,
      domainJoined: false,
      workplaceJoined: false,
      ...identity,
    },
  },
});

describe('DeviceManagementTab identity card', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not claim "Not Joined" when the platform never checked (#5626)', async () => {
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse(postureResponse({ source: 'unsupported' })),
    );

    render(<DeviceManagementTab deviceId="dev-1" />);

    await waitFor(() => {
      expect(screen.getByTestId('identity-join-type')).toBeTruthy();
    });

    // The headline must not assert a negative result the agent never checked.
    expect(screen.getByTestId('identity-join-type').textContent).not.toContain(
      'Not Joined',
    );
    expect(screen.getByTestId('identity-detection-unsupported')).toBeTruthy();

    // The three join flags are unknown, not false.
    for (const testId of [
      'identity-flag-azureAdJoined',
      'identity-flag-domainJoined',
      'identity-flag-workplaceJoined',
    ]) {
      expect(screen.getByTestId(testId).textContent).toContain('Unknown');
    }
  });

  it('still reports a genuine negative result as "Not Joined"', async () => {
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse(postureResponse({ source: 'dsregcmd' })),
    );

    render(<DeviceManagementTab deviceId="dev-1" />);

    await waitFor(() => {
      expect(screen.getByTestId('identity-join-type')).toBeTruthy();
    });

    expect(screen.getByTestId('identity-join-type').textContent).toContain(
      'Not Joined',
    );
    expect(screen.queryByTestId('identity-detection-unsupported')).toBeNull();
    expect(
      screen.getByTestId('identity-flag-azureAdJoined').textContent,
    ).not.toContain('Unknown');
  });

  it('keeps flags Unknown even if a stray true arrives with an unsupported source', async () => {
    // Defence in depth: the stub reports all-false today, but the source
    // sentinel — not the flag values — is what decides the rendering.
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse(
        postureResponse({ source: 'unsupported', azureAdJoined: true }),
      ),
    );

    render(<DeviceManagementTab deviceId="dev-1" />);

    await waitFor(() => {
      expect(screen.getByTestId('identity-flag-azureAdJoined')).toBeTruthy();
    });

    const flag = screen.getByTestId('identity-flag-azureAdJoined');
    expect(flag.textContent).toContain('Unknown');
    // No confirmed-join styling on a value that was never checked.
    expect(flag.querySelector('.text-emerald-600')).toBeNull();
  });

  it('falls back to the raw join type when the agent reports an unknown one', async () => {
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse(
        postureResponse({ joinType: 'some_future_join', source: 'dsregcmd' }),
      ),
    );

    render(<DeviceManagementTab deviceId="dev-1" />);

    await waitFor(() => {
      expect(screen.getByTestId('identity-join-type')).toBeTruthy();
    });

    const headline = screen.getByTestId('identity-join-type').textContent;
    expect(headline).toContain('some_future_join');
    expect(headline).not.toContain('undefined');
  });

  it('renders a real join result unchanged', async () => {
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse(
        postureResponse({
          joinType: 'azure_ad',
          azureAdJoined: true,
          source: 'dsregcmd',
          tenantId: 'tenant-abc',
        }),
      ),
    );

    render(<DeviceManagementTab deviceId="dev-1" />);

    await waitFor(() => {
      expect(screen.getByTestId('identity-join-type')).toBeTruthy();
    });

    expect(screen.getByTestId('identity-join-type').textContent).toContain(
      'Azure AD',
    );
    expect(screen.queryByTestId('identity-detection-unsupported')).toBeNull();
  });
});
