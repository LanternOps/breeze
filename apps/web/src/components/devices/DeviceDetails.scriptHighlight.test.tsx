/**
 * #4886 — a script run redirects the operator to the device's Scripts tab
 * with the new execution highlighted, using the same `#<tab>/<id>` hash
 * convention DeviceDetails already uses for `#anomalies/<id>`.
 */
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DeviceDetails from './DeviceDetails';
import type { Device } from './DeviceList';

const fetchWithAuthMock = vi.hoisted(() => vi.fn());
vi.mock('../../stores/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../stores/auth')>();
  return { ...actual, fetchWithAuth: fetchWithAuthMock };
});

const useExtensionSlotDescriptorsMock = vi.hoisted(() => vi.fn());
vi.mock('../extensions/ExtensionSlotHost', () => ({
  useExtensionSlotDescriptors: (...a: unknown[]) => useExtensionSlotDescriptorsMock(...a),
  default: () => <div data-testid="extension-slot-host-stub" />,
}));

vi.mock('./DeviceScriptHistory', () => ({
  default: ({ deviceId, highlightExecutionId }: { deviceId: string; highlightExecutionId?: string }) => (
    <div
      data-testid="device-script-history-stub"
      data-device-id={deviceId}
      data-highlight-execution-id={highlightExecutionId ?? ''}
    />
  ),
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
} as Device;

beforeEach(() => {
  window.location.hash = '';
  useExtensionSlotDescriptorsMock.mockReturnValue([]);
  fetchWithAuthMock.mockResolvedValue(
    new Response(JSON.stringify({}), { status: 404 }) as unknown as Response
  );
});

describe('DeviceDetails script execution highlight (#4886)', () => {
  it('passes the execution id from "#scripts/<id>" down to DeviceScriptHistory', async () => {
    window.location.hash = '#scripts/execution-42';
    render(<DeviceDetails device={device} />);

    const stub = await screen.findByTestId('device-script-history-stub');
    expect(stub.dataset.deviceId).toBe('device-1');
    expect(stub.dataset.highlightExecutionId).toBe('execution-42');
  });

  it('passes no highlight id for a plain "#scripts" hash', async () => {
    window.location.hash = '#scripts';
    render(<DeviceDetails device={device} />);

    const stub = await screen.findByTestId('device-script-history-stub');
    expect(stub.dataset.highlightExecutionId).toBe('');
  });

  it('does not treat an anomaly id on a different tab as a script highlight', async () => {
    window.location.hash = '#anomalies/execution-42';
    render(<DeviceDetails device={device} />);

    // The scripts panel isn't even mounted on the anomalies tab.
    expect(screen.queryByTestId('device-script-history-stub')).not.toBeInTheDocument();
  });
});
