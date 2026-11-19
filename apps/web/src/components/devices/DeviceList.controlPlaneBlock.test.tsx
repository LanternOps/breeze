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

  it('an active pill is the warning form with no last-known marker', () => {
    const dev = device('44444444-4444-4444-4444-444444444444', 'filtered', { controlPlaneBlockKind: 'web_filter' });
    render(<DeviceList devices={[dev]} pageSize={50} />);
    const badge = screen.getByTestId(`device-${dev.id}-status-control-plane-block`);
    expect(badge.getAttribute('data-last-known')).toBeNull();
    expect(badge.className).toContain('text-warning');
  });

  it('a device that stopped reporting gets the muted last-known pill with a tooltip', () => {
    const dev = device('55555555-5555-5555-5555-555555555555', 'gone-quiet', {
      status: 'offline',
      controlPlaneBlockKind: 'web_filter',
      controlPlaneBlockLastKnownAt: '2026-10-18T09:05:00.000Z',
    });
    render(<DeviceList devices={[dev]} pageSize={50} />);
    const badge = screen.getByTestId(`device-${dev.id}-status-control-plane-block`);
    expect(badge.textContent).toBe('Network filter');
    expect(badge.getAttribute('data-last-known')).toBe('true');
    expect(badge.className).toContain('text-muted-foreground');
    expect(badge.className).not.toContain('text-warning');
    expect(badge.getAttribute('title')).toMatch(/^Last reported .+; the device has not reported since\.$/);
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

describe('toDeviceListRow — controlPlaneBlockLastKnownAt (#8868 follow-up)', () => {
  const base = { id: 'd1', hostname: 'h', osType: 'linux', status: 'offline', orgId: 'o', siteId: 's' };

  it('carries a string time through', () => {
    expect(
      toDeviceListRow({ ...base, controlPlaneBlockKind: 'web_filter', controlPlaneBlockLastKnownAt: '2026-10-18T09:05:00.000Z' })
        .controlPlaneBlockLastKnownAt,
    ).toBe('2026-10-18T09:05:00.000Z');
  });

  it.each([[undefined], [null], [42], [{ at: 'x' }]])('maps %j to null', (value) => {
    expect(toDeviceListRow({ ...base, controlPlaneBlockLastKnownAt: value }).controlPlaneBlockLastKnownAt).toBeNull();
  });
});
