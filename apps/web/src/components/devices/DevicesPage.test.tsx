import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import DevicesPage from './DevicesPage';
import { fetchWithAuth } from '../../stores/auth';
import { fetchAllDevices } from '../../lib/devicesFetch';

// ---------------------------------------------------------------------------
// Mocks — keep DevicesPage's own logic (including the real useAdvancedFilterIds
// hook) live; stub network, side-effectful children, and the filter-URL state.
// ---------------------------------------------------------------------------

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

vi.mock('../../lib/devicesFetch', () => ({
  fetchAllDevices: vi.fn(),
}));

vi.mock('../../hooks/useEventStream', () => ({
  useEventStream: () => ({ subscribe: vi.fn() }),
}));

vi.mock('../../services/deviceActions', () => ({
  sendDeviceCommand: vi.fn(),
  sendBulkCommand: vi.fn(),
  executeScript: vi.fn(),
  toggleMaintenanceMode: vi.fn(),
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
}));

vi.mock('@/lib/navigation', () => ({
  navigateTo: vi.fn(),
}));

vi.mock('../shared/Toast', () => ({
  showToast: vi.fn(),
}));

// The advanced filter is seeded from the URL hash; stub it to an active filter
// so the page mounts with `advancedFilter` set (v2 chip bar enabled).
const activeFilter = {
  operator: 'AND' as const,
  conditions: [{ field: 'status', operator: 'equals' as const, value: 'online' }],
};
vi.mock('./filterUrl', () => ({
  decodeFilterFromHash: vi.fn(() => activeFilter),
  writeFilterToHash: vi.fn(),
  isFiltersV2Enabled: vi.fn(() => true),
}));

// Presentational/heavy children — not under test.
vi.mock('./ScriptPickerModal', () => ({ default: () => null }));
vi.mock('./DeviceSettingsModal', () => ({ default: () => null }));
vi.mock('./AddDeviceModal', () => ({ default: () => null }));
vi.mock('./CreateGroupModal', () => ({ default: () => null }));
vi.mock('../filters/DeviceFilterBar', () => ({ DeviceFilterBar: () => null }));
vi.mock('./FilterChipBar', () => ({ FilterChipBar: () => null }));
vi.mock('./QuickAddChips', () => ({ QuickAddChips: () => null }));
vi.mock('../shared/ProgressBar', () => ({ default: () => null }));

// DeviceCard stub renders the hostname so the grid contents are assertable.
vi.mock('./DeviceCard', () => ({
  default: ({ device }: { device: { id: string; hostname: string } }) => (
    <div data-testid={`device-card-${device.id}`}>{device.hostname}</div>
  ),
}));

// DeviceList stub exposes which id set it was handed.
vi.mock('./DeviceList', () => ({
  default: ({ devices, serverFilterIds }: { devices: { id: string }[]; serverFilterIds?: Set<string> | null }) => (
    <div
      data-testid="device-list"
      data-device-count={devices.length}
      data-filter-ids={serverFilterIds ? [...serverFilterIds].sort().join(',') : ''}
    />
  ),
}));

const DEV_1 = '11111111-1111-1111-1111-111111111111';
const DEV_2 = '22222222-2222-2222-2222-222222222222';
const DEV_3 = '33333333-3333-3333-3333-333333333333';

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

  vi.mocked(fetchAllDevices).mockResolvedValue({
    data: [rawDevice(DEV_1, 'host-alpha'), rawDevice(DEV_2, 'host-beta'), rawDevice(DEV_3, 'host-gamma')],
  } as never);

  vi.mocked(fetchWithAuth).mockImplementation(async (url: string) => {
    if (url.startsWith('/filters/preview')) {
      // Advanced filter matches only DEV_1 and DEV_3.
      return jsonResponse({
        data: { totalCount: 2, deviceIds: [DEV_1, DEV_3], evaluatedAt: new Date().toISOString() },
      });
    }
    return jsonResponse({ data: [] }); // /orgs, /orgs/sites, /device-groups
  });
});

describe('DevicesPage — advanced filter applies to BOTH views', () => {
  it('grid view renders only the devices matching the advanced filter (not the raw list)', async () => {
    render(<DevicesPage />);

    // Wait for initial load, then switch to grid view.
    const gridButton = await screen.findByLabelText('Grid view');
    fireEvent.click(gridButton);

    // Filter resolution is async — wait for the excluded card to disappear.
    await waitFor(() => {
      expect(screen.queryByTestId(`device-card-${DEV_2}`)).toBeNull();
    });

    expect(screen.getByTestId(`device-card-${DEV_1}`).textContent).toBe('host-alpha');
    expect(screen.getByTestId(`device-card-${DEV_3}`).textContent).toBe('host-gamma');

    // The preview request must be the uncapped idsOnly form.
    const previewCall = vi.mocked(fetchWithAuth).mock.calls.find(([url]) => String(url).startsWith('/filters/preview'));
    expect(previewCall).toBeDefined();
    const body = JSON.parse(previewCall![1]?.body as string);
    expect(body.idsOnly).toBe(true);
    expect(body.limit).toBeUndefined();
  });

  it('list view receives the same resolved id set via serverFilterIds', async () => {
    render(<DevicesPage />);

    const list = await screen.findByTestId('device-list');
    await waitFor(() => {
      expect(list.getAttribute('data-filter-ids')).toBe([DEV_1, DEV_3].sort().join(','));
    });
    // Full device array still flows in; DeviceList combines it with the id set.
    expect(list.getAttribute('data-device-count')).toBe('3');
  });

  it('grid view shows all devices when no advanced filter is active', async () => {
    const { decodeFilterFromHash } = await import('./filterUrl');
    vi.mocked(decodeFilterFromHash).mockReturnValueOnce(null);

    render(<DevicesPage />);

    const gridButton = await screen.findByLabelText('Grid view');
    fireEvent.click(gridButton);

    expect(await screen.findByTestId(`device-card-${DEV_1}`)).toBeTruthy();
    expect(screen.getByTestId(`device-card-${DEV_2}`)).toBeTruthy();
    expect(screen.getByTestId(`device-card-${DEV_3}`)).toBeTruthy();
    expect(vi.mocked(fetchWithAuth).mock.calls.some(([url]) => String(url).startsWith('/filters/preview'))).toBe(false);
  });
});
