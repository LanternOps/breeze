import '@/lib/i18n';

import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DeviceList, { type Device } from './DeviceList';

/**
 * Bulk "Add to group" / "Remove from group" on /devices (#9866): offered with devices:write
 * (POST /device-groups/:id/devices and its bulk-remove sibling both require it), disabled with a
 * visible reason for a selection that spans organizations.
 */
const granted = vi.hoisted(() => new Set<string>(['devices:write']));
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

let seq = 0;
const agent = (orgId = 'org-1', over: Partial<Device> = {}): Device => {
  seq += 1;
  const n = String(seq).padStart(12, '0');
  return {
    id: `11111111-1111-4111-8111-${n}`, deviceClass: 'agent', hostname: `host-${seq}`, os: 'windows', osVersion: '11',
    status: 'online', cpuPercent: 1, ramPercent: 1, lastSeen: new Date().toISOString(), orgId, orgName: orgId,
    siteId: 'site-1', siteName: 'HQ', agentVersion: '1.0.0', tags: [], ...over,
  };
};

const openBulk = () => {
  fireEvent.click(screen.getByLabelText('Select all devices on this page'));
  fireEvent.click(screen.getByRole('button', { name: /bulk actions/i }));
};

beforeEach(() => {
  granted.clear();
  granted.add('devices:write');
});

describe('DeviceList — bulk group membership', () => {
  it.each([
    ['devices-bulk-add-to-group', 'add-to-group'],
    ['devices-bulk-remove-from-group', 'remove-from-group'],
  ])('%s is enabled for a one-org selection and dispatches %s', (testId, action) => {
    const onBulkAction = vi.fn();
    const devices = [agent('org-1'), agent('org-1', { siteId: 'site-2', siteName: 'Lab' })];
    render(<DeviceList devices={devices} pageSize={50} onBulkAction={onBulkAction} />);
    openBulk();
    const item = screen.getByTestId(testId);
    expect(item).not.toBeDisabled();
    expect(screen.queryByTestId('devices-bulk-group-disabled-reason')).toBeNull();
    fireEvent.click(item);
    expect(onBulkAction).toHaveBeenCalledWith(action, expect.arrayContaining(devices));
  });

  it('both items are disabled with the mixed-org reason when the agents span two orgs', () => {
    render(<DeviceList devices={[agent('org-1'), agent('org-2')]} pageSize={50} onBulkAction={vi.fn()} />);
    openBulk();
    const reason = screen.getByTestId('devices-bulk-group-disabled-reason');
    expect(reason).toHaveTextContent('Selected devices belong to more than one organization');
    for (const id of ['devices-bulk-add-to-group', 'devices-bulk-remove-from-group']) {
      const item = screen.getByTestId(id);
      expect(item).toBeDisabled();
      expect(item.getAttribute('aria-describedby')).toBe(reason.id);
    }
  });

  it('is disabled with the agent-only reason when only network rows are selected', () => {
    render(
      <DeviceList devices={[agent('org-1', { deviceClass: 'network', hostname: 'sw' })]} pageSize={50} onBulkAction={vi.fn()} />,
    );
    openBulk();
    expect(screen.getByTestId('devices-bulk-add-to-group')).toBeDisabled();
    expect(screen.getByTestId('devices-bulk-group-disabled-reason')).toBeInTheDocument();
  });

  it('is hidden without devices:write', () => {
    granted.clear();
    render(<DeviceList devices={[agent()]} pageSize={50} onBulkAction={vi.fn()} />);
    openBulk();
    const menu = within(screen.getByTestId('bulk-actions-menu'));
    expect(menu.queryByTestId('devices-bulk-add-to-group')).toBeNull();
    expect(menu.queryByTestId('devices-bulk-remove-from-group')).toBeNull();
  });
});
