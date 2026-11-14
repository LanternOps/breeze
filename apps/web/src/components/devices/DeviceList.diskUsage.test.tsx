import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DeviceList, { type Device } from './DeviceList';
import { DEFAULT_VISIBLE_COLUMNS, writeColumnVisibility } from './columnVisibility';
import { DISK_USAGE_SCOPE_KEY, displayedDisks, diskUsageSortValue, readDiskUsageScope, writeDiskUsageScope, type DeviceDiskUsage } from './diskUsage';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [] }) }), registerOrgIdProvider: vi.fn() }));
vi.mock('../../lib/permissions', () => ({ usePermissions: () => ({ can: () => true }) }));
vi.mock('@/stores/orgStore', () => ({
  useOrgStore: (selector: (s: { currentOrgId: string | null; allOrgs: boolean }) => unknown) =>
    selector({ currentOrgId: null, allOrgs: true }),
}));
vi.mock('../remote/ConnectDesktopButton', () => ({ default: () => null }));
vi.mock('@/lib/formatTime', () => ({ formatLastSeen: () => 'just now' }));

const disk = (mountPoint: string, usedPercent: number, isOsVolume?: boolean): DeviceDiskUsage => ({
  mountPoint, totalGb: 100, usedGb: usedPercent, freeGb: 100 - usedPercent, usedPercent, isOsVolume,
});
const device: Device = {
  id: '11111111-1111-1111-1111-111111111111', hostname: 'workstation', os: 'windows', osVersion: '11',
  status: 'online', cpuPercent: 0, ramPercent: 0, lastSeen: new Date().toISOString(),
  orgId: 'org-1', orgName: 'Acme', siteId: 'site-1', siteName: 'HQ', agentVersion: '1.0', tags: [],
  disks: [disk('C:\\', 40, true), disk('D:\\', 90, false)],
};
const cell = (id = device.id) => screen.getByTestId(`device-${id}-disk-usage`);

describe('DeviceList disk usage', () => {
  beforeEach(() => writeColumnVisibility([...DEFAULT_VISIBLE_COLUMNS, 'diskUsage']));
  afterEach(() => {
    window.localStorage.clear();
    window.history.replaceState(null, '', '/');
  });

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
    const onVisibilityChange = vi.fn();
    render(<DeviceList devices={[device]} onDiskUsageColumnVisibilityChange={onVisibilityChange} />);
    expect(screen.queryByTestId(`device-${device.id}-disk-usage`)).not.toBeInTheDocument();
    expect(onVisibilityChange).toHaveBeenLastCalledWith(false);
    fireEvent.click(screen.getByText('Columns'));
    fireEvent.click(screen.getByTestId('column-chooser-option-diskUsage'));
    expect(cell()).toHaveTextContent('D:\\90%');
    expect(onVisibilityChange).toHaveBeenLastCalledWith(true);
  });

  it('shows a dash for missing disks, missing OS mounts and non-agent assets', () => {
    writeDiskUsageScope('os');
    render(<DeviceList devices={[
      { ...device, disks: [] },
      { ...device, id: 'data-only', disks: [disk('C:\\', 90, false)] },
      { ...device, id: 'legacy', disks: [disk('C:\\', 90)] },
      { ...device, id: 'manual', deviceClass: 'manual' },
      { ...device, id: 'network', deviceClass: 'network' },
    ]} networkDevicesEnabled />);
    for (const id of [device.id, 'data-only', 'legacy', 'manual', 'network']) expect(cell(id)).toHaveTextContent('—');
    expect(within(cell('legacy')).getByTitle('The agent has not identified the system disk yet.')).toBeInTheDocument();
  });

  it('sorts by the highest displayed disk usage and changes ordering with the scope', () => {
    const other = { ...device, id: 'other', disks: [disk('C:\\', 60, true), disk('D:\\', 70, false)] };
    render(<DeviceList devices={[device, other, { ...device, id: 'unknown', disks: [] }]} />);
    const order = () => screen.getAllByTestId(/-disk-usage$/).map((el) => el.getAttribute('data-testid'));
    fireEvent.click(screen.getByTitle('Sort by disk usage (highest displayed usage)'));
    expect(order()).toEqual(['device-other-disk-usage', `device-${device.id}-disk-usage`, 'device-unknown-disk-usage']);
    fireEvent.change(screen.getByTestId('disk-usage-scope'), { target: { value: 'os' } });
    expect(order()).toEqual([`device-${device.id}-disk-usage`, 'device-other-disk-usage', 'device-unknown-disk-usage']);
    fireEvent.click(screen.getByTitle('Sort by disk usage (highest displayed usage)'));
    expect(order()).toEqual(['device-other-disk-usage', `device-${device.id}-disk-usage`, 'device-unknown-disk-usage']);
  });

  it('ignores a hash-carried disk sort while the column is hidden', () => {
    window.localStorage.clear();
    window.history.replaceState(null, '', '/devices#sort=diskUsage.desc');
    const other = { ...device, id: 'other', hostname: 'alpha', disks: [disk('C:\\', 15, true)] };
    render(<DeviceList devices={[device, other]} sortInHash />);
    const [, firstRow] = screen.getAllByRole('row');
    expect(firstRow).toHaveTextContent('alpha');
  });

  it('selects the reported Windows system volume and skips unknown identity', () => {
    const disks = [disk('C:\\', 60, false), disk('D:\\', 90, true)];
    expect(displayedDisks(disks, 'os', 'windows')).toEqual([disks[1]]);
    expect(displayedDisks([disk('C:\\', 90)], 'os', 'windows')).toEqual([]);
  });

  it('selects Linux root and prefers the writable macOS Data volume when available', () => {
    const disks = [disk('/', 30), disk('/System/Volumes/Data', 60), disk('/home', 90)];
    expect(displayedDisks(disks, 'os', 'linux')).toEqual([disks[0]]);
    expect(displayedDisks(disks, 'os', 'macos')).toEqual([disks[1]]);
    expect(displayedDisks([disks[0]!], 'os', 'macos')).toEqual([disks[0]]);
  });

  it('skips malformed inventory and sorts by the displayed percentage', () => {
    const valid = disk('/', 99.96);
    const disks = [
      valid,
      disk('/bad', NaN),
      { ...disk('/missing', 90), mountPoint: null } as unknown as DeviceDiskUsage,
      { ...disk('/empty', 90), totalGb: 0 },
    ];
    expect(displayedDisks(disks, 'all', 'linux')).toEqual([valid]);
    expect(diskUsageSortValue(disks, 'all', 'linux')).toBe(100);
    expect(diskUsageSortValue([disk('/', -10)], 'all', 'linux')).toBe(0);
    window.localStorage.setItem(DISK_USAGE_SCOPE_KEY, 'invalid');
    expect(readDiskUsageScope()).toBe('all');
  });
});
