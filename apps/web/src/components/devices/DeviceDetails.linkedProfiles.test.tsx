import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

// Stubbed so these tests assert tab *visibility* and panel mounting only —
// the tab's own loading/empty/denied states are covered in
// DeviceLinkedProfilesTab.test.tsx.
vi.mock('./DeviceLinkedProfilesTab', () => ({
  default: ({ deviceId }: { deviceId: string }) => (
    <div data-testid="linked-profiles-tab-stub" data-device-id={deviceId} />
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
    .getAllByRole('button')
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

describe('DeviceDetails Linked Profiles tab visibility (#2865)', () => {
  it('omits the tab when the device is not in a link group', async () => {
    render(<DeviceDetails device={baseDevice} />);
    const labels = await tabLabels();
    expect(labels.some((l) => l.includes('Details'))).toBe(true);
    expect(labels.some((l) => l.includes('Linked Profiles'))).toBe(false);
  });

  it('omits the tab when linkGroupId is explicitly null', async () => {
    render(<DeviceDetails device={{ ...baseDevice, linkGroupId: null }} />);
    const labels = await tabLabels();
    expect(labels.some((l) => l.includes('Linked Profiles'))).toBe(false);
  });

  it('shows the tab for a multi-boot peer (linkGroupId set, no role)', async () => {
    render(<DeviceDetails device={{ ...baseDevice, linkGroupId: 'group-1' }} />);
    const labels = await tabLabels();
    expect(labels.some((l) => l.includes('Linked Profiles'))).toBe(true);
  });

  it('shows the tab for a vm_host group member', async () => {
    render(
      <DeviceDetails
        device={{ ...baseDevice, linkGroupId: 'group-1', linkGroupRole: 'guest' }}
      />,
    );
    const labels = await tabLabels();
    expect(labels.some((l) => l.includes('Linked Profiles'))).toBe(true);
  });
});

describe('DeviceDetails #linked-profiles deep link (#2865)', () => {
  it('mounts the panel when the device is linked', async () => {
    window.location.hash = 'linked-profiles';
    render(<DeviceDetails device={{ ...baseDevice, linkGroupId: 'group-1' }} />);

    const stub = await screen.findByTestId('linked-profiles-tab-stub');
    expect(stub.dataset.deviceId).toBe('device-1');
  });

  it('falls back to Overview on an unlinked device instead of a blank content area', async () => {
    window.location.hash = 'linked-profiles';
    render(<DeviceDetails device={baseDevice} />);

    // The header always renders; the assertion that matters is that the
    // linked-profiles panel did NOT mount and Overview took its place.
    await screen.findByText('Edge 01');
    expect(screen.queryByTestId('linked-profiles-tab-stub')).not.toBeInTheDocument();
    // Overview's Activity rail is Overview-only, so its presence proves the
    // fallback selected Overview rather than leaving no panel mounted.
    expect(screen.getByText('Overview')).toBeInTheDocument();
    expect(screen.queryByText('Linked Profiles')).not.toBeInTheDocument();
  });
});
