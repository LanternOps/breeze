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

const AGENT = device('a1', { hardware: { productSku: '5S3F8EA#ABB' } });
const AGENT_NONE = device('a2');
// The value is deliberately present on the non-agent rows: the dash has to come
// from the device-class gate, not from a missing value.
const MANUAL = device('m1', { deviceClass: 'manual', hardware: { productSku: 'leak' } });
const NETWORK = device('n1', { deviceClass: 'network', hardware: { productSku: 'leak' } });

describe('DeviceList — Product Number column (#9593)', () => {
  beforeEach(() => writeColumnVisibility([...DEFAULT_VISIBLE_COLUMNS, 'productSku']));
  afterEach(() => window.localStorage.clear());

  it('shows the value on agent rows and a dash elsewhere', () => {
    render(<DeviceList devices={[AGENT, AGENT_NONE, MANUAL, NETWORK]} pageSize={50} />);

    expect(screen.getByTestId('device-a1-product-sku').textContent).toBe('5S3F8EA#ABB');
    expect(screen.getByTestId('device-a2-product-sku').textContent).toContain('—');
    expect(screen.getByTestId('device-m1-product-sku').textContent).toContain('—');
    expect(screen.getByTestId('device-n1-product-sku').textContent).toContain('—');
  });

  it('is hidden by default', () => {
    window.localStorage.clear();
    render(<DeviceList devices={[AGENT]} pageSize={50} />);

    expect(screen.queryByTestId('device-a1-product-sku')).toBeNull();
  });

  it('steps aside when only network rows are on screen', () => {
    render(<DeviceList devices={[NETWORK]} pageSize={50} networkDevicesEnabled />);

    expect(screen.queryByTestId('device-n1-product-sku')).toBeNull();
  });
});
