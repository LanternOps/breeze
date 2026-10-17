/** Device header leads with state and shows one name (#9026). */
import '@/lib/i18n';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import DeviceDetails, { METRIC_SAMPLE_FRESH_MS, metricsAreCurrent } from './DeviceDetails';
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

vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

const base: Device = {
  id: 'device-1',
  hostname: 'DESKTOP-7QK2',
  os: 'windows',
  osVersion: '11.0.22631',
  status: 'online',
  cpuPercent: 12,
  ramPercent: 34,
  uptimeSeconds: 3600,
  lastSeen: minutesAgo(1),
  orgId: 'org-1',
  orgName: 'Org One',
  siteId: 'site-1',
  siteName: 'HQ',
  agentVersion: '0.63.0',
  pendingReboot: false,
  displayName: 'Front desk PC',
} as Device;

describe('metricsAreCurrent (#9026)', () => {
  const now = Date.parse('2026-10-17T12:00:00.000Z');
  const ago = (ms: number) => new Date(now - ms).toISOString();

  it('is current up to and including the freshness window, stale one ms past it', () => {
    expect(METRIC_SAMPLE_FRESH_MS).toBe(10 * 60 * 1000);
    expect(metricsAreCurrent('online', ago(METRIC_SAMPLE_FRESH_MS), now)).toBe(true);
    expect(metricsAreCurrent('online', ago(METRIC_SAMPLE_FRESH_MS + 1), now)).toBe(false);
  });

  it('separates "caller cannot say" (undefined) from "no sample" (null / empty / garbage)', () => {
    expect(metricsAreCurrent('online', undefined, now)).toBe(true);
    expect(metricsAreCurrent('online', null, now)).toBe(false);
    expect(metricsAreCurrent('online', '', now)).toBe(false);
    expect(metricsAreCurrent('online', 'garbage', now)).toBe(false);
  });

  it('is never current for an offline or removed device', () => {
    expect(metricsAreCurrent('offline', ago(1000), now)).toBe(false);
    expect(metricsAreCurrent('decommissioned', undefined, now)).toBe(false);
    expect(metricsAreCurrent('maintenance', ago(1000), now)).toBe(true);
  });
});

describe('DeviceDetails header state (#9026)', () => {
  it('shows "—" for CPU and RAM on an offline device instead of a stale 0.0%', () => {
    render(
      <DeviceDetails
        device={{ ...base, status: 'offline', cpuPercent: 0, ramPercent: 0, lastSeen: minutesAgo(25) }}
        metricsSampledAt={minutesAgo(25)}
      />,
    );
    expect(screen.getByTestId('device-stat-cpu')).toHaveTextContent('—');
    expect(screen.getByTestId('device-stat-ram')).toHaveTextContent('—');
    expect(screen.queryByText(/0\.0\s?%/)).toBeNull();
  });

  it('shows "—" when an online device has no sample inside the heartbeat window', () => {
    render(<DeviceDetails device={base} metricsSampledAt={minutesAgo(90)} />);
    expect(screen.getByTestId('device-stat-cpu')).toHaveTextContent('—');
    expect(screen.getByTestId('device-stat-ram')).toHaveTextContent('—');
  });

  it('shows "—" when the device has never reported a sample', () => {
    render(<DeviceDetails device={base} metricsSampledAt={null} />);
    expect(screen.getByTestId('device-stat-cpu')).toHaveTextContent('—');
  });

  it('shows live percentages for a fresh sample on an online device', () => {
    render(<DeviceDetails device={base} metricsSampledAt={minutesAgo(1)} />);
    expect(screen.getByTestId('device-stat-cpu')).toHaveTextContent(/12\.0\s?%/);
    expect(screen.getByTestId('device-stat-ram')).toHaveTextContent(/34\.0\s?%/);
  });

  it('reads "Offline · last seen <relative time>" in the status pill', () => {
    render(<DeviceDetails device={{ ...base, status: 'offline', lastSeen: minutesAgo(25) }} />);
    expect(screen.getByTestId('device-status-pill')).toHaveTextContent('Offline · last seen 25 minutes ago');
  });

  it('keeps the plain status label when the device is online', () => {
    render(<DeviceDetails device={base} />);
    expect(screen.getByTestId('device-status-pill')).toHaveTextContent(/^Online$/);
  });

  it('formats the OS label and shows the hostname once when it differs from the display name', () => {
    render(<DeviceDetails device={base} />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Front desk PC');
    const subline = screen.getByTestId('device-header-subline');
    expect(within(subline).getByText('Windows 11 (build 22631)')).toBeInTheDocument();
    const host = within(subline).getByTestId('device-header-hostname');
    expect(host).toHaveTextContent('DESKTOP-7QK2');
    expect(host.className).toContain('font-mono');
  });

  it('does not repeat the hostname when it is the display name', () => {
    render(<DeviceDetails device={{ ...base, displayName: undefined }} />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('DESKTOP-7QK2');
    expect(screen.queryByTestId('device-header-hostname')).toBeNull();
  });

  it('renders the org and site links in the foreground colour with a resting underline', () => {
    render(<DeviceDetails device={base} />);
    for (const id of ['org-record-link', 'site-record-link']) {
      const link = screen.getByTestId(id);
      expect(link.className).toContain('text-foreground');
      expect(link.className).toMatch(/(^|\s)underline(\s|$)/);
    }
  });
});
