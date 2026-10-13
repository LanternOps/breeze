import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DeviceDetails, { tabFromHash } from './DeviceDetails';
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

// Stubbed so these tests assert tab *visibility* and panel mounting only —
// the panel's own states are covered in DeviceWorkloadsTab.test.tsx.
vi.mock('./DeviceWorkloadsTab', () => ({
  default: ({ deviceId }: { deviceId: string }) => (
    <div data-testid="workloads-tab-stub" data-device-id={deviceId} />
  ),
}));

const baseDevice: Device = {
  id: 'device-1',
  hostname: 'edge-01',
  os: 'windows',
  osVersion: '11',
  status: 'online',
  cpuPercent: 58,
  ramPercent: 71,
  uptimeSeconds: 3600,
  lastSeen: '2026-02-09T10:00:00.000Z',
  orgId: 'org-1',
  orgName: 'Org One',
  siteId: 'site-1',
  siteName: 'HQ',
  agentVersion: '1.0.0',
  pendingReboot: false,
  lastUser: 'jdoe',
  displayName: 'Edge 01',
} as Device;

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 404): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

// jsdom reports zero widths, so OverflowTabs collapses everything past the
// first tab into the "More" dropdown. Open it to read the whole strip.
async function tabLabels(): Promise<string[]> {
  const user = userEvent.setup();
  await user.click(await screen.findByText('More'));
  const dropdown = (await screen.findByText('Details')).closest('div')!;
  return within(dropdown)
    .getAllByRole('menuitem')
    .map((b) => b.textContent ?? '');
}

beforeEach(() => {
  fetchWithAuthMock.mockReset();
  fetchWithAuthMock.mockResolvedValue(makeJsonResponse({}, false, 404));
  useExtensionSlotDescriptorsMock.mockReset();
  useExtensionSlotDescriptorsMock.mockReturnValue([]);
  window.location.hash = '';
});

afterEach(() => {
  window.location.hash = '';
  vi.clearAllMocks();
});

describe('DeviceDetails Workloads tab (#8193)', () => {
  it('omits the tab on a device that hosts no workloads', async () => {
    render(<DeviceDetails device={baseDevice} />);
    const labels = await tabLabels();
    expect(labels.some((l) => l.includes('Workloads'))).toBe(false);
  });

  it('shows the tab on a workload host', async () => {
    render(<DeviceDetails device={{ ...baseDevice, hostsWorkloads: true }} />);
    const labels = await tabLabels();
    expect(labels.some((l) => l.includes('Workloads'))).toBe(true);
  });

  it('parses #workloads as a core tab', () => {
    expect(tabFromHash('workloads')).toBe('workloads');
  });

  it('mounts the panel on a #workloads deep link even before the host flag is set', async () => {
    // A runtime row can exist (detection unknown, or a runtime just removed)
    // while hosts_workloads is false; the deep link still reaches the panel,
    // which explains the state instead of leaving a blank content area.
    window.location.hash = 'workloads';
    render(<DeviceDetails device={baseDevice} />);
    const stub = await screen.findByTestId('workloads-tab-stub');
    expect(stub.dataset.deviceId).toBe('device-1');
  });
});
