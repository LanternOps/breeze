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

  it('reports no content when the feed is empty', async () => {
    mockFeed([], []);
    const onHasContentChange = vi.fn();
    render(<DeviceActivityFeed deviceId="dev-1" onHasContentChange={onHasContentChange} />);
    await waitFor(() => expect(onHasContentChange).toHaveBeenLastCalledWith(false));
  });

  it('reports content when there are events', async () => {
    mockFeed([
      {
        id: 'e1',
        action: 'agent.command.script',
        message: 'Script ran',
        result: 'success',
        initiatedBy: null,
        timestamp: new Date().toISOString(),
        actor: { type: 'system', name: 'System' },
      },
    ]);
    const onHasContentChange = vi.fn();
    render(<DeviceActivityFeed deviceId="dev-1" onHasContentChange={onHasContentChange} />);
    await waitFor(() => expect(onHasContentChange).toHaveBeenLastCalledWith(true));
  });

  it('renders a compact one-line empty state in strip layout', async () => {
    mockFeed([], []);
    render(<DeviceActivityFeed deviceId="dev-1" layout="strip" />);
    expect(await screen.findByTestId('activity-empty-strip')).toBeInTheDocument();
  });
});
