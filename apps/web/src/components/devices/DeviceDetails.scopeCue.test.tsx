/** Header says when the device belongs to another org than the working one (#9027). */
import '@/lib/i18n';
import { fireEvent, render, screen } from '@testing-library/react';
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

vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

const device: Device = {
  id: 'device-1',
  hostname: 'edge-01',
  os: 'windows',
  osVersion: '11',
  status: 'online',
  cpuPercent: 12,
  ramPercent: 34,
  lastSeen: new Date().toISOString(),
  orgId: 'org-1',
  orgName: 'Default Organization',
  siteId: 'site-1',
  siteName: 'HQ',
  agentVersion: '1.0.0',
} as Device;

describe('DeviceDetails scope cue (#9027)', () => {
  it('names the device org and offers the switch when the working org differs', () => {
    const onSwitch = vi.fn();
    render(<DeviceDetails device={device} workingOrgId="org-99" onSwitchToDeviceOrg={onSwitch} />);
    const cue = screen.getByTestId('device-scope-cue');
    expect(cue).toHaveTextContent('Viewing a Default Organization device');
    expect(cue).not.toHaveAttribute('aria-live');
    const button = screen.getByTestId('device-scope-switch');
    expect(button).toHaveTextContent('Switch to Default Organization');
    fireEvent.click(button);
    expect(onSwitch).toHaveBeenCalledTimes(1);
  });

  it('is hidden when the working org is the device org', () => {
    render(<DeviceDetails device={device} workingOrgId="org-1" onSwitchToDeviceOrg={vi.fn()} />);
    expect(screen.queryByTestId('device-scope-cue')).toBeNull();
  });

  it('is hidden in fleet view (no working org)', () => {
    render(<DeviceDetails device={device} workingOrgId={null} onSwitchToDeviceOrg={vi.fn()} />);
    expect(screen.queryByTestId('device-scope-cue')).toBeNull();
  });
});
