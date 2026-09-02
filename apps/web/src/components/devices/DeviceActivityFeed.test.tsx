import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
        // #4225: dispatch-time row — dispatch-tense copy, neutral result.
        message: 'Patch install command sent — host-1',
        result: 'dispatched',
        initiatedBy: null,
        timestamp: new Date().toISOString(),
        actor: { type: 'system', name: 'System' },
      },
    ]);
    render(<DeviceActivityFeed deviceId="dev-1" />);
    expect(await screen.findByText('Patch install command sent — host-1')).toBeInTheDocument();
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
        // #4225: dispatch-time row — dispatch-tense copy, neutral result.
        message: 'Script run command sent',
        result: 'dispatched',
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

  const evt = (id: string) => ({
    id,
    action: 'script.run',
    message: `Script ${id}`,
    result: 'success' as const,
    initiatedBy: null,
    timestamp: new Date().toISOString(),
    actor: { type: 'user', name: 'Ada' },
  });

  it('collapsed: shows a count badge of events plus active alerts', async () => {
    mockFeed([evt('e1'), evt('e2')], [{ id: 'a1', status: 'active' }]);
    render(<DeviceActivityFeed deviceId="dev-1" collapsed onToggleCollapse={() => {}} />);
    const bar = await screen.findByTestId('activity-rail-collapsed');
    // 2 events + 1 active alert = 3 noteworthy items.
    expect(within(bar).getByText('3')).toBeInTheDocument();
  });

  it('collapsed: clicking the bar fires onToggleCollapse to expand', async () => {
    mockFeed([evt('e1')], []);
    const onToggleCollapse = vi.fn();
    render(<DeviceActivityFeed deviceId="dev-1" collapsed onToggleCollapse={onToggleCollapse} />);
    const bar = await screen.findByTestId('activity-rail-collapsed');
    await userEvent.click(bar);
    expect(onToggleCollapse).toHaveBeenCalledTimes(1);
  });

  it('collapsed: shows a "0" count badge and appends the empty-state copy to aria-label when there is nothing to show (#3452)', async () => {
    // Without this, an empty device rendered a bare "Activity" rail —
    // indistinguishable from still-loading.
    mockFeed([], []);
    render(<DeviceActivityFeed deviceId="dev-1" collapsed onToggleCollapse={() => {}} />);
    const bar = await screen.findByTestId('activity-rail-collapsed');

    await waitFor(() => expect(within(bar).getByTestId('activity-rail-count')).toBeInTheDocument());
    expect(within(bar).getByTestId('activity-rail-count')).toHaveTextContent('0');
    expect(bar).toHaveAttribute('aria-label', 'Activity, No recent actions on this device.');
  });

  it('collapsed: does NOT claim "no recent actions" when the load failed', async () => {
    // A failed first load leaves loading=false, itemCount=0 — identical to a
    // genuinely empty device unless `error` is checked. Announcing the empty
    // state there tells the tech something untrue about the endpoint, and the
    // expanded card carrying "Couldn't load / Retry" is lg:hidden while
    // collapsed (DeviceDetails defaults collapsed=true), so the rail is the
    // only thing they see.
    fetchWithAuthMock.mockImplementation(() => Promise.reject(new Error('network')));
    render(<DeviceActivityFeed deviceId="dev-1" collapsed onToggleCollapse={() => {}} />);
    const bar = await screen.findByTestId('activity-rail-collapsed');

    await waitFor(() =>
      expect(bar).toHaveAttribute('aria-label', "Activity, Couldn't load activity.")
    );
    expect(bar.getAttribute('aria-label')).not.toContain('No recent actions');
    // and no misleading muted "0"
    expect(within(bar).queryByTestId('activity-rail-count')).toBeNull();
  });

  it('collapsed: announces the item count when there are events but no active alerts (#3452)', async () => {
    // The badge is aria-hidden and an aria-label suppresses descendant text,
    // so without the count in the label this everyday state announced a bare
    // "Activity" and dropped the number entirely.
    mockFeed([evt('e1'), evt('e2')], []);
    render(<DeviceActivityFeed deviceId="dev-1" collapsed onToggleCollapse={() => {}} />);
    const bar = await screen.findByTestId('activity-rail-collapsed');

    await waitFor(() =>
      expect(bar).toHaveAttribute('aria-label', 'Activity, 2 recent actions'),
    );
  });

  it('collapsed: uses the singular form for a single item (#3452)', async () => {
    mockFeed([evt('e1')], []);
    render(<DeviceActivityFeed deviceId="dev-1" collapsed onToggleCollapse={() => {}} />);
    const bar = await screen.findByTestId('activity-rail-collapsed');

    await waitFor(() => expect(bar).toHaveAttribute('aria-label', 'Activity, 1 recent action'));
  });

  it('expanded: the header chevron fires onToggleCollapse to collapse', async () => {
    mockFeed([evt('e1')], []);
    const onToggleCollapse = vi.fn();
    render(<DeviceActivityFeed deviceId="dev-1" onToggleCollapse={onToggleCollapse} />);
    expect(await screen.findByText('Script e1')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Collapse activity' }));
    expect(onToggleCollapse).toHaveBeenCalledTimes(1);
  });
});
