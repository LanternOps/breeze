import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DeviceList, { type Device } from './DeviceList';
import { DEFAULT_VISIBLE_COLUMNS, writeColumnVisibility } from './columnVisibility';
import { DISK_USAGE_SCOPE_KEY, displayedDisks, readDiskUsageScope, writeDiskUsageScope } from './diskUsage';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [] }) }), registerOrgIdProvider: vi.fn() }));
vi.mock('../../lib/permissions', () => ({ usePermissions: () => ({ can: () => true }) }));
vi.mock('@/stores/orgStore', () => ({
  useOrgStore: (selector: (s: { currentOrgId: string | null; allOrgs: boolean }) => unknown) =>
    selector({ currentOrgId: null, allOrgs: true }),
}));
vi.mock('../remote/ConnectDesktopButton', () => ({ default: () => null }));
vi.mock('@/lib/formatTime', () => ({ formatLastSeen: () => 'just now' }));

const disk = (mountPoint: string, usedPercent: number) => ({ mountPoint, totalGb: 100, usedGb: usedPercent, freeGb: 100 - usedPercent, usedPercent });
const device: Device = {
  id: '11111111-1111-1111-1111-111111111111', hostname: 'workstation', os: 'windows', osVersion: '11',
  status: 'online', cpuPercent: 0, ramPercent: 0, lastSeen: new Date().toISOString(),
  orgId: 'org-1', orgName: 'Acme', siteId: 'site-1', siteName: 'HQ', agentVersion: '1.0', tags: [],
  disks: [disk('C:\\', 40), disk('D:\\', 90)],
};
const cell = (id = device.id) => screen.getByTestId(`device-${id}-disk-usage`);

describe('DeviceList disk usage', () => {
  beforeEach(() => writeColumnVisibility([...DEFAULT_VISIBLE_COLUMNS, 'diskUsage']));
  afterEach(() => window.localStorage.clear());

  it('shows each disk with usage and capacity, including cached offline inventory', () => {
    render(<DeviceList devices={[{ ...device, status: 'offline' }]} />);
    expect(cell()).toHaveTextContent('C:\\40%');
    expect(cell()).toHaveTextContent('D:\\90%');
    expect(screen.getByTitle('C:\\: 40 / 100 GB')).toBeInTheDocument();
  });

  it('switches to OS only and restores the saved selection after remount', () => {
    const { unmount } = render(<DeviceList devices={[device]} />);
    fireEvent.change(screen.getByTestId('disk-usage-scope'), { target: { value: 'os' } });
    expect(cell()).toHaveTextContent('C:\\40%');
    expect(cell()).not.toHaveTextContent('D:\\');
    expect(window.localStorage.getItem(DISK_USAGE_SCOPE_KEY)).toBe('os');
    unmount();
    render(<DeviceList devices={[device]} />);
    expect(screen.getByTestId('disk-usage-scope')).toHaveValue('os');
    expect(cell()).not.toHaveTextContent('D:\\');
    fireEvent.change(screen.getByTestId('disk-usage-scope'), { target: { value: 'all' } });
    expect(cell()).toHaveTextContent('D:\\90%');
  });

  it('is opt-in and can be enabled from the column picker', () => {
    window.localStorage.clear();
    render(<DeviceList devices={[device]} />);
    expect(screen.queryByTestId(`device-${device.id}-disk-usage`)).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Columns'));
    fireEvent.click(screen.getByTestId('column-chooser-option-diskUsage'));
    expect(cell()).toHaveTextContent('D:\\90%');
  });

  it('shows a dash for missing disks, missing OS mounts and non-agent assets', () => {
    writeDiskUsageScope('os');
    render(<DeviceList devices={[
      { ...device, disks: [] },
      { ...device, id: 'data-only', disks: [disk('D:\\', 90)] },
      { ...device, id: 'manual', deviceClass: 'manual' },
      { ...device, id: 'network', deviceClass: 'network' },
    ]} networkDevicesEnabled />);
    for (const id of [device.id, 'data-only', 'manual', 'network']) expect(cell(id)).toHaveTextContent('—');
  });

  it('sorts by the highest displayed disk usage and changes ordering with the scope', () => {
    const other = { ...device, id: 'other', disks: [disk('C:\\', 60), disk('D:\\', 70)] };
    render(<DeviceList devices={[device, other, { ...device, id: 'unknown', disks: [] }]} />);
    const order = () => screen.getAllByTestId(/-disk-usage$/).map((el) => el.getAttribute('data-testid'));
    fireEvent.click(screen.getByTitle('Sort by disk usage (highest displayed usage)'));
    expect(order()).toEqual(['device-other-disk-usage', `device-${device.id}-disk-usage`, 'device-unknown-disk-usage']);
    fireEvent.change(screen.getByTestId('disk-usage-scope'), { target: { value: 'os' } });
    expect(order()).toEqual([`device-${device.id}-disk-usage`, 'device-other-disk-usage', 'device-unknown-disk-usage']);
    fireEvent.click(screen.getByTitle('Sort by disk usage (highest displayed usage)'));
    expect(order()).toEqual(['device-other-disk-usage', `device-${device.id}-disk-usage`, 'device-unknown-disk-usage']);
  });

  it('recognizes root and Windows mount variants, without guessing other volumes', () => {
    const disks = ['/', '/home', 'C:', 'c:\\', 'C:/', 'D:\\'].map((mount) => disk(mount, 50));
    expect(displayedDisks(disks, 'os').map((d) => d.mountPoint)).toEqual(['/', 'C:', 'c:\\', 'C:/']);
    expect(displayedDisks([disk('/', NaN), { ...disk('D:', 50), totalGb: 0 }], 'all')).toEqual([]);
    window.localStorage.setItem(DISK_USAGE_SCOPE_KEY, 'invalid');
    expect(readDiskUsageScope()).toBe('all');
  });
});
