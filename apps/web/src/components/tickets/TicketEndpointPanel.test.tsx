import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import TicketEndpointPanel from './TicketEndpointPanel';
import { fetchWithAuth } from '../../stores/auth';

type Perm = { resource: string; action: string };
const authState = vi.hoisted(() => ({ permissions: [] as Perm[] }));
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: (selector: (s: { user: { permissions: Perm[] } }) => unknown) =>
    selector({ user: { permissions: authState.permissions } }),
}));

// The real button owns the WebRTC/viewer launch; here we only check what the
// panel hands it and when it is offered at all.
const remoteProps = vi.hoisted(() => ({ last: null as null | Record<string, unknown> }));
vi.mock('../remote/ConnectDesktopButton', () => ({
  default: (p: Record<string, unknown>) => {
    remoteProps.last = p;
    return <button type="button" data-testid="connect-desktop-mock">Remote in</button>;
  },
}));

// The device picker self-fetches /devices; the panel only has to mount it.
vi.mock('./TicketDeviceEditor', () => ({
  TicketDeviceEditor: ({ hasDevice }: { hasDevice: boolean }) => (
    <button type="button" data-testid="ticket-workbench-device-edit">{hasDevice ? 'Change device' : 'Link device'}</button>
  ),
}));

const fetchMock = vi.mocked(fetchWithAuth);
const json = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const READ = { resource: 'devices', action: 'read' };
const REMOTE = { resource: 'remote', action: 'access' };

const twoHoursAgo = () => new Date(Date.now() - 2 * 60 * 60_000).toISOString();

function mockDevice(device: Record<string, unknown> | 403, opts: { sessions?: unknown[]; alerts?: unknown[] } = {}) {
  fetchMock.mockImplementation(async (input) => {
    const url = String(input);
    if (url === '/devices/dev-1') return device === 403 ? json({ error: 'forbidden' }, false, 403) : json(device);
    if (url === '/devices/dev-1/sessions/active') return json({ data: { activeUsers: opts.sessions ?? [] } });
    if (url === '/devices/dev-1/alerts?status=active&limit=3') return json({ data: opts.alerts ?? [] });
    return json({ error: 'unexpected' }, false, 404);
  });
}

const ONLINE = {
  id: 'dev-1',
  hostname: 'e2e-windows.local',
  displayName: null,
  status: 'online',
  osType: 'windows',
  osVersion: 'Windows 11 Pro',
  lastSeenAt: new Date().toISOString(),
  lastUser: 'ACME\\jdoe',
  uptimeSeconds: 3 * 86400 + 4 * 3600,
  pendingReboot: true,
  desktopAccess: { mode: 'available' },
  isHeadless: false,
  remoteAccessPolicy: { webrtcDesktop: true },
  helperLifecycleMode: 'always-on',
};

const baseProps = {
  deviceId: 'dev-1' as string | null,
  deviceHostname: 'e2e-windows.local' as string | null,
  orgId: 'org-1',
  hasAssignee: false,
  readOnly: false,
  onLinkDevice: vi.fn(),
  onUnlinkDevice: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  remoteProps.last = null;
  authState.permissions = [READ, REMOTE];
});

