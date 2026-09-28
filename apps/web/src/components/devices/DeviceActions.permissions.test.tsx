import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
    expect(screen.getByRole('button', { name: /^reboot$/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^wake$/i })).toBeNull();
  });

  it('shows the compact-menu Wake with devices:execute', async () => {
    h.granted.add('devices:execute');
    render(<DeviceActions device={offlineDevice} compact />);
    await userEvent.click(screen.getByTestId('device-actions-menu'));
    expect(screen.getByRole('button', { name: /^wake$/i })).toBeInTheDocument();
  });
});
