import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

import DeviceList, { type Device } from './DeviceList';

// Collision-enrollment badge (#2764). Enrollment no longer 409s on a hostname
// collision — it creates a fresh row linked back to the row it may replace.
// Without a fleet-level badge the only way to find those rows is to open every
// device page, so the badge is the discoverable half of the review surface.

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn(), registerOrgIdProvider: vi.fn() }));
vi.mock('@/stores/orgStore', () => ({
  useOrgStore: (selector: (s: { currentOrgId: string | null; allOrgs: boolean }) => unknown) =>
    selector({ currentOrgId: null, allOrgs: true }),
}));
vi.mock('../remote/ConnectDesktopButton', () => ({ default: () => null }));
vi.mock('@/lib/formatTime', () => ({ formatLastSeen: () => 'just now' }));

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
    agentVersion: '0.70.0',
    tags: [],
    ...overrides,
  };
}

const OLD_DEVICE_ID = '99999999-9999-9999-9999-999999999999';

describe('DeviceList — possible-duplicate badge (#2764)', () => {
  // The badge lives in the always-visible Status cell, so this suite never
  // touches column-visibility state and has nothing to reset between cases.

  it('badges a row that may be replacing an earlier device', () => {
    const collider = device('11111111-1111-1111-1111-111111111111', 'WIN-REBUILD-01', {
      possibleReplacementOfDeviceId: OLD_DEVICE_ID,
    });

    render(<DeviceList devices={[collider]} pageSize={50} />);

    expect(screen.getByTestId(`device-${collider.id}-possible-duplicate-badge`)).toBeInTheDocument();
  });

  it('renders no badge for an ordinary row', () => {
    const ordinary = device('22222222-2222-2222-2222-222222222222', 'WIN-NORMAL-01', {
      possibleReplacementOfDeviceId: null,
    });

    render(<DeviceList devices={[ordinary]} pageSize={50} />);

    expect(
      screen.queryByTestId(`device-${ordinary.id}-possible-duplicate-badge`),
    ).toBeNull();
  });

  it('keeps the badge on an offline row', () => {
    // Unlike pending-reboot (suppressed when offline because the flag is stale
    // and unactionable), an offline collider is the LIKELIEST stale record and
    // is exactly what the tech needs to find.
    const offlineCollider = device('33333333-3333-3333-3333-333333333333', 'WIN-OLD-01', {
      status: 'offline',
      possibleReplacementOfDeviceId: OLD_DEVICE_ID,
    });

    render(<DeviceList devices={[offlineCollider]} pageSize={50} />);

    expect(
      screen.getByTestId(`device-${offlineCollider.id}-possible-duplicate-badge`),
    ).toBeInTheDocument();
  });
});
