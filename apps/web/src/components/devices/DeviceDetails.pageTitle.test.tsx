/** Device detail tab title shows the device name (usePageItemName). */
import { render } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
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

beforeEach(() => {
  document.title = 'Device Details | Breeze RMM';
});

describe('DeviceDetails page title', () => {
  it('prefixes the tab title with the device display name', () => {
    render(<DeviceDetails device={device} />);
    expect(document.title).toBe('Edge 01 · Device Details | Breeze RMM');
  });

  it('falls back to the hostname when there is no display name', () => {
    render(<DeviceDetails device={{ ...device, displayName: undefined } as Device} />);
    expect(document.title).toBe('edge-01 · Device Details | Breeze RMM');
  });
});
