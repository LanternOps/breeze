import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OEM_UPDATE_MIN_AGENT_VERSION } from '@breeze/shared';
import { fetchWithAuth } from '../../stores/auth';
import { OEM_RUN_QUEUED_EVENT } from './vendorUpdatesApi';

const h = vi.hoisted(() => ({ granted: new Set<string>() }));
vi.mock('../../lib/permissions', () => ({
  usePermissions: () => ({ permissions: [], can: (r: string, a: string) => h.granted.has(`${r}:${a}`) }),
  hasPermission: (_p: unknown, r: string, a: string) => h.granted.has(`${r}:${a}`),
}));

import DeviceActions from './DeviceActions';
import type { Device } from './DeviceList';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: (sel: (s: { tokens: null; user: undefined }) => unknown) => sel({ tokens: null, user: undefined }),
}));
vi.mock('@/lib/moveOrgCapability', () => ({ useCanMoveDeviceOrg: () => false }));
vi.mock('../shared/Toast', async () => {
  const actual = await vi.importActual<typeof import('../shared/Toast')>('../shared/Toast');
  return { ...actual, showToast: vi.fn() };
});

const offlineDevice: Device = {
  id: 'device-1',
  hostname: 'edge-01',
  os: 'windows',
  osVersion: '11',
  status: 'offline',
  cpuPercent: 10,
  ramPercent: 20,
  lastSeen: '2026-06-29T10:00:00.000Z',
  orgId: 'org-1',
  orgName: 'Org One',
  siteId: 'site-1',
  siteName: 'HQ',
  agentVersion: '1.0.0',
  tags: [],
};

beforeEach(() => h.granted.clear());

describe('DeviceActions Wake is permission-gated (#7215)', () => {
  it('hides the header Wake without devices:execute while other actions render', () => {
    render(<DeviceActions device={offlineDevice} />);
    expect(screen.getByRole('button', { name: /run script/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^wake$/i })).toBeNull();
  });

  it('shows the header Wake with devices:execute', () => {
    h.granted.add('devices:execute');
    render(<DeviceActions device={offlineDevice} />);
    expect(screen.getByRole('button', { name: /^wake$/i })).toBeInTheDocument();
  });

  it('hides the compact-menu Wake without devices:execute while the menu opens', async () => {
    render(<DeviceActions device={offlineDevice} compact />);
    await userEvent.click(screen.getByTestId('device-actions-menu'));
    expect(screen.getByRole('menuitem', { name: /^reboot$/i })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /^wake$/i })).toBeNull();
  });

  it('shows the compact-menu Wake with devices:execute', async () => {
    h.granted.add('devices:execute');
    render(<DeviceActions device={offlineDevice} compact />);
    await userEvent.click(screen.getByTestId('device-actions-menu'));
    expect(screen.getByRole('menuitem', { name: /^wake$/i })).toBeInTheDocument();
  });
});

describe('DeviceActions Remote Tools is permission-gated (live device inspection)', () => {
  // Every Remote Tools tab dispatches a live command to the agent, and the API
  // requires devices:execute for all of them — so a devices:read-only role
  // (e.g. the built-in Viewer roles) should not be offered the entry point.
  const onlineDevice: Device = { ...offlineDevice, status: 'online' };

  it('hides the header Remote Tools without devices:execute', () => {
    h.granted.add('devices:read');
    render(<DeviceActions device={onlineDevice} />);
    expect(screen.getByRole('button', { name: /run script/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /remote tools/i })).toBeNull();
  });

  it('shows the header Remote Tools with devices:execute', () => {
    h.granted.add('devices:execute');
    render(<DeviceActions device={onlineDevice} />);
    expect(screen.getByRole('button', { name: /remote tools/i })).toBeInTheDocument();
  });

  it('hides the compact-menu Remote Tools without devices:execute while the menu opens', async () => {
    h.granted.add('devices:read');
    render(<DeviceActions device={onlineDevice} compact />);
    await userEvent.click(screen.getByTestId('device-actions-menu'));
    expect(screen.getByRole('menuitem', { name: /^reboot$/i })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /remote tools/i })).toBeNull();
  });

  it('shows the compact-menu Remote Tools with devices:execute', async () => {
    h.granted.add('devices:execute');
    render(<DeviceActions device={onlineDevice} compact />);
    await userEvent.click(screen.getByTestId('device-actions-menu'));
    expect(screen.getByRole('menuitem', { name: /remote tools/i })).toBeInTheDocument();
  });
});

