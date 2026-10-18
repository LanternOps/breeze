import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import DeviceList, { type Device } from './DeviceList';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn(), registerOrgIdProvider: vi.fn() }));
vi.mock('@/stores/orgStore', () => ({
  useOrgStore: (selector: (s: { currentOrgId: string | null; allOrgs: boolean }) => unknown) =>
    selector({ currentOrgId: null, allOrgs: true }),
}));
vi.mock('@/lib/permissions', () => ({
  usePermissions: () => ({ permissions: [], can: () => true }),
}));
vi.mock('../remote/ConnectDesktopButton', () => ({ default: () => null }));
vi.mock('@/lib/formatTime', () => ({ formatLastSeen: () => 'just now' }));

const base: Device = {
  id: '11111111-1111-1111-1111-111111111111',
  deviceClass: 'agent',
  hostname: 'round-box',
  os: 'linux',
  osVersion: '22.04',
  status: 'online',
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

describe('DeviceList metric rounding', () => {
  afterEach(() => window.localStorage.clear());

  it('rounds a raw float percent to one decimal in the CPU and RAM cells', () => {
    render(<DeviceList devices={[{ ...base, cpuPercent: 37.456789012, ramPercent: 61.04 }]} pageSize={50} />);

    expect(screen.getByText('37.5%')).toBeTruthy();
    expect(screen.getByText('61%')).toBeTruthy();
    expect(screen.queryByText('37.456789012%')).toBeNull();
  });
});
