import { render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import DeviceList, { type Device } from './DeviceList';
import { DEFAULT_VISIBLE_COLUMNS, writeColumnVisibility } from './columnVisibility';
vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn(), registerOrgIdProvider: vi.fn() }));
vi.mock('@/stores/orgStore', () => ({
  useOrgStore: (selector: (s: { currentOrgId: string | null; allOrgs: boolean }) => unknown) =>
    selector({ currentOrgId: null, allOrgs: true }),
}));
vi.mock('../remote/ConnectDesktopButton', () => ({ default: () => null }));
const device: Device = {
  id: '11111111-1111-4111-8111-111111111111', deviceClass: 'agent', hostname: 'raid-host',
  os: 'linux', osVersion: '22.04', status: 'online', cpuPercent: 0, ramPercent: 0,
  lastSeen: '2026-09-23T12:00:00Z', orgId: '33333333-3333-4333-8333-333333333333', orgName: 'Acme',
  siteId: '44444444-4444-4444-8444-444444444444', siteName: 'HQ', agentVersion: '0.117.0', tags: [],
  hardwareHealth: 'critical', hardwareHealthSummary: { 'physical_disk.critical': 2 },
};
afterEach(() => window.localStorage.clear());
it('keeps the column hidden by default', () => {
  window.localStorage.clear();
  render(<DeviceList devices={[device]} />);
  expect(screen.queryByTestId(`device-${device.id}-hardware-health`)).toBeNull();
});
it.each(['ok', 'warning', 'critical', 'unknown'] as const)('shows %s with numeric summary tooltip', health => {
  writeColumnVisibility([...DEFAULT_VISIBLE_COLUMNS, 'hardwareHealth']);
  render(<DeviceList devices={[{ ...device, hardwareHealth: health }]} />);
  const cell = screen.getByTestId(`device-${device.id}-hardware-health`);
  expect(within(cell).getByTestId('hardware-state-pill')).toHaveAttribute('title', 'physical_disk.critical: 2');
});
it('renders a dash for a missing rollup', () => {
  writeColumnVisibility([...DEFAULT_VISIBLE_COLUMNS, 'hardwareHealth']);
  render(<DeviceList devices={[{ ...device, hardwareHealth: null }]} />);
  expect(screen.getByTestId(`device-${device.id}-hardware-health`)).toHaveTextContent('—');
});
