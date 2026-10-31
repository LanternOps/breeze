/**
 * Issue #7153: at 1024px the Overview stat strip's 5th stat (Logged-in User)
 * spilled out from under the Activity panel. Root cause: the Health block
 * (CPU/RAM/Uptime) was `flex flex-1` with no `min-w-0`, so it never shrank
 * below its content width; and the "Logged-in User" label row was
 * `whitespace-nowrap` with no truncation, so once squeezed it overflowed
 * instead of eliding. jsdom has no layout engine, so this asserts the
 * markup/classes that carry the fix rather than pixel overflow.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import DeviceDetails from './DeviceDetails';
import type { Device } from './DeviceList';

vi.mock('../../stores/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../stores/auth')>();
  return {
    ...actual,
    fetchWithAuth: vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'NOT FOUND',
      json: vi.fn().mockResolvedValue({}),
    }),
  };
});

vi.mock('../extensions/ExtensionSlotHost', () => ({
  useExtensionSlotDescriptors: () => [],
  default: () => null,
}));

const device: Device = {
  id: 'device-1',
  hostname: 'edge-01',
  os: 'windows',
  osVersion: '11',
  status: 'online',
  cpuPercent: 12,
  ramPercent: 34,
  uptimeSeconds: 3600,
  lastSeen: '2026-02-09T10:00:00.000Z',
  orgId: 'org-1',
  orgName: 'Org One',
  siteId: 'site-1',
  siteName: 'HQ',
  agentVersion: '1.0.0',
  pendingReboot: false,
  displayName: 'Edge 01',
  lastUser: 'a-very-long-domain\\username-that-would-otherwise-overflow',
} as Device;

describe('DeviceDetails overview stat strip (#7153)', () => {
  it('lays the six stats on one even grid that narrows by breakpoint', () => {
    render(<DeviceDetails device={device} />);
    const strip = screen.getByTestId('device-health-strip');
    expect(strip.className).toMatch(/\bgrid\b/);
    expect(strip.className).toMatch(/grid-cols-2/);
    expect(strip.className).toMatch(/sm:grid-cols-3/);
    expect(strip.className).toMatch(/xl:grid-cols-6/);
  });

  it('truncates the username and its "Logged-in User" label instead of overflowing the cell', () => {
    render(<DeviceDetails device={device} />);
    const value = screen.getByTestId('device-stat-user');
    expect(value.className).toMatch(/truncate/);
    expect(value).toHaveAttribute('title', device.lastUser);
    expect(value.parentElement).toHaveClass('min-w-0');
    const label = screen.getByText('Logged-in User');
    expect(label.className).toMatch(/truncate/);
  });

  it('mutes unknown values so the stats that are present stand out', () => {
    render(<DeviceDetails device={{ ...device, status: 'offline', lastUser: '' }} />);
    expect(screen.getByTestId('device-stat-cpu')).toHaveTextContent('—');
    expect(screen.getByTestId('device-stat-cpu').className).toMatch(/text-muted-foreground/);
    expect(screen.getByTestId('device-stat-user').className).toMatch(/text-muted-foreground/);
  });
});
