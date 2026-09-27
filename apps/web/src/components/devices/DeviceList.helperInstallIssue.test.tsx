import { render, screen } from '@testing-library/react';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

import DeviceList, { type Device } from './DeviceList';
import { DEFAULT_VISIBLE_COLUMNS, writeColumnVisibility } from './columnVisibility';

// #6925: a device whose Breeze Assist is enabled but not installed (no helper
// offer from the server, or an abandoned install) is flagged in the Helper
// Version column instead of rendering the same dash as "Assist off".

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
    agentVersion: '0.110.0',
    tags: [],
    ...overrides,
  };
}

// The Helper Version column is opt-in (columnVisibility.ts) — seed it visible.
beforeEach(() => writeColumnVisibility([...DEFAULT_VISIBLE_COLUMNS, 'helperVersion']));
afterEach(() => window.localStorage.clear());

describe('DeviceList — Breeze Assist install issue badge (#6925)', () => {
  it('flags a device waiting for a helper offer', () => {
    const dev = device('11111111-1111-1111-1111-111111111111', 'no-offer', {
      helperInstallIssue: 'awaiting_server_offer',
    });
    render(<DeviceList devices={[dev]} pageSize={50} />);
    const badge = screen.getByTestId(`device-${dev.id}-helper-install-issue`);
    expect(badge.textContent).toBe('Not installed');
    expect(badge.getAttribute('title')).toMatch(/no Breeze Assist version/i);
  });

  it('flags an abandoned install with its own tooltip', () => {
    const dev = device('22222222-2222-2222-2222-222222222222', 'abandoned', {
      helperInstallIssue: 'install_abandoned',
    });
    render(<DeviceList devices={[dev]} pageSize={50} />);
    const badge = screen.getByTestId(`device-${dev.id}-helper-install-issue`);
    expect(badge.getAttribute('title')).toMatch(/failed repeatedly/i);
  });

  it('shows no badge for a healthy device', () => {
    const dev = device('33333333-3333-3333-3333-333333333333', 'healthy', { helperVersion: '0.116.0' });
    render(<DeviceList devices={[dev]} pageSize={50} />);
    expect(screen.queryByTestId(`device-${dev.id}-helper-install-issue`)).toBeNull();
    expect(screen.getByTestId(`device-${dev.id}-helper-version`).textContent).toContain('0.116.0');
  });
});