// #11065 W04: "Run vendor updates" can flash a BIOS. Only for devices:execute, only
// when the status route says a lane could reach this device, so with the feature
// off it shows nowhere. The server's refusals stay the real check.
describe('DeviceActions — Run vendor updates (#11065)', () => {
  const dell: Device = { ...offlineDevice, status: 'online', agentVersion: OEM_UPDATE_MIN_AGENT_VERSION };
  const statusBody = (lane: string | null, bios: 'open' | 'closed' = 'open') => ({
    displayState: 'not_managed',
    lane,
    status: null,
    gates: { bios, firmware: 'closed', driver: 'closed', application: 'closed' },
  });
  const answerStatus = (lane: string | null, bios: 'open' | 'closed' = 'open') =>
    vi.mocked(fetchWithAuth).mockResolvedValue({ ok: true, status: 200, json: async () => statusBody(lane, bios) } as Response);
  const item = () => screen.queryByTestId('device-action-run-vendor-updates');

  beforeEach(() => {
    vi.mocked(fetchWithAuth).mockReset();
    answerStatus('dell');
  });

  const openMore = async () => {
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith('/devices/device-1/oem-updates/status'));
    await userEvent.click(screen.getByTestId('device-actions-menu'));
  };

  it('hidden without devices.execute, and the status is not even asked for', async () => {
    render(<DeviceActions device={dell} compact />);
    await userEvent.click(screen.getByTestId('device-actions-menu'));
    expect(item()).toBeNull();
    expect(fetchWithAuth).not.toHaveBeenCalledWith('/devices/device-1/oem-updates/status');
  });

  it('hidden when status says not_managed and no lane', async () => {
    h.granted.add('devices:execute');
    answerStatus(null);
    render(<DeviceActions device={dell} compact />);
    await openMore();
    expect(item()).toBeNull();
  });

  it('hidden when the status cannot be read', async () => {
    h.granted.add('devices:execute');
    vi.mocked(fetchWithAuth).mockResolvedValue({ ok: false, status: 500, json: async () => ({}) } as Response);
    render(<DeviceActions device={dell} compact />);
    await openMore();
    expect(item()).toBeNull();
  });

  it('never asked for off Windows: v1 is Windows only', async () => {
    h.granted.add('devices:execute');
    render(<DeviceActions device={{ ...dell, os: 'macos' }} compact />);
    await userEvent.click(screen.getByTestId('device-actions-menu'));
    expect(item()).toBeNull();
    expect(fetchWithAuth).not.toHaveBeenCalledWith('/devices/device-1/oem-updates/status');
  });

  it('opens the dialog from the compact menu', async () => {
    h.granted.add('devices:execute');
    render(<DeviceActions device={dell} compact />);
    await openMore();
    const action = await screen.findByTestId('device-action-run-vendor-updates');
    expect(action.getAttribute('aria-disabled')).not.toBe('true');
    await userEvent.click(action);
    expect(await screen.findByTestId('run-vendor-updates-dialog')).toHaveTextContent('edge-01');
  });

  it('is offered in the full menu too', async () => {
    h.granted.add('devices:execute');
    render(<DeviceActions device={dell} />);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalled());
    await userEvent.click(screen.getByLabelText(/more actions/i));
    expect(await screen.findByTestId('device-action-run-vendor-updates')).toBeInTheDocument();
  });

  it('disabled with upgrade hint below minimum agent', async () => {
    h.granted.add('devices:execute');
    render(<DeviceActions device={{ ...dell, agentVersion: '0.126.9' }} compact />);
    await openMore();
    const action = await screen.findByTestId('device-action-run-vendor-updates');
    expect(action.getAttribute('aria-disabled')).toBe('true');
    expect(action.getAttribute('title')).toContain(OEM_UPDATE_MIN_AGENT_VERSION);
    await userEvent.click(action);
    expect(screen.queryByTestId('run-vendor-updates-dialog')).toBeNull();
  });

  it('disabled with the lane-closed reason when every category gate is closed (#11281)', async () => {
    h.granted.add('devices:execute');
    answerStatus('dell', 'closed');
    render(<DeviceActions device={dell} compact />);
    await openMore();
    const action = await screen.findByTestId('device-action-run-vendor-updates');
    expect(action.getAttribute('aria-disabled')).toBe('true');
    expect(action.getAttribute('title')).toBe("Vendor updates are not available yet for this device's manufacturer.");
    await userEvent.click(action);
    expect(screen.queryByTestId('run-vendor-updates-dialog')).toBeNull();
  });

  it('disabled on an unknown agent version: the check fails closed', async () => {
    h.granted.add('devices:execute');
    render(<DeviceActions device={{ ...dell, agentVersion: '' }} compact />);
    await openMore();
    const action = await screen.findByTestId('device-action-run-vendor-updates');
    expect(action.getAttribute('aria-disabled')).toBe('true');
  });

  it("a late answer for the previous device does not offer the action on this one", async () => {
    h.granted.add('devices:execute');
    let releaseFirst: (value: Response) => void = () => undefined;
    vi.mocked(fetchWithAuth).mockImplementation((path: string) => {
      if (path === '/devices/device-1/oem-updates/status') {
        return new Promise<Response>((resolve) => { releaseFirst = resolve; });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => statusBody(null) } as Response);
    });
    const { rerender } = render(<DeviceActions device={dell} compact />);
    rerender(<DeviceActions device={{ ...dell, id: 'device-2' }} compact />);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith('/devices/device-2/oem-updates/status'));

    releaseFirst({ ok: true, status: 200, json: async () => statusBody('dell') } as Response);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await userEvent.click(screen.getByTestId('device-actions-menu'));
    expect(item()).toBeNull();
  });

  it('a device change closes an open dialog: it was for the other device', async () => {
    h.granted.add('devices:execute');
    const { rerender } = render(<DeviceActions device={dell} compact />);
    await openMore();
    await userEvent.click(await screen.findByTestId('device-action-run-vendor-updates'));
    expect(await screen.findByTestId('run-vendor-updates-dialog')).toBeInTheDocument();
    rerender(<DeviceActions device={{ ...dell, id: 'device-2', hostname: 'edge-02' }} compact />);
    // Still closed once the new device's lane has come back.
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith('/devices/device-2/oem-updates/status'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByTestId('run-vendor-updates-dialog')).toBeNull();
  });

  it('a queued run is announced, so the section on the Patches tab reads again', async () => {
    h.granted.add('devices:execute');
    const heard: string[] = [];
    const listener = (event: Event) => heard.push((event as CustomEvent<{ deviceId: string }>).detail.deviceId);
    window.addEventListener(OEM_RUN_QUEUED_EVENT, listener);
    render(<DeviceActions device={dell} compact />);
    await openMore();
    await userEvent.click(await screen.findByTestId('device-action-run-vendor-updates'));
    vi.mocked(fetchWithAuth).mockResolvedValue({
      ok: true,
      status: 202,
      json: async () => ({ commandId: 'c-1', categories: ['driver'], skippedCategories: [] }),
    } as Response);
    await userEvent.click(screen.getByTestId('run-vendor-updates-reboot-when-finished'));
    await userEvent.click(screen.getByTestId('run-vendor-updates-confirm'));
    await waitFor(() => expect(heard).toEqual(['device-1']));
    window.removeEventListener(OEM_RUN_QUEUED_EVENT, listener);
  });

  describe('at phone width', () => {
    const originalMatchMedia = window.matchMedia;
    beforeEach(() => {
      window.matchMedia = ((query: string) => ({
        matches: query.includes('max-width'),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      })) as unknown as typeof window.matchMedia;
      h.granted.add('devices:execute');
    });
    afterEach(() => {
      window.matchMedia = originalMatchMedia;
    });
    const openSheet = async () => {
      await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith('/devices/device-1/oem-updates/status'));
      await userEvent.click(screen.getByTestId('device-actions-sheet-trigger'));
    };

    it('opens the dialog from the sheet', async () => {
      render(<DeviceActions device={dell} />);
      await openSheet();
      await userEvent.click(await screen.findByTestId('device-action-run-vendor-updates'));
      expect(await screen.findByTestId('run-vendor-updates-dialog')).toBeInTheDocument();
    });

    it('not in the sheet with no lane', async () => {
      answerStatus(null);
      render(<DeviceActions device={dell} />);
      await openSheet();
      expect(item()).toBeNull();
    });

    it('disabled in the sheet with the upgrade hint below minimum agent', async () => {
      render(<DeviceActions device={{ ...dell, agentVersion: '0.126.9' }} />);
      await openSheet();
      const action = await screen.findByTestId('device-action-run-vendor-updates');
      expect(action.getAttribute('aria-disabled')).toBe('true');
      expect(action).toHaveTextContent(OEM_UPDATE_MIN_AGENT_VERSION);
      await userEvent.click(action);
      expect(screen.queryByTestId('run-vendor-updates-dialog')).toBeNull();
    });
  });

  it('disabled while offline, with the reason: a run only starts on a device online now', async () => {
    h.granted.add('devices:execute');
    render(<DeviceActions device={{ ...dell, status: 'offline' }} compact />);
    await openMore();
    const action = await screen.findByTestId('device-action-run-vendor-updates');
    expect(action.getAttribute('aria-disabled')).toBe('true');
    await userEvent.click(action);
    expect(screen.queryByTestId('run-vendor-updates-dialog')).toBeNull();
  });
});

