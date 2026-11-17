import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import DeviceList, { type Device } from './DeviceList';
import { DEFAULT_VISIBLE_COLUMNS, writeColumnVisibility } from './columnVisibility';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn(), registerOrgIdProvider: vi.fn() }));
vi.mock('@/stores/orgStore', () => ({
  useOrgStore: (selector: (s: { currentOrgId: string | null; allOrgs: boolean }) => unknown) =>
    selector({ currentOrgId: null, allOrgs: true }),
}));
vi.mock('../remote/ConnectDesktopButton', () => ({ default: () => null }));
vi.mock('@/lib/formatTime', () => ({ formatLastSeen: () => 'just now' }));
vi.mock('../../lib/permissions', () => ({
  usePermissions: () => ({ permissions: [], can: () => true }),
  hasPermission: () => true,
}));

function device(id: string, overrides: Partial<Device> = {}): Device {
  return {
    id,
    deviceClass: 'agent',
    hostname: `host-${id}`,
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
    ...overrides,
  };
}

const LONG_SERIAL = 'VMware-42 1f 2e 3d 4c 5b 6a 79-88 97 a6 b5 c4 d3 e2 f1';

describe('DeviceList — Serial cell truncation (#11332)', () => {
  beforeEach(() => writeColumnVisibility([...DEFAULT_VISIBLE_COLUMNS, 'serial']));
  afterEach(() => window.localStorage.clear());

  it('bounds the cell width and truncates a long serial, full value on hover', () => {
    const agent = device('a1', { hardware: { serialNumber: LONG_SERIAL } });
    render(<DeviceList devices={[agent]} pageSize={50} />);

    const cell = screen.getByTestId('device-a1-serial');
    expect(cell.className).toMatch(/max-w-\[/);
    const span = cell.querySelector('span');
    expect(span?.getAttribute('title')).toBe(LONG_SERIAL);
    expect(span?.className).toContain('truncate');
    expect(span?.className).toContain('block');
  });
});

describe('DeviceList — Model column (#11332)', () => {
  beforeEach(() => writeColumnVisibility([...DEFAULT_VISIBLE_COLUMNS, 'hardwareModel']));
  afterEach(() => window.localStorage.clear());

  it('shows the model exactly as reported on agent rows and a dash elsewhere', () => {
    const agent = device('a1', { hardware: { model: 'VMware20,1' } });
    const none = device('a2');
    const manual = device('m1', { deviceClass: 'manual', hardware: { model: 'leak' } });
    const network = device('n1', { deviceClass: 'network', hardware: { model: 'leak' } });
    render(<DeviceList devices={[agent, none, manual, network]} pageSize={50} />);

    expect(screen.getByTestId('device-a1-model').textContent).toBe('VMware20,1');
    expect(screen.getByTestId('device-a2-model').textContent).toContain('—');
    expect(screen.getByTestId('device-m1-model').textContent).toContain('—');
    expect(screen.getByTestId('device-n1-model').textContent).toContain('—');
  });

  it('is hidden by default', () => {
    window.localStorage.clear();
    render(<DeviceList devices={[device('a1', { hardware: { model: 'VMware20,1' } })]} pageSize={50} />);
    expect(screen.queryByTestId('device-a1-model')).toBeNull();
  });

  it('steps aside when only network rows are on screen', () => {
    render(<DeviceList devices={[device('n1', { deviceClass: 'network' })]} pageSize={50} networkDevicesEnabled />);
    expect(screen.queryByTestId('device-n1-model')).toBeNull();
  });
});
