import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DeviceLinkedProfilesTab from './DeviceLinkedProfilesTab';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  registerOrgIdProvider: vi.fn(),
}));

vi.mock('../../lib/runAction', () => ({
  runAction: vi.fn(async ({ request }: { request: () => Promise<Response> }) => {
    await request();
  }),
  handleActionError: vi.fn(),
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

const jsonResponse = (payload: unknown, ok = true): Response =>
  ({ ok, status: ok ? 200 : 500, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

describe('DeviceLinkedProfilesTab', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows the empty state when the device is unlinked', async () => {
    fetchWithAuthMock.mockResolvedValue(jsonResponse({ group: null, members: [] }));
    render(<DeviceLinkedProfilesTab deviceId="dev-1" />);
    await waitFor(() => expect(screen.getByTestId('linked-profiles-empty')).toBeInTheDocument());
  });

  it('renders linked profiles with agent version and last seen', async () => {
    fetchWithAuthMock.mockResolvedValue(
      jsonResponse({
        group: { id: 'g1', name: 'Todd ThinkPad' },
        members: [
          { deviceId: 'dev-1', hostname: 'tp-win', displayName: null, osType: 'windows', osVersion: '11', agentVersion: '1.2.3', status: 'online', lastSeenAt: '2026-06-01T00:00:00.000Z' },
          { deviceId: 'dev-2', hostname: 'tp-lin', displayName: null, osType: 'linux', osVersion: '22.04', agentVersion: '1.2.4', status: 'offline', lastSeenAt: null },
        ],
      }),
    );
    render(<DeviceLinkedProfilesTab deviceId="dev-1" />);

    await waitFor(() => expect(screen.getByTestId('linked-profiles-tab')).toBeInTheDocument());
    expect(screen.getByTestId('linked-profile-dev-1')).toBeInTheDocument();
    expect(screen.getByTestId('linked-profile-dev-2')).toBeInTheDocument();
    expect(screen.getByText('v1.2.3')).toBeInTheDocument();
  });

  it('shows an access-denied state (no Retry) on a 403', async () => {
    fetchWithAuthMock.mockResolvedValue(
      { ok: false, status: 403, json: vi.fn().mockResolvedValue({}) } as unknown as Response,
    );
    render(<DeviceLinkedProfilesTab deviceId="dev-1" />);
    await waitFor(() => expect(screen.getByTestId('linked-profiles-denied')).toBeInTheDocument());
    expect(screen.queryByText('Retry')).not.toBeInTheDocument();
  });

  it('renders every profile as a normal row when more than one is online (no conflict state — designed out)', async () => {
    fetchWithAuthMock.mockResolvedValue(
      jsonResponse({
        group: { id: 'g1', name: null },
        members: [
          { deviceId: 'dev-1', hostname: 'a', displayName: null, osType: 'windows', osVersion: '11', agentVersion: '1', status: 'online', lastSeenAt: null },
          { deviceId: 'dev-2', hostname: 'b', displayName: null, osType: 'linux', osVersion: '22', agentVersion: '1', status: 'online', lastSeenAt: null },
        ],
      }),
    );
    render(<DeviceLinkedProfilesTab deviceId="dev-1" />);
    await waitFor(() => expect(screen.getByTestId('linked-profiles-tab')).toBeInTheDocument());
    expect(screen.getByTestId('linked-profile-dev-1')).toBeInTheDocument();
    expect(screen.getByTestId('linked-profile-dev-2')).toBeInTheDocument();
    expect(screen.queryByTestId('linked-profiles-conflict')).not.toBeInTheDocument();
  });
});