// #8729: "Force reboot now" force-closes apps. It sits in the Power menu next to
// Reboot, only for callers with devices:execute, and is disabled (with the
// reason) when the agent predates force_reboot, so nobody starts the MFA step
// for a device that cannot do it. The server's 409 stays the real check.
describe('DeviceActions — Force reboot now (#8729)', () => {
  const onlineDevice: Device = { ...offlineDevice, status: 'online', agentVersion: '0.125.0' };

  it('is not offered without devices:execute', async () => {
    render(<DeviceActions device={onlineDevice} />);
    await userEvent.click(screen.getByTestId('device-power-menu'));
    expect(screen.getByRole('menuitem', { name: /^reboot$/i })).toBeInTheDocument();
    expect(screen.queryByTestId('device-power-action-force-reboot')).toBeNull();
  });

  it('opens the typed-hostname confirmation from the Power menu', async () => {
    h.granted.add('devices:execute');
    render(<DeviceActions device={onlineDevice} />);
    await userEvent.click(screen.getByTestId('device-power-menu'));
    const item = screen.getByTestId('device-power-action-force-reboot');
    expect(item).toHaveTextContent(/force reboot now/i);
    expect(item.getAttribute('aria-disabled')).not.toBe('true');
    await userEvent.click(item);
    expect(await screen.findByTestId('force-reboot-dialog')).toHaveTextContent('edge-01');
  });

  it('is disabled with an "agent upgrade required" reason when the agent is too old', async () => {
    h.granted.add('devices:execute');
    render(<DeviceActions device={{ ...onlineDevice, agentVersion: '0.124.0' }} />);
    await userEvent.click(screen.getByTestId('device-power-menu'));
    const item = screen.getByTestId('device-power-action-force-reboot');
    expect(item.getAttribute('aria-disabled')).toBe('true');
    expect(item.getAttribute('title')).toMatch(/agent upgrade required/i);
    await userEvent.click(item);
    expect(screen.queryByTestId('force-reboot-dialog')).toBeNull();
  });

  it('is offered in the compact menu too', async () => {
    h.granted.add('devices:execute');
    render(<DeviceActions device={onlineDevice} compact />);
    await userEvent.click(screen.getByTestId('device-actions-menu'));
    expect(screen.getByTestId('device-power-action-force-reboot')).toBeInTheDocument();
  });
});