describe('TicketEndpointPanel', () => {
  it('online: live state, the logged-in user, active alerts with severity, pending reboot and Remote in', async () => {
    mockDevice(ONLINE, {
      sessions: [{ id: 's-1', username: 'jdoe', sessionType: 'console', osSessionId: '1', loginAt: null, idleMinutes: 0, activityState: 'active', lastActivityAt: null, updatedAt: null }],
      alerts: [
        { id: 'al-1', title: 'Disk C: below 5%', severity: 'critical' },
        { id: 'al-2', title: 'CPU pegged', severity: 'high' },
      ],
    });
    render(<TicketEndpointPanel {...baseProps} />);

    expect(await screen.findByTestId('ticket-endpoint-status')).toHaveTextContent('Online');
    const host = screen.getByTestId('ticket-workbench-device-link');
    // The name gets its own line and wraps (2 lines) instead of an ellipsis
    // beside Remote in, which sits on the status line.
    expect(host.className).toContain('line-clamp-2');
    expect(host.className).not.toContain('truncate');
    expect(screen.getByTestId('connect-desktop-mock').closest('[data-testid="ticket-endpoint-status-row"]')).not.toBeNull();
    expect(host).toHaveAttribute('href', '/devices/dev-1');
    expect(host).toHaveTextContent('e2e-windows.local');
    expect(screen.getByTestId('ticket-endpoint-os')).toHaveTextContent('Windows 11 Pro');
    await waitFor(() => expect(screen.getByTestId('ticket-endpoint-user')).toHaveTextContent('jdoe'));
    expect(screen.getByTestId('ticket-endpoint-user')).toHaveTextContent('Active');
    expect(screen.getByTestId('ticket-endpoint-reboot')).toHaveTextContent('Reboot pending');
    const alerts = await screen.findByTestId('ticket-endpoint-alerts');
    expect(screen.getByTestId('ticket-endpoint-alert-al-1')).toHaveTextContent('Disk C: below 5%');
    expect(screen.getByTestId('ticket-endpoint-alert-al-1')).toHaveTextContent('Critical');
    expect(screen.getByTestId('ticket-endpoint-alert-al-2')).toHaveTextContent('High');
    expect(alerts.querySelector('a')).toHaveAttribute('href', '/alerts#al-1');
    expect(screen.getByTestId('connect-desktop-mock')).toBeInTheDocument();
    expect(remoteProps.last).toMatchObject({
      deviceId: 'dev-1',
      desktopAccess: { mode: 'available' },
      remoteAccessPolicy: { webrtcDesktop: true },
      isHeadless: false,
      helperLifecycleMode: 'always-on',
    });
  });

  it('online with no one signed in and no alerts says so quietly', async () => {
    mockDevice({ ...ONLINE, pendingReboot: false });
    render(<TicketEndpointPanel {...baseProps} />);
    await waitFor(() => expect(screen.getByTestId('ticket-endpoint-user')).toHaveTextContent('No one signed in'));
    expect(await screen.findByTestId('ticket-endpoint-no-alerts')).toBeInTheDocument();
    expect(screen.queryByTestId('ticket-endpoint-reboot')).toBeNull();
  });

  it('offline: "Offline · last seen …" and no Remote in', async () => {
    mockDevice({ ...ONLINE, status: 'offline', lastSeenAt: twoHoursAgo() });
    render(<TicketEndpointPanel {...baseProps} />);
    const status = await screen.findByTestId('ticket-endpoint-status');
    expect(status).toHaveTextContent('Offline');
    expect(status).toHaveTextContent(/last seen 2 hours ago/i);
    expect(screen.queryByTestId('connect-desktop-mock')).toBeNull();
  });

  it('hides Remote in without remote access, and keeps the live state', async () => {
    authState.permissions = [READ];
    mockDevice(ONLINE);
    render(<TicketEndpointPanel {...baseProps} />);
    expect(await screen.findByTestId('ticket-endpoint-status')).toHaveTextContent('Online');
    expect(screen.queryByTestId('connect-desktop-mock')).toBeNull();
  });

  it('403 on the device: hostname only, no live state and no follow-up reads', async () => {
    mockDevice(403);
    render(<TicketEndpointPanel {...baseProps} />);
    await waitFor(() => expect(screen.queryByTestId('ticket-endpoint-loading')).toBeNull());
    expect(screen.getByTestId('ticket-workbench-device-link')).toHaveTextContent('e2e-windows.local');
    expect(screen.queryByTestId('ticket-endpoint-status')).toBeNull();
    expect(screen.queryByTestId('connect-desktop-mock')).toBeNull();
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes('/sessions/active'))).toBe(false);
    expect(urls.some((u) => u.includes('/alerts'))).toBe(false);
  });

  it('without devices:read: hostname only and no device reads at all', async () => {
    authState.permissions = [];
    mockDevice(ONLINE);
    render(<TicketEndpointPanel {...baseProps} />);
    expect(screen.getByTestId('ticket-workbench-device-link')).toHaveTextContent('e2e-windows.local');
    expect(screen.queryByTestId('ticket-endpoint-loading')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('no device: a quiet "No device linked" with the link action', () => {
    mockDevice(ONLINE);
    render(<TicketEndpointPanel {...baseProps} deviceId={null} deviceHostname={null} />);
    expect(screen.getByTestId('ticket-endpoint-none')).toHaveTextContent('No device linked');
    expect(screen.getByTestId('ticket-workbench-device-edit')).toHaveTextContent('Link device');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows a compact skeleton while the device loads', async () => {
    let release: (r: Response) => void = () => {};
    fetchMock.mockImplementation((input) => {
      if (String(input) === '/devices/dev-1') return new Promise<Response>((resolve) => { release = resolve; });
      return Promise.resolve(json({ data: [] }));
    });
    render(<TicketEndpointPanel {...baseProps} />);
    expect(screen.getByTestId('ticket-endpoint-loading')).toBeInTheDocument();
    release(json(ONLINE));
    await screen.findByTestId('ticket-endpoint-status');
    expect(screen.queryByTestId('ticket-endpoint-loading')).toBeNull();
  });

  it('read-only (merged) hides the link editor', async () => {
    mockDevice(ONLINE);
    render(<TicketEndpointPanel {...baseProps} readOnly />);
    await screen.findByTestId('ticket-endpoint-status');
    expect(screen.queryByTestId('ticket-workbench-device-edit')).toBeNull();
  });
});
