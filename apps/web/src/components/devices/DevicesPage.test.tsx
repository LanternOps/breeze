import '@/lib/i18n';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import DevicesPage from './DevicesPage';
import { fetchWithAuth } from '../../stores/auth';
import { fetchAllDevices, fetchAllNetworkDevices } from '../../lib/devicesFetch';
import { navigateTo } from '@/lib/navigation';

// Feature flags are evaluated at module load, so expose a mutable holder we can
// flip per-test. Default the network arm ON here since most #1322 cases below
// exercise the network behaviour; the dedicated flag-off case sets it false.
const flagState = vi.hoisted(() => ({
  ENABLE_NETWORK_DEVICES_IN_LIST: true,
  ENABLE_ENDPOINT_AV_FEATURES: false,
}));
vi.mock('@/lib/featureFlags', () => flagState);

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
  linkDevicesMultiboot: vi.fn(),
  linkDevicesVmHost: vi.fn(),
}));

vi.mock('@/lib/navigation', () => ({
  navigateTo: vi.fn(),
}));

vi.mock('../shared/Toast', () => ({
  showToast: vi.fn(),
}));

vi.mock('../../stores/orgStore', () => ({
  useOrgStore: Object.assign(() => ({ currentOrgId: null, organizations: [] }), {
    getState: () => ({ currentOrgId: null, organizations: [] })
  })
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
// ScriptPickerModal is stubbed to expose the real modal's select→close
// sequence: it calls onSelect(...) and then onClose() (mirroring
// ScriptPickerModal.handleSelect for a parameterless script). This is the
// exact ordering that regressed multi-select run-script — onClose wiped the
// target devices before the confirm dialog executed.
vi.mock('./ScriptPickerModal', () => ({
  default: ({
    isOpen,
    onSelect,
    onClose,
  }: {
    isOpen: boolean;
    onSelect: (script: { id: string; name: string }, runAs: string, parameters?: unknown) => void;
    onClose: () => void;
  }) =>
    isOpen ? (
      <button
        type="button"
        data-testid="pick-script"
        onClick={() => {
          onSelect({ id: 'script-1', name: 'Test Script' }, 'system', undefined);
          onClose();
        }}
      >
        pick
      </button>
    ) : null,
}));
vi.mock('./DeviceSettingsModal', () => ({ default: () => null }));
vi.mock('./AddDeviceModal', () => ({ default: () => null }));
vi.mock('./CreateGroupModal', () => ({ default: () => null }));
vi.mock('../filters/DeviceFilterBar', () => ({ DeviceFilterBar: () => null }));
vi.mock('./DeviceFilterToolbar', () => ({ DeviceFilterToolbar: () => null }));
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
type StubDevice = { id: string; deviceClass?: string; hostname?: string; displayName?: string; watchdogVersion?: string | null; status?: string };
vi.mock('./DeviceList', () => ({
  default: ({ devices, serverFilterIds, onBulkAction, onAction, onSelect, onShowDecommissioned, includeDecommissioned }: { devices: StubDevice[]; serverFilterIds?: Set<string> | null; onBulkAction?: (action: string, devices: StubDevice[]) => void; onAction?: (action: string, device: StubDevice) => void; onSelect?: (device: StubDevice) => void; onShowDecommissioned?: () => void; includeDecommissioned?: boolean }) => (
    <div
      data-testid="device-list"
      data-device-count={devices.length}
      data-include-decommissioned={includeDecommissioned ? 'true' : 'false'}
      data-filter-ids={serverFilterIds ? [...serverFilterIds].sort().join(',') : ''}
      data-hostnames={devices.map(d => d.hostname ?? '').join(',')}
      data-display-names={devices.map(d => d.displayName ?? '').join(',')}
      data-watchdog-versions={devices.map(d => d.watchdogVersion ?? '').join(',')}
    >
      {['maintenance-on', 'maintenance-off', 'decommission', 'reboot', 'run-script', 'link-vm-host', 'wake'].map(action => (
        <button
          key={action}
          type="button"
          data-testid={`bulk-${action}`}
          onClick={() => onBulkAction?.(action, devices)}
        >
          {action}
        </button>
      ))}
      {devices.map(d => (
        <button
          key={`select-${d.id}`}
          type="button"
          data-testid={`select-${d.id}`}
          onClick={() => onSelect?.(d)}
        >
          select {d.id}
        </button>
      ))}
      {/* Drives DevicesPage.handleDeviceAction for ONE device — the row-menu /
          grid-card path, as opposed to the bulk buttons above. */}
      {devices.map(d => (
        <button
          key={`row-reboot-${d.id}`}
          type="button"
          data-testid={`row-reboot-${d.id}`}
          onClick={() => onAction?.('reboot', d)}
        >
          row reboot {d.id}
        </button>
      ))}
      {onShowDecommissioned && (
        <button
          type="button"
          data-testid="stub-show-decommissioned"
          onClick={() => onShowDecommissioned()}
        >
          show decommissioned
        </button>
      )}
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
  // Reset the network arm to ON; the flag-off case opts out explicitly.
  flagState.ENABLE_NETWORK_DEVICES_IN_LIST = true;

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
  it('passes displayName through to DeviceList without replacing hostname', async () => {
    vi.mocked(fetchAllDevices).mockResolvedValue({
      data: [{ ...rawDevice(DEV_1, 'host-alpha'), displayName: 'Reception Laptop' }],
    } as never);

    render(<DevicesPage />);

    const list = await screen.findByTestId('device-list');
    expect(list.getAttribute('data-hostnames')).toContain('host-alpha');
    expect(list.getAttribute('data-display-names')).toContain('Reception Laptop');
  });

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

  it('maps watchdogVersion from API rows into DeviceList', async () => {
    vi.mocked(fetchAllDevices).mockResolvedValueOnce({
      data: [
        { ...rawDevice(DEV_1, 'host-alpha'), watchdogVersion: '0.70.1' },
        { ...rawDevice(DEV_2, 'host-beta'), watchdogVersion: null },
      ],
    } as never);

    render(<DevicesPage />);

    const list = await screen.findByTestId('device-list');
    expect(list.getAttribute('data-watchdog-versions')).toBe('0.70.1,');
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

// The network arm is behind ENABLE_NETWORK_DEVICES_IN_LIST and OFF by default.
describe('DevicesPage — network arm disabled by default (#1322 flag)', () => {
  it('does not fetch network devices when the flag is off', async () => {
    flagState.ENABLE_NETWORK_DEVICES_IN_LIST = false;

    render(<DevicesPage />);

    // Wait for the initial load to settle (agent list renders).
    await screen.findByTestId('device-list');
    await waitFor(() => {
      expect(vi.mocked(fetchAllDevices)).toHaveBeenCalled();
    });

    // The network endpoint must never be hit when the feature is disabled.
    expect(vi.mocked(fetchAllNetworkDevices)).not.toHaveBeenCalled();
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

// #1629 follow-up: a 403 on the devices load is a permission denial, not an
// expired session. The web fetcher throws the raw Response on a non-OK status,
// so DevicesPage catches a 403 Response and must render the access-denied state
// (no misleading "session expired / try again"), not the generic error banner.
describe('DevicesPage — 403 renders access-denied (not session expired)', () => {
  it('renders AccessDenied when the devices fetch returns 403', async () => {
    const { decodeFilterFromHash } = await import('./filterUrl');
    vi.mocked(decodeFilterFromHash).mockReturnValueOnce(null);
    // fetchAllDevices throws the raw Response on a non-OK status (its contract).
    vi.mocked(fetchAllDevices).mockRejectedValueOnce(new Response(null, { status: 403 }));

    render(<DevicesPage />);

    expect(await screen.findByTestId('access-denied')).toBeTruthy();
    expect(screen.getByText('Access denied')).toBeTruthy();
    expect(screen.getByText("You don't have permission to view devices.")).toBeTruthy();
    // Must NOT show the session-expired copy or a retry on a permission denial.
    expect(screen.queryByText('Session expired')).toBeNull();
    expect(screen.queryByText('Try again')).toBeNull();
    expect(screen.queryByTestId(`device-card-${DEV_1}`)).toBeNull();
  });
});

// Regression: multi-select "Run Script" sent an EMPTY deviceIds array → the API
// rejected it with 400 "Array must contain at least one item". Root cause: the
// ScriptPickerModal called onSelect() then onClose(), and onClose
// (closeScriptPicker) reset scriptTargetDevices to [] BEFORE the confirm
// dialog's doExecuteScript read it. The selected devices must be captured into
// pendingScriptRun so execution is independent of the wiped state.
describe('DevicesPage — multi-select run script keeps its target devices', () => {
  async function renderAgentFleet() {
    const { decodeFilterFromHash } = await import('./filterUrl');
    vi.mocked(decodeFilterFromHash).mockReturnValue(null); // no advanced filter
    render(<DevicesPage />);
    const list = await screen.findByTestId('device-list');
    await waitFor(() => expect(list.getAttribute('data-device-count')).toBe('3'));
    return list;
  }

  it('executes with the originally-selected device ids, not an empty array', async () => {
    const { executeScript } = await import('../../services/deviceActions');
    vi.mocked(executeScript).mockResolvedValue({
      batchId: 'batch-1',
      scriptId: 'script-1',
      devicesTargeted: 3,
      executions: [],
      status: 'queued',
    } as never);

    await renderAgentFleet();

    // Bulk "run script" over the full fleet → opens the (stubbed) picker.
    fireEvent.click(screen.getByTestId('bulk-run-script'));
    // Selecting a script fires onSelect + onClose, then the confirm dialog shows.
    fireEvent.click(await screen.findByTestId('pick-script'));

    // The scope-confirm message is computed from pendingScriptRun.devices too —
    // a regression back to the wiped scriptTargetDevices would render
    // "0 devices". Assert the real count is shown before confirming.
    expect(await screen.findByText(/on 3 devices/i)).toBeTruthy();

    // Confirm the scope-gated run.
    fireEvent.click(await screen.findByTestId('confirm-fleet-action'));

    await waitFor(() => {
      expect(vi.mocked(executeScript)).toHaveBeenCalledTimes(1);
    });
    const [scriptId, deviceIds] = vi.mocked(executeScript).mock.calls[0];
    expect(scriptId).toBe('script-1');
    expect([...(deviceIds as string[])].sort()).toEqual([DEV_1, DEV_2, DEV_3].sort());
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

// #1424 slice 2 (follow-up): the [ All | Agent | Network ] class segment
// narrows the merged list by deviceClass. Pure client-side filter over the
// already-merged set; only shown when the network arm is enabled.
describe('DevicesPage — device class segment filter (#1424)', () => {
  const NET_3 = '66666666-6666-6666-6666-666666666666';

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

  beforeEach(() => {
    // Reset the hash so a prior test's segment choice doesn't seed this mount.
    history.replaceState(null, '', '/devices');
  });

  async function renderMixedFleet() {
    const { decodeFilterFromHash } = await import('./filterUrl');
    vi.mocked(decodeFilterFromHash).mockReturnValue(null); // no advanced filter
    vi.mocked(fetchAllNetworkDevices).mockResolvedValue({
      data: [rawNetworkDevice(NET_3, 'Lobby Printer')],
      total: 1,
      pagesWalked: 1,
    } as never);
    render(<DevicesPage />);
    const list = await screen.findByTestId('device-list');
    // 3 agent + 1 network = 4 rows in the merged "All" view.
    await waitFor(() => expect(list.getAttribute('data-device-count')).toBe('4'));
    return list;
  }

  it('shows per-segment counts (All / Agent / Network)', async () => {
    await renderMixedFleet();
    expect(screen.getByTestId('device-class-segment-all')).toHaveTextContent('4');
    expect(screen.getByTestId('device-class-segment-agent')).toHaveTextContent('3');
    expect(screen.getByTestId('device-class-segment-network')).toHaveTextContent('1');
  });

  it('narrows the list to network rows when the Network segment is chosen', async () => {
    const list = await renderMixedFleet();
    fireEvent.click(screen.getByTestId('device-class-segment-network'));
    await waitFor(() => expect(list.getAttribute('data-device-count')).toBe('1'));
  });

  it('narrows the list to agent rows when the Agent segment is chosen', async () => {
    const list = await renderMixedFleet();
    fireEvent.click(screen.getByTestId('device-class-segment-agent'));
    await waitFor(() => expect(list.getAttribute('data-device-count')).toBe('3'));
  });

  it('hides the segment entirely when the network arm is disabled', async () => {
    flagState.ENABLE_NETWORK_DEVICES_IN_LIST = false;
    const { decodeFilterFromHash } = await import('./filterUrl');
    vi.mocked(decodeFilterFromHash).mockReturnValue(null);
    render(<DevicesPage />);
    await screen.findByTestId('device-list');
    expect(screen.queryByTestId('device-class-segment')).toBeNull();
  });
});

// #1424 slice 2: selecting a row routes by deviceClass — network-discovered
// assets open the new native Devices detail page (/devices/network/:id) instead
// of bouncing out to Discovery; agent rows keep the /devices/:id route.
describe('DevicesPage — row selection routes by device class (#1424)', () => {
  const NET_2 = '55555555-5555-5555-5555-555555555555';

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

  it('routes a network row to the native /devices/network/:id detail page', async () => {
    const { decodeFilterFromHash } = await import('./filterUrl');
    vi.mocked(decodeFilterFromHash).mockReturnValue(null);
    vi.mocked(fetchAllNetworkDevices).mockResolvedValue({
      data: [rawNetworkDevice(NET_2, 'Lobby Printer')],
      total: 1,
      pagesWalked: 1,
    } as never);

    render(<DevicesPage />);
    const selectBtn = await screen.findByTestId(`select-${NET_2}`);
    fireEvent.click(selectBtn);

    expect(vi.mocked(navigateTo)).toHaveBeenCalledWith(`/devices/network/${NET_2}`);
  });

  it('routes an agent row to the /devices/:id detail page', async () => {
    const { decodeFilterFromHash } = await import('./filterUrl');
    vi.mocked(decodeFilterFromHash).mockReturnValue(null);

    render(<DevicesPage />);
    const selectBtn = await screen.findByTestId(`select-${DEV_1}`);
    fireEvent.click(selectBtn);

    expect(vi.mocked(navigateTo)).toHaveBeenCalledWith(`/devices/${DEV_1}`);
  });
});

// #2251 — decommissioned devices are hidden by default with no cue that they
// exist. The page must surface a "N decommissioned hidden — show" hint in both
// views, and "show" applies the Decommissioned status filter (the existing
// unhide mechanism — includeDecommissioned flips true when the active filter
// targets that status).
describe('DevicesPage — hidden-decommissioned hint (#2251)', () => {
  it('grid view shows the hint; clicking "show" applies the Decommissioned filter and reveals the rows', async () => {
    const { decodeFilterFromHash } = await import('./filterUrl');
    vi.mocked(decodeFilterFromHash).mockReturnValueOnce(null);
    vi.mocked(fetchAllDevices).mockResolvedValue({
      data: [
        rawDevice(DEV_1, 'host-alpha'),
        { ...rawDevice(DEV_2, 'host-beta'), status: 'decommissioned' },
        { ...rawDevice(DEV_3, 'host-gamma'), status: 'decommissioned' },
      ],
    } as never);
    // The decommissioned status filter resolves to the two decommissioned rows.
    vi.mocked(fetchWithAuth).mockImplementation(async (url: string) => {
      if (url.startsWith('/filters/preview')) {
        return jsonResponse({
          data: { totalCount: 2, deviceIds: [DEV_2, DEV_3], evaluatedAt: new Date().toISOString() },
        });
      }
      return jsonResponse({ data: [] });
    });

    render(<DevicesPage />);
    fireEvent.click(await screen.findByLabelText('Grid view'));

    // Hidden rows are called out; only the online card renders.
    const hint = await screen.findByTestId('decommissioned-hidden-hint');
    expect(hint).toHaveTextContent('2 decommissioned hidden');
    expect(screen.getByTestId(`device-card-${DEV_1}`)).toBeTruthy();
    expect(screen.queryByTestId(`device-card-${DEV_2}`)).toBeNull();

    fireEvent.click(screen.getByTestId('decommissioned-hidden-show'));

    // The status filter now targets decommissioned → those cards render, the
    // online card drops out (filtered), and the hint disappears.
    expect(await screen.findByTestId(`device-card-${DEV_2}`)).toBeTruthy();
    expect(screen.getByTestId(`device-card-${DEV_3}`)).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByTestId(`device-card-${DEV_1}`)).toBeNull();
    });
    expect(screen.queryByTestId('decommissioned-hidden-hint')).toBeNull();

    // The applied condition is the toolbar-equivalent status filter.
    const previewCall = vi.mocked(fetchWithAuth).mock.calls.find(([url]) =>
      String(url).startsWith('/filters/preview')
    );
    expect(previewCall).toBeDefined();
    const body = JSON.parse(previewCall![1]?.body as string);
    expect(body.conditions).toEqual({
      operator: 'AND',
      conditions: [{ field: 'status', operator: 'equals', value: 'decommissioned' }],
    });
  });

  it('grid view renders no hint when no decommissioned devices exist', async () => {
    const { decodeFilterFromHash } = await import('./filterUrl');
    vi.mocked(decodeFilterFromHash).mockReturnValueOnce(null);

    render(<DevicesPage />);
    fireEvent.click(await screen.findByLabelText('Grid view'));

    await screen.findByTestId(`device-card-${DEV_1}`);
    expect(screen.queryByTestId('decommissioned-hidden-hint')).toBeNull();
  });

  it('list view: onShowDecommissioned replaces an existing status value and keeps other conditions', async () => {
    const { decodeFilterFromHash, writeFilterToHash } = await import('./filterUrl');
    vi.mocked(decodeFilterFromHash).mockReturnValueOnce({
      operator: 'AND',
      conditions: [
        { field: 'os', operator: 'equals', value: 'windows' },
        { field: 'status', operator: 'equals', value: 'online' },
      ],
    });

    render(<DevicesPage />);
    const list = await screen.findByTestId('device-list');
    expect(list.getAttribute('data-include-decommissioned')).toBe('false');

    fireEvent.click(screen.getByTestId('stub-show-decommissioned'));

    // status=online is REPLACED (single-select per field, like the toolbar);
    // the os condition is preserved.
    await waitFor(() => {
      const last = vi.mocked(writeFilterToHash).mock.calls.at(-1)?.[0];
      expect(last).toEqual({
        operator: 'AND',
        conditions: [
          { field: 'os', operator: 'equals', value: 'windows' },
          { field: 'status', operator: 'equals', value: 'decommissioned' },
        ],
      });
    });
    expect(list.getAttribute('data-include-decommissioned')).toBe('true');
  });
});

// #2251 — the two trickier handleShowDecommissioned branches: an OR sentence
// from the Advanced drawer must be nested (not rewritten to AND, and the
// status condition must stay top-level where the includeDecommissioned memo
// looks), and a multi-select `in` status condition must be replaced, not
// stacked into a contradictory AND.
describe('DevicesPage — show-decommissioned filter rewrite edge cases (#2251)', () => {
  it('nests an OR group and keeps the status condition top-level', async () => {
    const { decodeFilterFromHash, writeFilterToHash } = await import('./filterUrl');
    const orGroup = {
      operator: 'OR' as const,
      conditions: [
        { field: 'os', operator: 'equals' as const, value: 'windows' },
        { field: 'os', operator: 'equals' as const, value: 'macos' },
      ],
    };
    vi.mocked(decodeFilterFromHash).mockReturnValueOnce(orGroup);

    render(<DevicesPage />);
    const list = await screen.findByTestId('device-list');
    expect(list.getAttribute('data-include-decommissioned')).toBe('false');

    fireEvent.click(screen.getByTestId('stub-show-decommissioned'));

    await waitFor(() => {
      const last = vi.mocked(writeFilterToHash).mock.calls.at(-1)?.[0];
      expect(last).toEqual({
        operator: 'AND',
        conditions: [
          orGroup,
          { field: 'status', operator: 'equals', value: 'decommissioned' },
        ],
      });
    });
    // The top-level status condition is what flips includeDecommissioned —
    // a condition buried inside the nested group would leave the rows hidden.
    expect(list.getAttribute('data-include-decommissioned')).toBe('true');
  });

  it('replaces a multi-select `in` status condition and preserves nested subgroups', async () => {
    const { decodeFilterFromHash, writeFilterToHash } = await import('./filterUrl');
    const nestedGroup = {
      operator: 'OR' as const,
      conditions: [
        { field: 'os', operator: 'equals' as const, value: 'windows' },
        { field: 'os', operator: 'equals' as const, value: 'linux' },
      ],
    };
    vi.mocked(decodeFilterFromHash).mockReturnValueOnce({
      operator: 'AND',
      conditions: [
        nestedGroup,
        { field: 'status', operator: 'in', value: ['online', 'offline'] },
      ],
    });

    render(<DevicesPage />);
    const list = await screen.findByTestId('device-list');

    fireEvent.click(screen.getByTestId('stub-show-decommissioned'));

    // A leftover `status in [...]` would AND with the new equals to an
    // always-empty result; it must be replaced. The nested subgroup survives.
    await waitFor(() => {
      const last = vi.mocked(writeFilterToHash).mock.calls.at(-1)?.[0];
      expect(last).toEqual({
        operator: 'AND',
        conditions: [
          nestedGroup,
          { field: 'status', operator: 'equals', value: 'decommissioned' },
        ],
      });
    });
    expect(list.getAttribute('data-include-decommissioned')).toBe('true');
  });
});

// -----------------------------------------------------------------------------
// vm_host bulk link chain (#2308) — the 'link-vm-host' action string is the
// contract between DeviceList's bulk menu and DevicesPage.handleBulkAction. If
// either side drifts, the menu item goes silently dead: this drives the full
// chain (action → REAL LinkVmHostModal → confirm → service call → refetch).
// -----------------------------------------------------------------------------
describe('DevicesPage — vm_host bulk link chain (#2308)', () => {
  it("handles 'link-vm-host': opens the host picker, confirms, calls the service with host + ids, refetches", async () => {
    const { linkDevicesVmHost } = await import('../../services/deviceActions');
    vi.mocked(linkDevicesVmHost).mockResolvedValue({ id: 'grp-vm' } as never);

    render(<DevicesPage />);
    await screen.findByTestId('device-list');

    fireEvent.click(screen.getByTestId('bulk-link-vm-host'));

    // The real modal (not a stub) renders over the selection.
    await screen.findByTestId('vm-host-modal');

    // Confirm is disabled until a host is picked.
    expect(screen.getByTestId('vm-host-confirm')).toBeDisabled();
    fireEvent.click(screen.getByTestId(`vm-host-option-${DEV_1}`).querySelector('input')!);

    const fetchCountBefore = vi.mocked(fetchAllDevices).mock.calls.length;
    fireEvent.click(screen.getByTestId('vm-host-confirm'));

    await waitFor(() => {
      expect(linkDevicesVmHost).toHaveBeenCalledWith(DEV_1, [DEV_1, DEV_2, DEV_3]);
    });
    // Success closes the modal and refetches the fleet.
    await waitFor(() => {
      expect(screen.queryByTestId('vm-host-modal')).toBeNull();
    });
    expect(vi.mocked(fetchAllDevices).mock.calls.length).toBeGreaterThan(fetchCountBefore);
  });

  it('surfaces a service failure as an error toast and keeps the modal open for retry', async () => {
    const { linkDevicesVmHost } = await import('../../services/deviceActions');
    const { showToast } = await import('../shared/Toast');
    vi.mocked(linkDevicesVmHost).mockRejectedValue(new Error('All linked devices must belong to the same organization'));

    render(<DevicesPage />);
    await screen.findByTestId('device-list');

    fireEvent.click(screen.getByTestId('bulk-link-vm-host'));
    await screen.findByTestId('vm-host-modal');
    fireEvent.click(screen.getByTestId(`vm-host-option-${DEV_2}`).querySelector('input')!);
    fireEvent.click(screen.getByTestId('vm-host-confirm'));

    await waitFor(() => {
      expect(vi.mocked(showToast)).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error', message: expect.stringContaining('same organization') }),
      );
    });
    // Modal stays open — the user can pick again or cancel.
    expect(screen.getByTestId('vm-host-modal')).toBeInTheDocument();
  });
});

// #2465: bulk "Reboot Selected" / "Run Script" had no device-status gate, so a
// selection containing DECOMMISSIONED devices fired agent commands the API
// refuses outright ("Cannot send commands to a decommissioned device").
//
// The gate is `decommissioned`, NOT `!== 'online'`. That distinction is the
// whole point of this suite and is easy to "fix" back into a bug: agent commands
// are QUEUED (status 'pending', no TTL) and claimed on the device's next
// check-in, so an OFFLINE device really does reboot when it comes back. Filtering
// to online-only would silently discard commands the backend would have honoured.
// The API rejects exactly one status, and these tests pin that boundary.
describe('DevicesPage — bulk agent commands gated on decommissioned only (#2465)', () => {
  // A status filter that INCLUDES decommissioned is what puts retired rows back
  // in reach of a select-all (they're hidden by default, #2251) — that's how
  // they land in a mixed batch in the first place.
  async function renderMixedFleet(ids: string[] = [DEV_1, DEV_2, DEV_3]) {
    const { decodeFilterFromHash } = await import('./filterUrl');
    vi.mocked(decodeFilterFromHash).mockReturnValue({
      operator: 'AND',
      conditions: [{ field: 'status', operator: 'in', value: ['online', 'offline', 'decommissioned'] }],
    } as never);
    vi.mocked(fetchWithAuth).mockImplementation(async (url: string) => {
      if (url.startsWith('/filters/preview')) {
        return jsonResponse({
          data: { totalCount: ids.length, deviceIds: ids, evaluatedAt: new Date().toISOString() },
        });
      }
      return jsonResponse({ data: [] });
    });
    render(<DevicesPage />);
    const list = await screen.findByTestId('device-list');
    await waitFor(() => expect(list.getAttribute('data-device-count')).toBe(String(ids.length)));
    return list;
  }

  // online + offline + decommissioned: the only selection that exercises both
  // sides of the boundary at once.
  function boundaryFleet() {
    vi.mocked(fetchAllDevices).mockResolvedValue({
      data: [
        rawDevice(DEV_1, 'host-alpha'),
        { ...rawDevice(DEV_2, 'host-beta'), status: 'offline' },
        { ...rawDevice(DEV_3, 'host-gamma'), status: 'decommissioned' },
      ],
    } as never);
  }

  it('skips ONLY the decommissioned device and still reboots the offline one', async () => {
    const { sendBulkCommand } = await import('../../services/deviceActions');
    vi.mocked(sendBulkCommand).mockResolvedValue({ commands: [{}, {}], failed: [], skipped: [] } as never);

    boundaryFleet();
    await renderMixedFleet();
    fireEvent.click(screen.getByTestId('bulk-reboot'));

    expect(await screen.findByTestId('confirm-decommissioned-skip')).toBeTruthy();
    expect(vi.mocked(sendBulkCommand)).not.toHaveBeenCalled();
    // Assert the WHOLE sentence, not just the prefix. The tail carries {{eligible}}
    // — the count of machines about to reboot. Wire that to skippedCount by mistake
    // and the dialog says "Continue with the remaining 1 device(s)?" while rebooting
    // 2; a prefix-only match would never notice.
    expect(
      screen.getByText(
        /1 of 3 selected devices are decommissioned and will be skipped.*Continue with the remaining 2 device\(s\)\?/i,
      ),
    ).toBeTruthy();

    fireEvent.click(screen.getByTestId('confirm-decommissioned-skip'));

    await waitFor(() => expect(vi.mocked(sendBulkCommand)).toHaveBeenCalledTimes(1));
    const [deviceIds, action] = vi.mocked(sendBulkCommand).mock.calls[0];
    expect(action).toBe('reboot');
    // THE load-bearing assertion. The offline device (DEV_2) MUST be targeted:
    // its command queues and runs on reconnect. A regression to an online-only
    // filter drops it here and this is the test that catches it.
    expect([...(deviceIds as string[])].sort()).toEqual([DEV_1, DEV_2].sort());
    expect(deviceIds).not.toContain(DEV_3);
  });

  it('does NOT confirm or filter when the selection is merely online + offline', async () => {
    const { sendBulkCommand } = await import('../../services/deviceActions');
    vi.mocked(sendBulkCommand).mockResolvedValue({ commands: [{}, {}], failed: [], skipped: [] } as never);

    // No decommissioned rows → nothing the API would refuse → no gate at all.
    // An offline device is a perfectly good reboot target.
    vi.mocked(fetchAllDevices).mockResolvedValue({
      data: [
        rawDevice(DEV_1, 'host-alpha'),
        { ...rawDevice(DEV_2, 'host-beta'), status: 'offline' },
      ],
    } as never);
    await renderMixedFleet([DEV_1, DEV_2]);

    fireEvent.click(screen.getByTestId('bulk-reboot'));

    await waitFor(() => expect(vi.mocked(sendBulkCommand)).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('confirm-decommissioned-skip')).toBeNull();
    expect([...(vi.mocked(sendBulkCommand).mock.calls[0][0] as string[])].sort()).toEqual(
      [DEV_1, DEV_2].sort(),
    );
  });

  it('sends nothing when the user cancels the decommissioned-skip confirm', async () => {
    const { sendBulkCommand } = await import('../../services/deviceActions');

    boundaryFleet();
    await renderMixedFleet();
    fireEvent.click(screen.getByTestId('bulk-reboot'));
    await screen.findByTestId('confirm-decommissioned-skip');

    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

    await waitFor(() => expect(screen.queryByTestId('confirm-decommissioned-skip')).toBeNull());
    expect(vi.mocked(sendBulkCommand)).not.toHaveBeenCalled();
  });

  it('refuses outright when EVERY selected device is decommissioned', async () => {
    const { sendBulkCommand } = await import('../../services/deviceActions');
    const { showToast } = await import('../shared/Toast');
    vi.mocked(fetchAllDevices).mockResolvedValue({
      data: [
        { ...rawDevice(DEV_1, 'host-alpha'), status: 'decommissioned' },
        { ...rawDevice(DEV_2, 'host-beta'), status: 'decommissioned' },
      ],
    } as never);
    await renderMixedFleet([DEV_1, DEV_2]);

    fireEvent.click(screen.getByTestId('bulk-reboot'));

    await waitFor(() => {
      const messages = vi.mocked(showToast).mock.calls.map(c => c[0].message ?? '');
      expect(messages.some(m => /all 2 selected device\(s\) are decommissioned/i.test(m))).toBe(true);
    });
    expect(screen.queryByTestId('confirm-decommissioned-skip')).toBeNull();
    expect(vi.mocked(sendBulkCommand)).not.toHaveBeenCalled();
  });

  it('narrows bulk Run Script past the decommissioned device, keeping the offline one', async () => {
    const { executeScript } = await import('../../services/deviceActions');
    vi.mocked(executeScript).mockResolvedValue({
      batchId: 'batch-1',
      scriptId: 'script-1',
      devicesTargeted: 2,
      executions: [],
      status: 'queued',
    } as never);

    boundaryFleet();
    await renderMixedFleet();
    fireEvent.click(screen.getByTestId('bulk-run-script'));

    // Skip is disclosed BEFORE the user invests in choosing a script.
    fireEvent.click(await screen.findByTestId('confirm-decommissioned-skip'));
    fireEvent.click(await screen.findByTestId('pick-script'));
    fireEvent.click(await screen.findByTestId('confirm-fleet-action'));

    await waitFor(() => expect(vi.mocked(executeScript)).toHaveBeenCalledTimes(1));
    const [, deviceIds] = vi.mocked(executeScript).mock.calls[0];
    // Offline device still gets the script — it runs on reconnect.
    expect([...(deviceIds as string[])].sort()).toEqual([DEV_1, DEV_2].sort());
  });

  // Queued commands can fire at devices with no connected agent. A 201 there
  // means "a row was inserted", NOT "the machine rebooted" — there is no dispatch
  // step, and staleCommandReaper flips it to failed ~30min later with nothing
  // notifying the user. A flat "sent" toast would therefore be a false success,
  // so the copy must name the queue.
  describe('single-device command toast tells the truth about delivery (#2630)', () => {
    async function rebootDeviceWithStatus(status: string) {
      const { sendDeviceCommand } = await import('../../services/deviceActions');
      const { showToast } = await import('../shared/Toast');
      vi.mocked(sendDeviceCommand).mockResolvedValue({ command: {} } as never);

      vi.mocked(fetchAllDevices).mockResolvedValue({
        data: [{ ...rawDevice(DEV_1, 'host-alpha'), status }],
      } as never);

      render(<DevicesPage />);
      fireEvent.click(await screen.findByTestId(`row-reboot-${DEV_1}`));

      await waitFor(() => expect(vi.mocked(sendDeviceCommand)).toHaveBeenCalledTimes(1));
      return vi.mocked(showToast).mock.calls.map(c => c[0]);
    }

    it('online device: reports the command as sent, naming the device', async () => {
      const toasts = await rebootDeviceWithStatus('online');
      const success = toasts.find(c => c.type === 'success');
      expect(success?.message).toMatch(/sent to host-alpha/i);
      expect(success?.message).not.toMatch(/queued/i);
    });

    it.each(['offline', 'maintenance', 'quarantined', 'updating', 'pending'])(
      '%s device: says QUEUED and names the reconnect condition, never a bare success',
      async (status) => {
        const toasts = await rebootDeviceWithStatus(status);
        const success = toasts.find(c => c.type === 'success');
        expect(success?.message).toMatch(/queued/i);
        expect(success?.message).toMatch(/host-alpha/);
        expect(success?.message).toMatch(/reconnect/i);
      },
    );
  });

  // Every non-decommissioned status is queueable, so ALL of them must survive the
  // gate. This is the class a future "tighten it up" change would quietly break:
  // maintenance/updating/quarantined/pending look un-runnable, but the API takes
  // their commands and the agent claims them on its next check-in. Mirrors the
  // row-menu cases in DeviceList.test.tsx.
  it.each(['maintenance', 'updating', 'quarantined', 'pending'])(
    'keeps a %s device in the batch — its command queues like any other',
    async (status) => {
      const { sendBulkCommand } = await import('../../services/deviceActions');
      vi.mocked(sendBulkCommand).mockResolvedValue({ commands: [{}, {}], failed: [], skipped: [] } as never);

      vi.mocked(fetchAllDevices).mockResolvedValue({
        data: [
          rawDevice(DEV_1, 'host-alpha'),
          { ...rawDevice(DEV_2, 'host-beta'), status },
        ],
      } as never);
      await renderMixedFleet([DEV_1, DEV_2]);

      fireEvent.click(screen.getByTestId('bulk-reboot'));

      // No confirm — nothing here is decommissioned, so nothing is being skipped.
      await waitFor(() => expect(vi.mocked(sendBulkCommand)).toHaveBeenCalledTimes(1));
      expect(screen.queryByTestId('confirm-decommissioned-skip')).toBeNull();
      expect([...(vi.mocked(sendBulkCommand).mock.calls[0][0] as string[])].sort()).toEqual(
        [DEV_1, DEV_2].sort(),
      );
    },
  );

  it('leaves bulk Wake UNGATED — it exists precisely to reach devices that are not running', async () => {
    const { sendBulkWakeCommand } = await import('../../services/deviceActions');
    vi.mocked(sendBulkWakeCommand).mockResolvedValue({ sent: [], failed: [] } as never);

    boundaryFleet();
    await renderMixedFleet();
    fireEvent.click(screen.getByTestId('bulk-wake'));

    await waitFor(() => expect(vi.mocked(sendBulkWakeCommand)).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('confirm-decommissioned-skip')).toBeNull();
    expect([...(vi.mocked(sendBulkWakeCommand).mock.calls[0][0] as string[])].sort()).toEqual(
      [DEV_1, DEV_2, DEV_3].sort(),
    );
  });

  it('sends exactly one bulk command when the confirm button is double-clicked', async () => {
    const { sendBulkCommand } = await import('../../services/deviceActions');
    vi.mocked(sendBulkCommand).mockResolvedValue({ commands: [{}], failed: [], skipped: [] } as never);

    boundaryFleet();
    await renderMixedFleet();
    fireEvent.click(screen.getByTestId('bulk-reboot'));
    const confirm = await screen.findByTestId('confirm-decommissioned-skip');

    // An impatient double-click on a bulk REBOOT must not reboot the fleet twice.
    //
    // What this actually fences: converting the dialog to a stay-mounted +
    // spinner pattern (leaning on ConfirmDialog's `disabled`, or on the
    // actionInProgress guard — which reads a stale `false` closure and cannot
    // help) lets the second click through and fires sendBulkCommand twice.
    // It does NOT discriminate the set-state-before-dispatch ORDER: under React
    // 18 both updates flush together at the end of the handler, so swapping them
    // would still pass. The unmount is the guard; the ordering is not load-bearing.
    fireEvent.click(confirm);
    fireEvent.click(confirm);

    await waitFor(() => expect(vi.mocked(sendBulkCommand)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(sendBulkCommand)).toHaveBeenCalledTimes(1);
  });
});

// The #1322 network-row filter and the #2465 decommissioned gate run back-to-back
// over the same selection and had never been exercised TOGETHER. Ordering is
// load-bearing: a network row's id is a discovered_assets.id, not a devices.id,
// and network rows carry status 'online' — so the decommissioned gate would
// happily wave one through into sendBulkCommand if the network filter stopped
// running first.
describe('DevicesPage — network filter + decommissioned gate compose (#1322 × #2465)', () => {
  const NET_1 = '44444444-4444-4444-4444-444444444444';

  async function renderFleet(count: string) {
    const { decodeFilterFromHash } = await import('./filterUrl');
    vi.mocked(decodeFilterFromHash).mockReturnValue({
      operator: 'AND',
      conditions: [{ field: 'status', operator: 'in', value: ['online', 'offline', 'decommissioned'] }],
    } as never);
    vi.mocked(fetchWithAuth).mockImplementation(async (url: string) => {
      if (url.startsWith('/filters/preview')) {
        return jsonResponse({
          data: {
            totalCount: 3,
            deviceIds: [DEV_1, DEV_2, DEV_3],
            evaluatedAt: new Date().toISOString(),
          },
        });
      }
      return jsonResponse({ data: [] });
    });
    vi.mocked(fetchAllNetworkDevices).mockResolvedValue({
      data: [{
        id: NET_1,
        deviceClass: 'network',
        assetType: 'printer',
        hostname: 'Lobby Printer',
        status: 'online', // network assets are always 'online' — and agent-less
        lastSeenAt: new Date().toISOString(),
        orgId: 'org-1',
        siteId: 'site-1',
        tags: [],
      }],
      total: 1,
      pagesWalked: 1,
    } as never);
    render(<DevicesPage />);
    const list = await screen.findByTestId('device-list');
    await waitFor(() => expect(list.getAttribute('data-device-count')).toBe(count));
  }

  it('drops the network row AND the decommissioned agent, keeping online + offline', async () => {
    const { sendBulkCommand } = await import('../../services/deviceActions');
    const { showToast } = await import('../shared/Toast');
    vi.mocked(sendBulkCommand).mockResolvedValue({ commands: [{}, {}], failed: [], skipped: [] } as never);

    vi.mocked(fetchAllDevices).mockResolvedValue({
      data: [
        rawDevice(DEV_1, 'host-alpha'),
        { ...rawDevice(DEV_2, 'host-beta'), status: 'offline' },
        { ...rawDevice(DEV_3, 'host-gamma'), status: 'decommissioned' },
      ],
    } as never);
    await renderFleet('4'); // 3 agents + 1 network row

    fireEvent.click(screen.getByTestId('bulk-reboot'));

    // Each drop is disclosed through its own channel: the network row via the
    // #1322 toast, the decommissioned agent via the #2465 confirm.
    const messages = vi.mocked(showToast).mock.calls.map(c => c[0].message ?? '');
    expect(messages.some(m => /network device.*skipped/i.test(m))).toBe(true);
    expect(await screen.findByTestId('confirm-decommissioned-skip')).toBeTruthy();
    // Denominator is the AGENT selection (3), not the raw 4 — the network row is
    // already accounted for by its own toast.
    expect(screen.getByText(/1 of 3 selected devices are decommissioned/i)).toBeTruthy();

    fireEvent.click(screen.getByTestId('confirm-decommissioned-skip'));

    await waitFor(() => expect(vi.mocked(sendBulkCommand)).toHaveBeenCalledTimes(1));
    const [deviceIds] = vi.mocked(sendBulkCommand).mock.calls[0];
    expect([...(deviceIds as string[])].sort()).toEqual([DEV_1, DEV_2].sort());
    expect(deviceIds).not.toContain(NET_1); // a printer must never be rebooted
  });
});

// The exemptions in INTENTIONALLY_UNGATED_BULK_ACTIONS are load-bearing: an
// all-offline fleet is the PRIMARY use case for decommission (retiring dead
// machines) and for maintenance flags. A future "these touch devices too, gate
// them" sweep would break exactly this.
describe('DevicesPage — ungated bulk actions still work on an all-offline fleet (#2465)', () => {
  beforeEach(() => {
    vi.mocked(fetchAllDevices).mockResolvedValue({
      data: [
        { ...rawDevice(DEV_1, 'host-alpha'), status: 'offline' },
        { ...rawDevice(DEV_2, 'host-beta'), status: 'offline' },
      ],
    } as never);
  });

  async function renderOfflineFleet() {
    const { decodeFilterFromHash } = await import('./filterUrl');
    vi.mocked(decodeFilterFromHash).mockReturnValue(null);
    render(<DevicesPage />);
    const list = await screen.findByTestId('device-list');
    await waitFor(() => expect(list.getAttribute('data-device-count')).toBe('2'));
  }

  it('decommissions every offline device — no gate, no confirm', async () => {
    const { bulkDecommissionDevices } = await import('../../services/deviceActions');
    vi.mocked(bulkDecommissionDevices).mockResolvedValue({ decommissioned: 2, failed: [] } as never);

    await renderOfflineFleet();
    fireEvent.click(screen.getByTestId('bulk-decommission'));

    await waitFor(() => expect(vi.mocked(bulkDecommissionDevices)).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('confirm-decommissioned-skip')).toBeNull();
    expect([...(vi.mocked(bulkDecommissionDevices).mock.calls[0][0] as string[])].sort()).toEqual(
      [DEV_1, DEV_2].sort(),
    );
  });

  it('flags every offline device into maintenance — no gate, no confirm', async () => {
    const { toggleMaintenanceMode } = await import('../../services/deviceActions');
    vi.mocked(toggleMaintenanceMode).mockResolvedValue({ success: true, device: {} } as never);

    await renderOfflineFleet();
    fireEvent.click(screen.getByTestId('bulk-maintenance-on'));

    await waitFor(() => expect(vi.mocked(toggleMaintenanceMode)).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId('confirm-decommissioned-skip')).toBeNull();
    expect(vi.mocked(toggleMaintenanceMode).mock.calls.map(c => c[0]).sort()).toEqual(
      [DEV_1, DEV_2].sort(),
    );
  });
});
