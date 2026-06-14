import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import DevicesPage from './DevicesPage';
import { fetchWithAuth } from '../../stores/auth';
import { fetchAllDevices, fetchAllNetworkDevices } from '../../lib/devicesFetch';

// ---------------------------------------------------------------------------
// Mocks — keep DevicesPage's own logic (including the real useAdvancedFilterIds
// hook) live; stub network, side-effectful children, and the filter-URL state.
// ---------------------------------------------------------------------------

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

// DeviceList stub exposes which id set it was handed, and re-emits a bulk
// action over the FULL device array it was given (mirroring the real
// DeviceList, which hands the unfiltered selection to onBulkAction). Tests use
// the per-action buttons to drive DevicesPage.handleBulkAction directly.
type StubDevice = { id: string; deviceClass?: string; hostname?: string };
vi.mock('./DeviceList', () => ({
  default: ({ devices, serverFilterIds, onBulkAction }: { devices: StubDevice[]; serverFilterIds?: Set<string> | null; onBulkAction?: (action: string, devices: StubDevice[]) => void }) => (
    <div
      data-testid="device-list"
      data-device-count={devices.length}
      data-filter-ids={serverFilterIds ? [...serverFilterIds].sort().join(',') : ''}
    >
      {['maintenance-on', 'maintenance-off', 'decommission', 'reboot'].map(action => (
        <button
          key={action}
          type="button"
          data-testid={`bulk-${action}`}
          onClick={() => onBulkAction?.(action, devices)}
        >
          {action}
        </button>
      ))}
    </div>
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

  // Network arm (#1322) defaults to empty so existing assertions over the
  // agent fleet are unaffected.
  vi.mocked(fetchAllNetworkDevices).mockResolvedValue({ data: [], total: 0, pagesWalked: 1 } as never);

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

// #1322 review fix (silent failure): the network-arm fetch must NOT mask a
// real auth failure. A 401 has to surface to the normal error/auth-redirect
// path (fetchWithAuth already logs the user out); only a non-auth failure
// (transient, or a legitimately-absent endpoint) degrades to an empty set so
// the agent fleet still renders.
describe('DevicesPage — network-arm fetch failure handling (#1322)', () => {
  it('surfaces a 401 from the network fetch instead of swallowing it to empty', async () => {
    // The web fetcher throws the raw Response on a non-OK status (after
    // fetchWithAuth has already attempted refresh + logout). A 401 must escape
    // the best-effort `.catch()` so the page renders the session-expired UI.
    // Use a real Response so the `err instanceof Response` guard in DevicesPage
    // matches exactly as it would at runtime.
    const unauthorized = new Response(null, { status: 401 });
    vi.mocked(fetchAllNetworkDevices).mockRejectedValueOnce(unauthorized);

    render(<DevicesPage />);

    // The error banner maps a 401 Response to "Session expired" (errorMessages).
    expect(await screen.findByText('Session expired')).toBeTruthy();
    // And the agent list/grid must NOT be rendered as if load succeeded.
    expect(screen.queryByTestId(`device-card-${DEV_1}`)).toBeNull();
  });

  it('still degrades a non-401 network-fetch failure to an empty network set', async () => {
    // A transient/non-auth failure keeps the graceful degrade: the agent
    // fleet renders, no error banner.
    vi.mocked(fetchAllNetworkDevices).mockRejectedValueOnce(new Error('boom'));
    const { decodeFilterFromHash } = await import('./filterUrl');
    vi.mocked(decodeFilterFromHash).mockReturnValueOnce(null);

    render(<DevicesPage />);

    // Agent devices still load; no session-expired / error banner.
    expect(await screen.findByTestId('device-list')).toBeTruthy();
    expect(screen.queryByText('Session expired')).toBeNull();
    expect(screen.queryByText('Failed to load')).toBeNull();
  });
});

// #1322 specialist-panel HIGH: network rows (deviceClass='network', whose id is
// a discovered_assets.id NOT a devices.id) flowed into agent-only bulk actions.
// toggleMaintenanceMode → PATCH /devices/:id/maintenance 404s on an asset id and
// THROWS; with no per-item catch the loop aborted and silently skipped every
// real agent device after the network row. Fix: (a) drop network rows from
// agent-only bulk actions with a clear message, and (b) per-item try/catch so
// one failure can't abort the batch.
describe('DevicesPage — bulk actions exclude network rows + survive per-item failure (#1322)', () => {
  const NET_1 = '44444444-4444-4444-4444-444444444444';

  function rawNetworkDevice(id: string, hostname: string) {
    return {
      id,
      deviceClass: 'network',
      assetType: 'printer',
      hostname,
      status: 'online',
      lastSeenAt: new Date().toISOString(),
      orgId: 'org-1',
      siteId: 'site-1',
      tags: [],
    };
  }

  async function renderWithFleet() {
    const { decodeFilterFromHash } = await import('./filterUrl');
    vi.mocked(decodeFilterFromHash).mockReturnValue(null); // no advanced filter
    vi.mocked(fetchAllNetworkDevices).mockResolvedValue({
      data: [rawNetworkDevice(NET_1, 'Lobby Printer')],
      total: 1,
      pagesWalked: 1,
    } as never);

    render(<DevicesPage />);
    // The unfiltered fleet = 3 agent + 1 network = 4 rows handed to DeviceList.
    const list = await screen.findByTestId('device-list');
    await waitFor(() => {
      expect(list.getAttribute('data-device-count')).toBe('4');
    });
    return list;
  }

  it('skips the network row and only toggles maintenance on the 3 agent devices', async () => {
    const { toggleMaintenanceMode } = await import('../../services/deviceActions');
    const { showToast } = await import('../shared/Toast');
    vi.mocked(toggleMaintenanceMode).mockResolvedValue({ success: true, device: {} } as never);

    await renderWithFleet();
    fireEvent.click(screen.getByTestId('bulk-maintenance-on'));

    await waitFor(() => {
      expect(vi.mocked(toggleMaintenanceMode)).toHaveBeenCalledTimes(3);
    });
    // The network asset id must NEVER have been sent to the maintenance endpoint.
    const targetedIds = vi.mocked(toggleMaintenanceMode).mock.calls.map(c => c[0]);
    expect(targetedIds).not.toContain(NET_1);
    expect(targetedIds.sort()).toEqual([DEV_1, DEV_2, DEV_3].sort());

    // User is told the network device was skipped, then the success summary.
    const messages = vi.mocked(showToast).mock.calls.map(c => c[0].message ?? '');
    expect(messages.some(m => /network device.*skipped/i.test(m))).toBe(true);
    expect(messages.some(m => /3 devices put into maintenance mode/i.test(m))).toBe(true);
  });

  it('does not abort the batch when one agent device fails mid-loop (per-item catch)', async () => {
    const { toggleMaintenanceMode } = await import('../../services/deviceActions');
    const { showToast } = await import('../shared/Toast');
    // The FIRST agent device throws (as a 404 on a real-but-stale id would).
    // Without the per-item catch this aborts the loop and DEV_2/DEV_3 are
    // silently skipped — exactly the bug. With the fix all 3 are attempted.
    vi.mocked(toggleMaintenanceMode)
      .mockRejectedValueOnce(new Error('404 not found'))
      .mockResolvedValue({ success: true, device: {} } as never);

    await renderWithFleet();
    fireEvent.click(screen.getByTestId('bulk-maintenance-on'));

    await waitFor(() => {
      // All 3 agent devices were attempted despite the first throwing.
      expect(vi.mocked(toggleMaintenanceMode)).toHaveBeenCalledTimes(3);
    });

    // A partial-failure summary toast is shown — not a generic abort.
    const messages = vi.mocked(showToast).mock.calls.map(c => c[0].message ?? '');
    expect(messages.some(m => /2 device.*maintenance mode.*1 failed/i.test(m))).toBe(true);
  });

  it('blocks a network-only selection from an agent-only action with a clear message', async () => {
    const { toggleMaintenanceMode } = await import('../../services/deviceActions');
    const { showToast } = await import('../shared/Toast');

    const { decodeFilterFromHash } = await import('./filterUrl');
    vi.mocked(decodeFilterFromHash).mockReturnValue(null);
    // Only a network device in the fleet → selection is network-only.
    vi.mocked(fetchAllDevices).mockResolvedValue({ data: [] } as never);
    vi.mocked(fetchAllNetworkDevices).mockResolvedValue({
      data: [rawNetworkDevice(NET_1, 'Lobby Printer')],
      total: 1,
      pagesWalked: 1,
    } as never);

    render(<DevicesPage />);
    const list = await screen.findByTestId('device-list');
    await waitFor(() => expect(list.getAttribute('data-device-count')).toBe('1'));

    fireEvent.click(screen.getByTestId('bulk-decommission'));

    // No agent endpoint was hit, and the user got a clear "agent only" message.
    await waitFor(() => {
      const messages = vi.mocked(showToast).mock.calls.map(c => c[0].message ?? '');
      expect(messages.some(m => /applies to agent devices only/i.test(m))).toBe(true);
    });
    expect(vi.mocked(toggleMaintenanceMode)).not.toHaveBeenCalled();
  });
});
