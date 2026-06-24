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

  it('requests automated activity but never sends agent.command.* as plain action prefixes', async () => {
    mockFeed([]);
    render(<DeviceActivityFeed deviceId="dev-1" />);
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalled());
    const eventsCall = fetchWithAuthMock.mock.calls.find(([url]) => String(url).includes('/events'));
    expect(eventsCall).toBeDefined();
    const url = String(eventsCall![0]);
    expect(url).toContain('includeAutomated=true');
    // agent.command.* rows must arrive only via the actor-scoped includeAutomated
    // predicate, never as plain action prefixes — otherwise the manual
    // (actor_type='user') twins would be re-admitted and double-listed.
    expect(url).not.toContain('agent.command');
  });

  it('shows an Automated chip for an automated row and drops the redundant "System" label', async () => {
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
    // The "Automated" chip conveys the actor; the generic "System" must not also show.
    expect(screen.queryByText('System')).toBeNull();
  });

  it('does NOT tag a non-automated system-actor row as Automated', async () => {
    // A system-actor row whose action is not agent.command.* (e.g. a route audit)
    // must not be mislabeled — the chip is keyed on the action, not actor.type.
    mockFeed([
      {
        id: 'e1',
        action: 'device.maintenance.enable',
        message: 'Maintenance mode enabled',
        result: 'success',
        initiatedBy: null,
        timestamp: new Date().toISOString(),
        actor: { type: 'system', name: 'System' },
      },
    ]);
    render(<DeviceActivityFeed deviceId="dev-1" />);
    expect(await screen.findByText('Maintenance mode enabled')).toBeInTheDocument();
    expect(screen.queryByText('Automated')).toBeNull();
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

  it('reports content when there are no events but active alerts exist', async () => {
    // The pinned active-alerts banner is content too — the rail must not collapse
    // while an alert is showing.
    mockFeed([], [{ id: 'a1', status: 'active' }]);
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
