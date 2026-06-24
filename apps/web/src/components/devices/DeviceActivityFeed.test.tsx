import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DeviceActivityFeed from './DeviceActivityFeed';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
const fetchWithAuthMock = vi.mocked(fetchWithAuth);

const jsonResponse = (payload: unknown, ok = true): Response =>
  ({ ok, status: ok ? 200 : 500, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

// Route the events call vs the alerts call by URL.
function mockFeed(events: unknown[], alerts: unknown[] = []) {
  fetchWithAuthMock.mockImplementation((url: string) =>
    Promise.resolve(
      url.includes('/events')
        ? jsonResponse({ data: events, pagination: { page: 1, limit: 10, total: null } })
        : jsonResponse({ data: alerts })
    )
  );
}

describe('DeviceActivityFeed', () => {
  beforeEach(() => vi.clearAllMocks());

  it('requests automated activity', async () => {
    mockFeed([]);
    render(<DeviceActivityFeed deviceId="dev-1" />);
    await waitFor(() =>
      expect(fetchWithAuthMock).toHaveBeenCalledWith(
        expect.stringContaining('includeAutomated=true'),
        expect.anything()
      )
    );
  });

  it('shows an Automated chip for a system-initiated row with no initiatedBy', async () => {
    mockFeed([
      {
        id: 'e1',
        action: 'agent.command.install_patches',
        message: 'Patches installed — host-1',
        result: 'success',
        initiatedBy: null,
        timestamp: new Date().toISOString(),
        actor: { type: 'system', name: 'System' },
      },
    ]);
    render(<DeviceActivityFeed deviceId="dev-1" />);
    expect(await screen.findByText('Patches installed — host-1')).toBeInTheDocument();
    expect(screen.getByText('Automated')).toBeInTheDocument();
  });
});
