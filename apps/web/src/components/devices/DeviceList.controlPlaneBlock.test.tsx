import { render, screen } from '@testing-library/react';
import { describe, it, expect, afterEach, vi } from 'vitest';

import DeviceList, { type Device } from './DeviceList';
import { toDeviceListRow } from './deviceRowTransform';

// #8868: a device whose agent reports an active control-plane block episode
// (a network filter, captive portal or untrusted TLS interceptor answered
// instead of the server) gets a status pill. The list row carries only the
// closed-enum kind; the network-supplied detail is on the device page.

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

function device(id: string, hostname: string, overrides: Partial<Device> = {}): Device {
  return {
    id,
    deviceClass: 'agent',
    hostname,
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
    agentVersion: '0.130.0',
    tags: [],
    ...overrides,
  };
}

afterEach(() => window.localStorage.clear());

describe('DeviceList — control-plane block badge (#8868)', () => {
  it.each(['web_filter', 'captive_portal', 'plaintext_unknown'])('labels %s "Network filter"', (kind) => {
    const dev = device('11111111-1111-1111-1111-111111111111', 'filtered', { controlPlaneBlockKind: kind });
    render(<DeviceList devices={[dev]} pageSize={50} />);
    const badge = screen.getByTestId(`device-${dev.id}-status-control-plane-block`);
    expect(badge.textContent).toBe('Network filter');
  });

  it('labels an untrusted certificate distinctly', () => {
    const dev = device('22222222-2222-2222-2222-222222222222', 'inspected', {
      controlPlaneBlockKind: 'untrusted_certificate',
    });
    render(<DeviceList devices={[dev]} pageSize={50} />);
    const badge = screen.getByTestId(`device-${dev.id}-status-control-plane-block`);
    expect(badge.textContent).toBe('Certificate not trusted');
  });

  it('shows no badge when the kind is null', () => {
    const dev = device('33333333-3333-3333-3333-333333333333', 'clean', { controlPlaneBlockKind: null });
    render(<DeviceList devices={[dev]} pageSize={50} />);
    expect(screen.queryByTestId(`device-${dev.id}-status-control-plane-block`)).toBeNull();
  });
});

describe('toDeviceListRow — controlPlaneBlockKind (#8868)', () => {
  const base = { id: 'd1', hostname: 'h', osType: 'linux', status: 'online', orgId: 'o', siteId: 's' };

  it('carries a string kind through', () => {
    expect(toDeviceListRow({ ...base, controlPlaneBlockKind: 'web_filter' }).controlPlaneBlockKind).toBe('web_filter');
  });

  it.each([[undefined], [null], [42], [{ kind: 'web_filter' }]])('maps %j to null', (value) => {
    expect(toDeviceListRow({ ...base, controlPlaneBlockKind: value }).controlPlaneBlockKind).toBeNull();
  });
});
