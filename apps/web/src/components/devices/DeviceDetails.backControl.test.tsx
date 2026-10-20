/** Device detail renders a Back control on the happy path (#9025). */
import { render, screen, fireEvent } from '@testing-library/react';
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

describe('DeviceDetails back control (#9025)', () => {
  it('renders a Back control that calls onBack', () => {
    const onBack = vi.fn();
    render(<DeviceDetails device={device} onBack={onBack} />);
    fireEvent.click(screen.getByTestId('device-detail-back'));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('renders no Back control when onBack is not provided', () => {
    render(<DeviceDetails device={device} />);
    expect(screen.queryByTestId('device-detail-back')).toBeNull();
  });
});
