import { fireEvent, render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import DeviceList, { type Device } from './DeviceList';

// #7215: the row-menu Wake posts to POST /devices/:id/commands (devices.execute).
const granted = vi.hoisted(() => new Set<string>());
vi.mock('../../lib/permissions', () => ({
  usePermissions: () => ({ permissions: [], can: (r: string, a: string) => granted.has(`${r}:${a}`) }),
  hasPermission: (_p: unknown, r: string, a: string) => granted.has(`${r}:${a}`),
}));
vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn(), registerOrgIdProvider: vi.fn() }));
vi.mock('@/stores/orgStore', () => ({
  useOrgStore: (selector: (s: { currentOrgId: string | null; allOrgs: boolean }) => unknown) =>
    selector({ currentOrgId: null, allOrgs: true }),
}));
vi.mock('../remote/ConnectDesktopButton', () => ({ default: () => null }));
vi.mock('@/lib/formatTime', () => ({ formatLastSeen: () => 'just now' }));

const offline: Device = {
  id: '11111111-1111-1111-1111-111111111111',
  deviceClass: 'agent',
  hostname: 'sleepy-box',
  os: 'linux',
  osVersion: '22.04',
  status: 'offline',
  cpuPercent: 1,
  ramPercent: 1,
  lastSeen: new Date().toISOString(),
  orgId: 'org-1',
  orgName: 'Acme',
  siteId: 'site-1',
  siteName: 'HQ',
  agentVersion: '0.70.0',
  tags: [],
};

describe('DeviceList — Wake is gated on devices:execute (#7215)', () => {
  beforeEach(() => granted.clear());

  it('hides Wake from the row menu without the permission (other items still render)', () => {
    render(<DeviceList devices={[offline]} pageSize={50} />);
    fireEvent.click(screen.getByRole('button', { name: 'Device actions' }));
    expect(screen.getByRole('button', { name: /run script/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^wake$/i })).toBeNull();
  });

  it('shows Wake in the row menu with the permission', () => {
    granted.add('devices:execute');
    render(<DeviceList devices={[offline]} pageSize={50} />);
    fireEvent.click(screen.getByRole('button', { name: 'Device actions' }));
    expect(screen.getByRole('button', { name: /^wake$/i })).toBeTruthy();
  });
});
