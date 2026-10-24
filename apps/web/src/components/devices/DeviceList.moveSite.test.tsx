import '@/lib/i18n';

import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DeviceList, { type Device } from './DeviceList';
import { BULK_SITE_MOVE_CAP } from './bulkActionGating';

/**
 * "Move to site" on /devices (#9796, spec §4.4 + §9.3): the agent row action
 * `device-row-move-site` and the bulk item `devices-bulk-move-site`, disabled with a visible
 * reason (`devices-bulk-move-site-disabled-reason`) for a mixed-org or over-cap selection.
 * Gated on devices:write (PATCH /devices/:id and POST /devices/bulk/site both require it).
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

describe('DeviceList — row action "Move to site"', () => {
  it('an agent row offers device-row-move-site, which dispatches move-site with that device', () => {
    const device = agent();
    const onAction = vi.fn();
    render(<DeviceList devices={[device]} pageSize={50} onAction={onAction} />);
    fireEvent.click(screen.getByRole('button', { name: 'Device actions' }));
    fireEvent.click(screen.getByTestId('device-row-move-site'));
    expect(onAction).toHaveBeenCalledWith('move-site', device);
  });

  it('is hidden without devices:write', () => {
    granted.clear();
    render(<DeviceList devices={[agent()]} pageSize={50} />);
    fireEvent.click(screen.getByRole('button', { name: 'Device actions' }));
    expect(screen.queryByTestId('device-row-move-site')).toBeNull();
  });

  it('is never offered on a network or manual row', () => {
    const network = agent('org-1', { deviceClass: 'network', hostname: 'switch-1' });
    const manual = agent('org-1', { deviceClass: 'manual', hostname: 'printer-1', status: 'unknown' });
    const onAction = vi.fn();
    render(<DeviceList devices={[agent(), network, manual]} pageSize={50} onAction={onAction} />);
    // Open every row menu there is and collect what Move-to-site dispatches: only the agent.
    for (const button of screen.queryAllByRole('button', { name: 'Device actions' })) {
      fireEvent.click(button);
      const item = screen.queryByTestId('device-row-move-site');
      if (item) fireEvent.click(item);
      else fireEvent.keyDown(document, { key: 'Escape' });
    }
    expect(onAction.mock.calls.filter(([a]) => a === 'move-site').map(([, d]) => d.deviceClass)).toEqual(['agent']);
  });
});

describe('DeviceList — bulk "Move to site"', () => {
  it('is enabled when every selected agent shares one org, and dispatches move-site', () => {
    const onBulkAction = vi.fn();
    const devices = [agent('org-1'), agent('org-1', { siteId: 'site-2', siteName: 'Lab' })];
    render(<DeviceList devices={devices} pageSize={50} onBulkAction={onBulkAction} />);
    openBulk();
    const item = screen.getByTestId('devices-bulk-move-site');
    expect(item).not.toBeDisabled();
    expect(screen.queryByTestId('devices-bulk-move-site-disabled-reason')).toBeNull();
    fireEvent.click(item);
    expect(onBulkAction).toHaveBeenCalledWith('move-site', expect.arrayContaining(devices));
  });

  it('is disabled with the mixed-org reason when the selected agents span two orgs', () => {
    render(<DeviceList devices={[agent('org-1'), agent('org-2')]} pageSize={50} onBulkAction={vi.fn()} />);
    openBulk();
    const item = screen.getByTestId('devices-bulk-move-site');
    expect(item).toBeDisabled();
    const reason = screen.getByTestId('devices-bulk-move-site-disabled-reason');
    expect(reason).toHaveTextContent('Selected devices belong to more than one organization');
    expect(item.getAttribute('aria-describedby')).toBe(reason.id);
  });

  it('ignores a non-agent row in another org (only agents move)', () => {
    render(<DeviceList devices={[agent('org-1'), agent('org-2', { deviceClass: 'network', hostname: 'sw' })]} pageSize={50} onBulkAction={vi.fn()} />);
    openBulk();
    expect(screen.getByTestId('devices-bulk-move-site')).not.toBeDisabled();
  });

  it(`is disabled with the cap reason above ${BULK_SITE_MOVE_CAP} agents — never chunked`, () => {
    const devices = Array.from({ length: BULK_SITE_MOVE_CAP + 1 }, () => agent('org-1'));
    render(<DeviceList devices={devices} pageSize={200} onBulkAction={vi.fn()} />);
    openBulk();
    expect(screen.getByTestId('devices-bulk-move-site')).toBeDisabled();
    expect(screen.getByTestId('devices-bulk-move-site-disabled-reason'))
      .toHaveTextContent(`Select at most ${BULK_SITE_MOVE_CAP} devices to move at once`);
  });

  it('is hidden without devices:write', () => {
    granted.clear();
    render(<DeviceList devices={[agent()]} pageSize={50} onBulkAction={vi.fn()} />);
    openBulk();
    expect(within(screen.getByTestId('bulk-actions-menu')).queryByTestId('devices-bulk-move-site')).toBeNull();
  });
});
