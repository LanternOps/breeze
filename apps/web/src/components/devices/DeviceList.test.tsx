import { fireEvent, render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

import DeviceList, { type Device } from './DeviceList';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));
vi.mock('../remote/ConnectDesktopButton', () => ({
  default: () => null,
}));
vi.mock('@/lib/formatTime', () => ({
  formatLastSeen: () => 'just now',
}));

const baseDevice: Device = {
  id: '11111111-1111-1111-1111-111111111111',
  hostname: 'host-a',
  os: 'windows',
  osVersion: '11',
  status: 'online',
  cpuPercent: 10,
  ramPercent: 20,
  lastSeen: new Date().toISOString(),
  orgId: 'org-1',
  orgName: 'Acme',
  siteId: 'site-1',
  siteName: 'HQ',
  agentVersion: '0.67.0',
  tags: [],
};

describe('DeviceList — agent-silent (watchdog OK) badge (#800 web-UI gap)', () => {
  it('renders the amber badge when mainAgentSilentSince is set AND watchdog is reporting', () => {
    const device: Device = {
      ...baseDevice,
      id: '22222222-2222-2222-2222-222222222222',
      hostname: 'host-silent-but-watchdog-ok',
      mainAgentSilentSince: new Date(Date.now() - 17 * 60_000).toISOString(),
      watchdogStatus: 'connected',
    };

    render(<DeviceList devices={[device]} />);

    const badge = screen.getByTestId(`device-${device.id}-agent-silent-badge`);
    expect(badge.textContent).toMatch(/Agent silent/i);
    // 17 minutes ago should render as "17m" (not "0h" or "1d")
    expect(badge.textContent).toMatch(/17m/);
  });

  it('does NOT render the badge when the watchdog is also offline (we trust device.status=offline instead)', () => {
    const device: Device = {
      ...baseDevice,
      id: '33333333-3333-3333-3333-333333333333',
      hostname: 'host-fully-offline',
      status: 'offline',
      mainAgentSilentSince: new Date(Date.now() - 60 * 60_000).toISOString(),
      watchdogStatus: 'offline',
    };

    render(<DeviceList devices={[device]} />);

    expect(screen.queryByTestId(`device-${device.id}-agent-silent-badge`)).toBeNull();
  });

  it('does NOT render the badge when the agent is heartbeating normally (mainAgentSilentSince null)', () => {
    const device: Device = {
      ...baseDevice,
      id: '44444444-4444-4444-4444-444444444444',
      hostname: 'host-healthy',
      mainAgentSilentSince: null,
      watchdogStatus: 'connected',
    };

    render(<DeviceList devices={[device]} />);

    expect(screen.queryByTestId(`device-${device.id}-agent-silent-badge`)).toBeNull();
  });

  it('still renders when watchdog reports FAILOVER (watchdog has taken over the heartbeat)', () => {
    const device: Device = {
      ...baseDevice,
      id: '55555555-5555-5555-5555-555555555555',
      hostname: 'host-failover',
      mainAgentSilentSince: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
      watchdogStatus: 'failover',
    };

    render(<DeviceList devices={[device]} />);

    const badge = screen.getByTestId(`device-${device.id}-agent-silent-badge`);
    // 2h should render as "2h"
    expect(badge.textContent).toMatch(/2h/);
  });

  it('keeps the badge on a single line so it renders as a pill, not a circle (#1013)', () => {
    const device: Device = {
      ...baseDevice,
      id: '66666666-6666-6666-6666-666666666666',
      hostname: 'host-narrow-column',
      mainAgentSilentSince: new Date(Date.now() - 12 * 24 * 3600 * 1000).toISOString(),
      watchdogStatus: 'connected',
    };

    render(<DeviceList devices={[device]} />);

    const badge = screen.getByTestId(`device-${device.id}-agent-silent-badge`);
    // Without whitespace-nowrap the text wraps to multiple lines and rounded-full
    // renders the box as a circular blob instead of a pill.
    expect(badge.className).toContain('whitespace-nowrap');
  });
});

describe('DeviceList — row action menu (#1013 clipping fix)', () => {
  it('renders the action menu in a portal outside the overflow-x-auto table wrapper so it is not clipped', () => {
    const device: Device = {
      ...baseDevice,
      id: '77777777-7777-7777-7777-777777777777',
      hostname: 'host-menu',
    };

    const { container } = render(<DeviceList devices={[device]} />);

    fireEvent.click(screen.getByLabelText('Device actions'));

    const menuItem = screen.getByText('Remote Terminal');
    // The scroll container that was clipping the dropdown.
    const scrollWrapper = container.querySelector('.overflow-x-auto');
    expect(scrollWrapper).not.toBeNull();
    // The menu must live OUTSIDE that wrapper (portaled to body) so overflow can't clip it.
    expect(scrollWrapper?.contains(menuItem)).toBe(false);
  });
});

describe('DeviceList — advanced filter via serverFilterIds prop (uncapped id set)', () => {
  it('renders only devices in the id set and shows the active-filter pill', () => {
    const inFilter: Device = {
      ...baseDevice,
      id: '88888888-8888-8888-8888-888888888888',
      hostname: 'host-in-filter',
    };
    const outOfFilter: Device = {
      ...baseDevice,
      id: '99999999-9999-9999-9999-999999999999',
      hostname: 'host-not-in-filter',
    };

    render(
      <DeviceList
        devices={[inFilter, outOfFilter]}
        serverFilterIds={new Set([inFilter.id])}
      />
    );

    expect(screen.getByText('host-in-filter')).toBeTruthy();
    expect(screen.queryByText('host-not-in-filter')).toBeNull();
    expect(screen.getByText(/Advanced filter active/i)).toBeTruthy();
  });

  it('shows every device (no pill) when serverFilterIds is null — no advanced filter active', () => {
    const a: Device = { ...baseDevice, id: 'aaaaaaa1-0000-0000-0000-000000000000', hostname: 'host-aa' };
    const b: Device = { ...baseDevice, id: 'aaaaaaa2-0000-0000-0000-000000000000', hostname: 'host-bb' };

    render(<DeviceList devices={[a, b]} serverFilterIds={null} />);

    expect(screen.getByText('host-aa')).toBeTruthy();
    expect(screen.getByText('host-bb')).toBeTruthy();
    expect(screen.queryByText(/Advanced filter active/i)).toBeNull();
  });
});
