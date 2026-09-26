import { render, screen } from '@testing-library/react';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

import DeviceList, { type Device } from './DeviceList';
import { DEFAULT_VISIBLE_COLUMNS, writeColumnVisibility } from './columnVisibility';

// Issue #5285: colour the Devices "Agent Version" column by relation to the
// org's effective agent-version pin/promoted version, resolved once per org
// (the `effectiveAgentVersionByOrgId` map) rather than per row.

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

// The Agent Version column is opt-in (columnVisibility.ts), same as WAN/LAN
// IP — seed it visible before each render.
beforeEach(() => writeColumnVisibility([...DEFAULT_VISIBLE_COLUMNS, 'agentVersion']));
afterEach(() => window.localStorage.clear());

describe('DeviceList — Agent Version column colour coding (#5285)', () => {
  it('tints the version neutral/green when it matches the effective version', () => {
    const dev = device('11111111-1111-1111-1111-111111111111', 'on-pin', { agentVersion: '0.110.0' });
    render(
      <DeviceList
        devices={[dev]}
        pageSize={50}
        effectiveAgentVersionByOrgId={{ 'org-1': '0.110.0' }}
      />,
    );
    const cell = screen.getByTestId(`device-${dev.id}-agent-version`);
    expect(cell.textContent).toContain('0.110.0');
    expect(cell.querySelector('[data-agent-version-relation="equal"]')).not.toBeNull();
  });

  it('tints the version as ahead/canary when newer than the effective version, with a tooltip', () => {
    const dev = device('22222222-2222-2222-2222-222222222222', 'canary', { agentVersion: '0.111.0' });
    render(
      <DeviceList
        devices={[dev]}
        pageSize={50}
        effectiveAgentVersionByOrgId={{ 'org-1': '0.110.0' }}
      />,
    );
    const cell = screen.getByTestId(`device-${dev.id}-agent-version`);
    const badge = cell.querySelector('[data-agent-version-relation="ahead"]');
    expect(badge).not.toBeNull();
    expect(badge?.getAttribute('title')).toContain('0.110.0');
  });

  it('tints the version as behind/amber when older than the effective version, with a tooltip', () => {
    const dev = device('33333333-3333-3333-3333-333333333333', 'stale', { agentVersion: '0.108.0' });
    render(
      <DeviceList
        devices={[dev]}
        pageSize={50}
        effectiveAgentVersionByOrgId={{ 'org-1': '0.110.0' }}
      />,
    );
    const cell = screen.getByTestId(`device-${dev.id}-agent-version`);
    const badge = cell.querySelector('[data-agent-version-relation="behind"]');
    expect(badge).not.toBeNull();
    expect(badge?.getAttribute('title')).toContain('0.110.0');
  });

  it('renders an unchanged plain dash, with no colour, when the org has no effective version yet', () => {
    const dev = device('44444444-4444-4444-4444-444444444444', 'unsynced', { agentVersion: '0.110.0' });
    render(<DeviceList devices={[dev]} pageSize={50} effectiveAgentVersionByOrgId={{}} />);
    const cell = screen.getByTestId(`device-${dev.id}-agent-version`);
    expect(cell.textContent).toContain('0.110.0');
    expect(cell.querySelector('[data-agent-version-relation]')).toBeNull();
  });

  it('renders the plain dash for a network row with no agent version at all', () => {
    const dev = device('55555555-5555-5555-5555-555555555555', 'printer', {
      deviceClass: 'network',
      agentVersion: '' as unknown as string,
    });
    render(
      <DeviceList
        devices={[dev]}
        pageSize={50}
        effectiveAgentVersionByOrgId={{ 'org-1': '0.110.0' }}
      />,
    );
    const cell = screen.getByTestId(`device-${dev.id}-agent-version`);
    expect(cell.textContent).toContain('—');
    expect(cell.querySelector('[data-agent-version-relation]')).toBeNull();
  });
});

describe('DeviceList — update offers withheld badge (#6449)', () => {
  it('flags a withheld device, in the coloured-relation state', () => {
    const dev = device('66666666-6666-6666-6666-666666666666', 'stranded', {
      agentVersion: '0.106.0',
      updateOfferWithheldReason: 'edition_unconfirmed',
    });
    render(<DeviceList devices={[dev]} pageSize={50} effectiveAgentVersionByOrgId={{ 'org-1': '0.110.0' }} />);
    expect(screen.getByTestId(`device-${dev.id}-update-withheld`)).toBeTruthy();
  });

  it('flags a withheld device, in the plain (unknown relation) state', () => {
    const dev = device('77777777-7777-7777-7777-777777777777', 'stranded-plain', {
      updateOfferWithheldReason: 'edition_unconfirmed',
    });
    render(<DeviceList devices={[dev]} pageSize={50} effectiveAgentVersionByOrgId={{}} />);
    expect(screen.getByTestId(`device-${dev.id}-update-withheld`)).toBeTruthy();
  });

  it('shows no badge for a healthy device', () => {
    const dev = device('88888888-8888-8888-8888-888888888888', 'healthy');
    render(<DeviceList devices={[dev]} pageSize={50} effectiveAgentVersionByOrgId={{ 'org-1': '0.110.0' }} />);
    expect(screen.queryByTestId(`device-${dev.id}-update-withheld`)).toBeNull();
  });
});

describe('DeviceList — stuck update badge (#4073)', () => {
  const stuck = () => ({
    updateAttemptTargetVersion: '0.110.0',
    updateAttemptStartedAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
    updateAttemptLastAt: new Date(Date.now() - 60_000).toISOString(),
  });

  it('flags a device whose update has been retrying past the threshold', () => {
    const dev = device('99999999-9999-9999-9999-999999999991', 'wedged', { agentVersion: '0.106.0', ...stuck() });
    render(<DeviceList devices={[dev]} pageSize={50} effectiveAgentVersionByOrgId={{ 'org-1': '0.110.0' }} />);
    expect(screen.getByTestId(`device-${dev.id}-update-stuck`)).toBeTruthy();
  });

  it('flags it in the plain (unknown relation) state too', () => {
    const dev = device('99999999-9999-9999-9999-999999999992', 'wedged-plain', stuck());
    render(<DeviceList devices={[dev]} pageSize={50} effectiveAgentVersionByOrgId={{}} />);
    expect(screen.getByTestId(`device-${dev.id}-update-stuck`)).toBeTruthy();
  });

  it('does not flag an update that only just started', () => {
    const dev = device('99999999-9999-9999-9999-999999999993', 'updating', {
      updateAttemptTargetVersion: '0.110.0',
      updateAttemptStartedAt: new Date(Date.now() - 60_000).toISOString(),
      updateAttemptLastAt: new Date().toISOString(),
    });
    render(<DeviceList devices={[dev]} pageSize={50} effectiveAgentVersionByOrgId={{ 'org-1': '0.110.0' }} />);
    expect(screen.queryByTestId(`device-${dev.id}-update-stuck`)).toBeNull();
  });
});
