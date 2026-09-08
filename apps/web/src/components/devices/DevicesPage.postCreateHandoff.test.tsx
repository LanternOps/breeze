import '@/lib/i18n';

import { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import DevicesPage from './DevicesPage';
import { fetchWithAuth } from '../../stores/auth';
import { fetchAllDevices, fetchAllNetworkDevices } from '../../lib/devicesFetch';

// #5265 — regression for "post-create HTTP-check hand-off panel never
// renders". Root cause: AddNetworkAssetModal.onCreated triggers
// DevicesPage.refreshDevices(), which flips `loading` back to true; every
// render branch in DevicesPage used to be a SEPARATE `return`, so the
// `loading` branch rendered a skeleton WITHOUT mounting <AddNetworkAssetModal>
// at all — unmounting the real modal and resetting its internal
// `createdAsset` state to null the instant the hand-off panel
// (`data-testid="asset-post-create"`) was supposed to appear.
//
// This suite does not exercise the real AddNetworkAssetModal (that lives in
// AddNetworkAssetModal.test.tsx) — it stands in a stateful fake in its place
// so a remount is observable: the fake's own `created` state can only survive
// a `loading` flip if the SAME component instance stays mounted, exactly the
// property DevicesPage.tsx must now guarantee.

const flagState = vi.hoisted(() => ({
  ENABLE_NETWORK_DEVICES_IN_LIST: false,
  ENABLE_ENDPOINT_AV_FEATURES: false,
}));
vi.mock('@/lib/featureFlags', () => flagState);

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

vi.mock('../../lib/devicesFetch', () => ({
  fetchAllDevices: vi.fn(),
  fetchAllNetworkDevices: vi.fn(),
}));

vi.mock('../../hooks/useEventStream', () => ({
  useEventStream: () => ({ subscribe: vi.fn() }),
}));

vi.mock('../../services/deviceActions', () => ({
  sendDeviceCommand: vi.fn(),
  sendBulkCommand: vi.fn(),
  executeScript: vi.fn(),
  exitMaintenanceMode: vi.fn(),
  decommissionDevice: vi.fn(),
  bulkDecommissionDevices: vi.fn(),
  restoreDevice: vi.fn(),
  permanentDeleteDevice: vi.fn(),
  sendWakeCommand: vi.fn(),
  sendBulkWakeCommand: vi.fn(),
  summarizeBulkWakeFailures: vi.fn(() => ''),
  summarizeBulkCommandFailures: vi.fn(() => ''),
  watchWakeOutcome: vi.fn(),
  WakeCommandError: class WakeCommandError extends Error { code = 'x'; },
  wakeFriendlyErrorMessage: vi.fn(() => null),
  linkDevicesMultiboot: vi.fn(),
  linkDevicesVmHost: vi.fn(),
  fetchRemovalConfig: vi.fn(async () => ({ uninstallDrainWindowHours: 72 })),
  bulkRestoreDevices: vi.fn(),
  startBulkPurge: vi.fn(),
  fetchPurgeRun: vi.fn(),
  PURGE_POLL_INTERVAL_MS: 2000,
  BulkPurgeRejectedError: class BulkPurgeRejectedError extends Error {
    rejected: unknown[] = [];
  },
}));

vi.mock('@/lib/navigation', () => ({
  navigateTo: vi.fn(),
}));

vi.mock('../shared/Toast', () => ({
  showToast: vi.fn(),
}));

const orgStoreState = vi.hoisted(() => ({
  currentOrgId: null as string | null,
  currentPartnerId: null as string | null,
  allOrgs: true,
  lastOrgId: null as string | null,
  organizations: [] as Array<{ id: string; name: string }>,
  organizationsLoaded: true,
  error: null as string | null,
}));
vi.mock('../../stores/orgStore', () => ({
  useOrgStore: Object.assign(
    (selector?: (s: typeof orgStoreState) => unknown) =>
      selector ? selector(orgStoreState) : orgStoreState,
    { getState: () => orgStoreState }
  )
}));

vi.mock('./filterUrl', () => ({
  decodeFilterFromHash: vi.fn(() => undefined),
  writeFilterToHash: vi.fn(),
  isFiltersV2Enabled: vi.fn(() => false),
}));

vi.mock('./ScriptPickerModal', () => ({ default: () => null }));
vi.mock('./DeviceSettingsModal', () => ({ default: () => null }));
vi.mock('./AddDeviceModal', () => ({ default: () => null }));
vi.mock('./CreateGroupModal', () => ({ default: () => null }));
vi.mock('../filters/DeviceFilterBar', () => ({ DeviceFilterBar: () => null }));
vi.mock('./DeviceFilterToolbar', () => ({ DeviceFilterToolbar: () => null }));
vi.mock('../shared/ProgressBar', () => ({ default: () => null }));
vi.mock('./DeviceCard', () => ({ default: () => null }));
vi.mock('./DeviceList', () => ({
  default: () => <div data-testid="device-list" />,
}));

// The stateful fake at the center of this test — see file header.
vi.mock('./AddNetworkAssetModal', () => ({
  default: ({
    isOpen,
    onCreated,
  }: {
    isOpen: boolean;
    onClose: () => void;
    onCreated?: (assetId: string) => void;
  }) => {
    const [created, setCreated] = useState(false);
    if (!isOpen) return null;
    if (created) {
      return <div data-testid="asset-post-create">hand-off panel</div>;
    }
    return (
      <button
        type="button"
        data-testid="fake-asset-create"
        onClick={() => {
          setCreated(true);
          onCreated?.('asset-1');
        }}
      >
        create
      </button>
    );
  },
}));

const DEV_1 = '11111111-1111-1111-1111-111111111111';

function rawDevice(id: string, hostname: string) {
  return {
    id,
    hostname,
    osType: 'windows',
    osVersion: '11',
    status: 'online',
    lastSeenAt: new Date().toISOString(),
    orgId: 'org-1',
    siteId: 'site-1',
    agentVersion: '0.68.0',
    tags: [],
  };
}

function jsonResponse(payload: unknown) {
  return { ok: true, json: async () => payload } as unknown as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  window.location.hash = '';

  vi.mocked(fetchAllNetworkDevices).mockResolvedValue({ data: [], total: 0, pagesWalked: 1 } as never);
  vi.mocked(fetchWithAuth).mockImplementation(async () => jsonResponse({ data: [] }));
});

