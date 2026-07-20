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
  default: (props: Record<string, unknown>) => (
    <div data-testid="extension-slot-host-stub" data-props={JSON.stringify(props)} />
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

describe('tabFromHash (pure, hash round-trip)', () => {
  it('recognizes a syntactically valid ext tab id', () => {
    expect(tabFromHash('ext:demo:main')).toBe('ext:demo:main');
  });

  it('recognizes an ext tab id whose contribution id embeds the slot:element fallback shape', () => {
    // ExtensionSlotDescriptor.contributionId falls back to `${slot}:${element}`
    // when the manifest omits an explicit id — the resulting composite key
    // can itself contain extra colons.
    expect(tabFromHash('ext:demo:device.detail.tabs:demo-device-tab')).toBe(
      'ext:demo:device.detail.tabs:demo-device-tab',
    );
  });

  it('round-trips through window.location.hash unchanged', () => {
    const id = 'ext:demo:main';
    window.location.hash = id;
    const raw = window.location.hash.replace(/^#/, '');
    expect(tabFromHash(raw)).toBe(id);
  });

  it('rejects a malformed ext-looking id (bad extension name)', () => {
    expect(tabFromHash('ext:UPPERCASE:main')).toBeUndefined();
  });

  it('rejects a bare "ext:" with no extension name', () => {
    expect(tabFromHash('ext:')).toBeUndefined();
  });

  it('still recognizes core tab ids', () => {
    expect(tabFromHash('security')).toBe('security');
  });

  it('falls back to undefined for an unrecognized hash', () => {
    expect(tabFromHash('not-a-real-tab')).toBeUndefined();
  });
});

describe('DeviceDetails extension tabs (device.detail.tabs@1)', () => {
  it('appends extension tabs after every core tab, in the order the descriptors already carry', async () => {
    useExtensionSlotDescriptorsMock.mockReturnValue([
      { key: 'demo:main', extensionName: 'demo', moduleUrl: '/x', elementName: 'demo-device-tab', contributionId: 'main', label: 'Demo Tab' },
      { key: 'other:sec', extensionName: 'other', moduleUrl: '/y', elementName: 'other-device-tab', contributionId: 'sec', label: 'Other Tab' },
    ]);

    render(<DeviceDetails device={baseDevice} />);

    // jsdom reports zero widths, so OverflowTabs collapses everything past
    // the first tab into the "More" dropdown — open it to see the rest of
    // the strip (including the two extension tabs) in DOM order.
    const user = userEvent.setup();
    await user.click(await screen.findByText('More'));

    const dropdown = (await screen.findByText('Demo Tab')).closest('div')!;
    const labels = within(dropdown).getAllByRole('button').map((b) => b.textContent);
    const demoIdx = labels.findIndex((l) => l?.includes('Demo Tab'));
    const otherIdx = labels.findIndex((l) => l?.includes('Other Tab'));
    // Every core tab beyond "Overview" (which alone fits as the single
    // visible tab) is also in this overflow list, ahead of both extension
    // tabs — assert the two extension tabs are the LAST two entries.
    expect(demoIdx).toBeGreaterThan(-1);
    expect(otherIdx).toBe(demoIdx + 1);
    expect(otherIdx).toBe(labels.length - 1);
  });

  it('renders no extension tabs when no extension contributes to device.detail.tabs', async () => {
    useExtensionSlotDescriptorsMock.mockReturnValue([]);
    render(<DeviceDetails device={baseDevice} />);
    await screen.findByText('Overview');
    expect(screen.queryByText('Demo Tab')).not.toBeInTheDocument();
    expect(screen.queryByTestId('extension-slot-host-stub')).not.toBeInTheDocument();
  });

  it('scopes to exactly the active extension descriptor and passes ONLY the documented device context', async () => {
    useExtensionSlotDescriptorsMock.mockReturnValue([
      { key: 'demo:main', extensionName: 'demo', moduleUrl: '/x', elementName: 'demo-device-tab', contributionId: 'main', label: 'Demo Tab' },
      { key: 'other:sec', extensionName: 'other', moduleUrl: '/y', elementName: 'other-device-tab', contributionId: 'sec', label: 'Other Tab' },
    ]);
    window.location.hash = 'ext:demo:main';

    render(<DeviceDetails device={baseDevice} />);

    const stub = await screen.findByTestId('extension-slot-host-stub');
    const props = JSON.parse(stub.dataset.props!);
    expect(props.slot).toBe('device.detail.tabs');
    expect(props.contractVersion).toBe(1);
    // Scoped to exactly ONE descriptor — never all enabled contributions.
    expect(props.descriptorKey).toBe('demo:main');
    // EXACT documented shape — no full `device` object, no orgName/siteName,
    // nothing else leaks through.
    expect(props.context).toEqual({
      contractVersion: 1,
      deviceId: 'device-1',
      organizationId: 'org-1',
      siteId: 'site-1',
    });
    expect(Object.keys(props.context).sort()).toEqual(
      ['contractVersion', 'deviceId', 'organizationId', 'siteId'].sort(),
    );

    // The rest of the page (header etc.) still renders around it.
    expect(screen.getByText('Edge 01')).toBeInTheDocument();
    // Only ONE extension-slot-host mount — never one per enabled descriptor.
    expect(screen.getAllByTestId('extension-slot-host-stub')).toHaveLength(1);
  });
});
