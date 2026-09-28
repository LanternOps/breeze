import { render, screen } from '@testing-library/react';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

import DeviceList, { type Device } from './DeviceList';
import { DEFAULT_VISIBLE_COLUMNS, writeColumnVisibility } from './columnVisibility';

// #7214 (paper cut #23): the agent-health badges (Update stuck, Assist not
// installed, update withheld) previously lived only in the Agent Version /
// Helper Version columns, which are hidden by default — most users never see
// them. They now also render as compact badges in the default-visible
// Status column, matching the existing agent-silent / logs-silent pattern.

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn(), registerOrgIdProvider: vi.fn() }));
vi.mock('@/stores/orgStore', () => ({
  useOrgStore: (selector: (s: { currentOrgId: string | null; allOrgs: boolean }) => unknown) =>
    selector({ currentOrgId: null, allOrgs: true }),
}));
vi.mock('../remote/ConnectDesktopButton', () => ({ default: () => null }));
vi.mock('@/lib/formatTime', () => ({ formatLastSeen: () => 'just now' }));
// DeviceList gates write actions on usePermissions (#7342); grant-all here —
// permission behaviour is covered in DeviceList.permissions.test.tsx.
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
    agentVersion: '0.110.0',
    tags: [],
    ...overrides,
  };
}

// Default columns only — Agent Version / Helper Version stay hidden.
beforeEach(() => writeColumnVisibility([...DEFAULT_VISIBLE_COLUMNS]));
afterEach(() => window.localStorage.clear());

describe('DeviceList — Status column agent-health badges (#7214)', () => {
  it('flags a stuck agent update in the default-visible Status column', () => {
    const dev = device('44444444-4444-4444-4444-444444444444', 'stuck-update', {
      updateAttemptTargetVersion: '0.120.0',
      updateAttemptStartedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
      updateAttemptLastAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    });
    render(<DeviceList devices={[dev]} pageSize={50} />);
    expect(screen.getByTestId(`device-${dev.id}-status-update-stuck`)).toBeTruthy();
  });

  it('flags an update-withheld device in the default-visible Status column', () => {
    const dev = device('55555555-5555-5555-5555-555555555555', 'withheld', {
      updateOfferWithheldReason: 'edition_gate',
    });
    render(<DeviceList devices={[dev]} pageSize={50} />);
    expect(screen.getByTestId(`device-${dev.id}-status-update-withheld`)).toBeTruthy();
  });

  it('flags an Assist-not-installed device in the default-visible Status column', () => {
    const dev = device('66666666-6666-6666-6666-666666666666', 'no-assist', {
      helperInstallIssue: 'awaiting_server_offer',
    });
    render(<DeviceList devices={[dev]} pageSize={50} />);
    expect(screen.getByTestId(`device-${dev.id}-status-helper-install-issue`)).toBeTruthy();
  });

  it('shows no health badges for a healthy device', () => {
    const dev = device('77777777-7777-7777-7777-777777777777', 'healthy');
    render(<DeviceList devices={[dev]} pageSize={50} />);
    expect(screen.queryByTestId(`device-${dev.id}-status-update-stuck`)).toBeNull();
    expect(screen.queryByTestId(`device-${dev.id}-status-update-withheld`)).toBeNull();
    expect(screen.queryByTestId(`device-${dev.id}-status-helper-install-issue`)).toBeNull();
  });
});