describe('DevicesPage — post-create hand-off survives the refresh (#5265)', () => {
  it('keeps the network-asset modal mounted (and its hand-off panel visible) when refreshDevices() flips the page back into loading', async () => {
    vi.mocked(fetchAllDevices).mockResolvedValueOnce({
      data: [rawDevice(DEV_1, 'host-alpha')],
    } as never);

    render(<DevicesPage />);
    await screen.findByTestId('device-list');

    // Open the "Add network asset" modal the same way the header split menu does.
    fireEvent.click(screen.getByTestId('devices-page-add-menu-trigger'));
    fireEvent.click(screen.getByTestId('devices-page-add-menu-network-asset'));

    const createButton = await screen.findByTestId('fake-asset-create');

    // The post-create refresh's fetchAllDevices call never resolves during
    // this test, so DevicesPage stays in its `loading` branch — exactly the
    // window in which the bug unmounted the modal.
    type DevicesResult = Awaited<ReturnType<typeof fetchAllDevices>>;
    let resolveRefresh!: (value: DevicesResult) => void;
    vi.mocked(fetchAllDevices).mockImplementationOnce(
      () => new Promise<DevicesResult>((resolve) => { resolveRefresh = resolve; })
    );

    fireEvent.click(createButton);

    // Confirm we are actually in the `loading` branch (the device list is
    // gone), not merely that the refresh resolved instantly.
    await waitFor(() => expect(screen.queryByTestId('device-list')).toBeNull());

    // The hand-off panel must still be on screen — this is the assertion
    // that fails on unfixed DevicesPage.tsx (the modal remounts and its
    // `created` state resets to false).
    expect(screen.getByTestId('asset-post-create')).toBeTruthy();

    // Let the pending refresh resolve so the test doesn't leak a dangling
    // promise/act warning.
    resolveRefresh({ data: [rawDevice(DEV_1, 'host-alpha')], pagesWalked: 1 } as DevicesResult);
    await screen.findByTestId('device-list');
  });
});
