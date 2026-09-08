import '@/lib/i18n';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  enterMaintenanceMode: vi.fn(),
  exitMaintenanceMode: vi.fn(),
  bulkEnterMaintenanceMode: vi.fn(),
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
  // #3987: RemoveDeviceDialog fetches the env-driven drain window on open.
  fetchRemovalConfig: vi.fn(async () => ({ uninstallDrainWindowHours: 72 })),
  // #2787 bulk lifecycle.
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

// Selector-AWARE on purpose: useOrgScope (which now gates the list fetch, #4147)
// subscribes per-field via `useOrgStore(s => s.currentOrgId)`. A mock that
// ignored the selector handed each of those calls the whole state object — every
// field read back truthy, so the scope derived "resolved" by accident and any
// future gating change would have gone unnoticed here.
//
// The default scope is the EXPLICIT All-organizations one: it is resolved (so
// these tests, which are about the list itself, still fetch on mount) while
// keeping `organizations` empty and `currentOrgId` null exactly as before — the
// run-script confirm dialog names orgs from that same list. The unresolved
// first-load-after-login race has its own suite in DevicesPage.orgScope.test.tsx.
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
// A spy, not a bare stub: the modal renders null either way, so the ONLY way a
// test can observe whether runDeviceAction's `settings` branch ran is whether
// this component was invoked at all (#4014).
vi.mock('./DeviceSettingsModal', () => ({ default: vi.fn(() => null) }));
vi.mock('./AddDeviceModal', () => ({ default: () => null }));
vi.mock('./AddNetworkAssetModal', () => ({ default: () => null }));
vi.mock('./CreateGroupModal', () => ({ default: () => null }));
vi.mock('../filters/DeviceFilterBar', () => ({ DeviceFilterBar: () => null }));
vi.mock('./DeviceFilterToolbar', () => ({ DeviceFilterToolbar: () => null }));
vi.mock('../shared/ProgressBar', () => ({ default: () => null }));

// DeviceCard stub renders the hostname so the grid contents are assertable, and
// re-emits reboot + decommission so the GRID path through handleDeviceAction is
// covered too — the real DeviceCard's kebab emits both via the same
// `onAction?.(...)` calls, and the #3698/#4009 gate lives on the shared handler,
// so both surfaces inherit it.
vi.mock('./DeviceCard', () => ({
  default: ({ device, onAction }: { device: { id: string; hostname: string }; onAction?: (action: string, device: unknown) => void }) => (
    <div data-testid={`device-card-${device.id}`}>
      {device.hostname}
      {/* No text content on purpose: sibling tests assert the card's exact
          textContent equals the hostname. */}
      <button
        type="button"
        aria-label="card reboot"
        data-testid={`card-reboot-${device.id}`}
        onClick={() => onAction?.('reboot', device)}
      />
      <button
        type="button"
        aria-label="card decommission"
        data-testid={`card-decommission-${device.id}`}
        onClick={() => onAction?.('decommission', device)}
      />
      {/* The two non-confirm-gated kebab actions, so the #4014 network guard
          can be proven for an action that does NOT pass through the #4009
          confirm dialog — a guard that only held for confirm-gated actions
          would look green here while leaving run-script and settings open. */}
      <button
        type="button"
        aria-label="card run script"
        data-testid={`card-run-script-${device.id}`}
        onClick={() => onAction?.('run-script', device)}
      />
      <button
        type="button"
        aria-label="card settings"
        data-testid={`card-settings-${device.id}`}
        onClick={() => onAction?.('settings', device)}
      />
    </div>
  ),
}));

// DeviceList stub exposes which id set it was handed, and re-emits a bulk
// action over the FULL device array it was given (mirroring the real
// DeviceList, which hands the unfiltered selection to onBulkAction). Tests use
// the per-action buttons to drive DevicesPage.handleBulkAction directly.
type StubDevice = { id: string; deviceClass?: string; hostname?: string; displayName?: string; watchdogVersion?: string | null; status?: string; wanIp?: string | null; lanIp?: string | null };
vi.mock('./DeviceList', () => ({
  default: ({ devices, serverFilterIds, onBulkAction, onAction, onSelect, onShowDecommissioned, onHideDecommissioned, includeDecommissioned }: { devices: StubDevice[]; serverFilterIds?: Set<string> | null; onBulkAction?: (action: string, devices: StubDevice[]) => void; onAction?: (action: string, device: StubDevice) => void; onSelect?: (device: StubDevice) => void; onShowDecommissioned?: () => void; onHideDecommissioned?: () => void; includeDecommissioned?: boolean }) => (
    <div
      data-testid="device-list"
      data-device-count={devices.length}
      data-include-decommissioned={includeDecommissioned ? 'true' : 'false'}
      data-can-hide-decommissioned={onHideDecommissioned ? 'true' : 'false'}
      data-filter-ids={serverFilterIds ? [...serverFilterIds].sort().join(',') : ''}
      data-hostnames={devices.map(d => d.hostname ?? '').join(',')}
      data-display-names={devices.map(d => d.displayName ?? '').join(',')}
      data-watchdog-versions={devices.map(d => d.watchdogVersion ?? '').join(',')}
      data-wan-ips={devices.map(d => d.wanIp ?? '').join(',')}
      data-lan-ips={devices.map(d => d.lanIp ?? '').join(',')}
    >
      {['maintenance-on', 'maintenance-off', 'decommission', 'reboot', 'run-script', 'link-vm-host', 'wake', 'deploy-software', 'compare', 'restore', 'permanent-delete'].map(action => (
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
          grid-card path, as opposed to the bulk buttons above. The real row
          kebab emits the same three via `onAction?.(...)` from DeviceList's
          actions cell. The decommission/restore buttons are deliberately
          text-free so they cannot collide with the sibling getByText assertions
          that match on the word "decommissioned".

          Status is NOT modelled here: in the real menus `restore` renders only
          for a decommissioned device and `decommission` only for one that is
          not, so this stub proves handleDeviceAction's dispatch, never that the
          two are mutually exclusive on screen. That conditional belongs to
          DeviceList/DeviceCard's own suites. */}
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
      {devices.map(d => (
        <button
          key={`row-decommission-${d.id}`}
          type="button"
          aria-label={`row decommission ${d.id}`}
          data-testid={`row-decommission-${d.id}`}
          onClick={() => onAction?.('decommission', d)}
        />
      ))}
      {devices.map(d => (
        <button
          key={`row-restore-${d.id}`}
          type="button"
          aria-label={`row restore ${d.id}`}
          data-testid={`row-restore-${d.id}`}
          onClick={() => onAction?.('restore', d)}
        />
      ))}
      {devices.map(d => (
        <button
          key={`row-permanent-delete-${d.id}`}
          type="button"
          aria-label={`row permanent delete ${d.id}`}
          data-testid={`row-permanent-delete-${d.id}`}
          onClick={() => onAction?.('permanent-delete', d)}
        />
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
      {onHideDecommissioned && (
        <button
          type="button"
          data-testid="stub-hide-decommissioned"
          onClick={() => onHideDecommissioned()}
        >
          hide decommissioned
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

  // #2503 — the opt-in WAN/LAN IP columns read these two fields straight off
  // the Device row, so this transform is the only thing between the API
  // payload and the rendered cell. A dropped or renamed field here blanks the
  // columns fleet-wide with nothing else going red.
  it('maps wanIp/lanIp from API rows into DeviceList, degrading non-strings to null', async () => {
    vi.mocked(fetchAllDevices).mockResolvedValueOnce({
      data: [
        { ...rawDevice(DEV_1, 'host-alpha'), wanIp: '198.51.100.24', lanIp: '192.168.1.10' },
        // Never authenticated / no inventory yet: both absent from the payload.
        rawDevice(DEV_2, 'host-beta'),
        // A malformed value must degrade to null (render a dash) rather than
        // reaching the cell and being displayed as "[object Object]".
        { ...rawDevice(DEV_3, 'host-gamma'), wanIp: { nope: true }, lanIp: 42 },
      ],
    } as never);

    render(<DevicesPage />);

    const list = await screen.findByTestId('device-list');
    expect(list.getAttribute('data-wan-ips')).toBe('198.51.100.24,,');
    expect(list.getAttribute('data-lan-ips')).toBe('192.168.1.10,,');
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

// #4732: a failed /filters/preview (403 on a pinned orgId the caller can't
// access, 500, network error) must never render as a silently unfiltered
// list. useAdvancedFilterIds fails CLOSED (empty id set, `error: true`);
// these tests prove DevicesPage actually surfaces that in BOTH views, since
// only DeviceList (list view) gets an inline pill from its own suite —
// DevicesPage owns the toast (which is the ONLY signal in grid view) and the
// grid view's own persistent banner.
describe('DevicesPage — advanced filter preview failure surfaces in both views (#4732)', () => {
  function failPreview(status: number) {
    vi.mocked(fetchWithAuth).mockImplementation(async (url: string) => {
      if (url.startsWith('/filters/preview')) {
        return { ok: false, status, json: async () => ({ error: 'failed' }) } as unknown as Response;
      }
      return jsonResponse({ data: [] });
    });
  }

  it('list view: resolves to an empty (not null) id set and toasts the failure on a 403', async () => {
    const { showToast } = await import('../shared/Toast');
    failPreview(403);

    render(<DevicesPage />);

    const list = await screen.findByTestId('device-list');
    // Empty Set -> `[...set].sort().join(',')` is '' — distinguishable from
    // the "no filter" case (also '') only by the toast below firing, which
    // is exactly why `error` exists as a separate signal from `ids`.
    await waitFor(() => {
      expect(list.getAttribute('data-filter-ids')).toBe('');
    });

    await waitFor(() => {
      expect(vi.mocked(showToast)).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'error',
          message: expect.stringContaining('Advanced filter failed to load'),
        }),
      );
    });
  });

  it('grid view: renders zero cards and a persistent error banner (not just the transient toast) on a 500', async () => {
    failPreview(500);

    render(<DevicesPage />);

    const gridButton = await screen.findByLabelText('Grid view');
    fireEvent.click(gridButton);

    await waitFor(() => {
      expect(screen.getByTestId('device-filter-error-grid')).toBeTruthy();
    });
    expect(screen.queryByTestId(`device-card-${DEV_1}`)).toBeNull();
    expect(screen.queryByTestId(`device-card-${DEV_2}`)).toBeNull();
    expect(screen.queryByTestId(`device-card-${DEV_3}`)).toBeNull();
  });

  it('does not spam the toast on an unrelated re-render while the same failing filter stays active', async () => {
    const { showToast } = await import('../shared/Toast');
    failPreview(500);

    render(<DevicesPage />);
    await screen.findByTestId('device-list');

    const failureToasts = () =>
      vi.mocked(showToast).mock.calls.filter(([toast]) =>
        typeof toast.message === 'string' && toast.message.includes('Advanced filter failed to load'),
      ).length;

    await waitFor(() => expect(failureToasts()).toBe(1));

    // Toggle view mode twice (grid, then back to list) — a state change and
    // re-render on the page that does NOT touch `advancedFilter`. The error
    // toast fires once on the false->true transition only; it must not fire
    // again just because the page re-rendered for an unrelated reason.
    fireEvent.click(await screen.findByLabelText('Grid view'));
    fireEvent.click(await screen.findByLabelText('List view'));
    await screen.findByTestId('device-list');

    expect(failureToasts()).toBe(1);
  });
});

// The network arm is behind ENABLE_NETWORK_DEVICES_IN_LIST and OFF by default.
// The network arm is behind ENABLE_NETWORK_DEVICES_IN_LIST (on by default; this
// block covers the opt-out).
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
      requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      status: 'queued',
      targets: [DEV_1, DEV_2, DEV_3].map((requestedDeviceId, index) => ({
        requestedDeviceId,
        admission: 'admitted' as const,
        executionId: `execution-${index + 1}`,
      })),
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

  it('does not show a queued-success toast when a valid 201 rejects every target', async () => {
    const { executeScript } = await import('../../services/deviceActions');
    const { showToast } = await import('../shared/Toast');
    vi.mocked(executeScript).mockResolvedValue({
      requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      status: 'rejected',
      targets: [
        { requestedDeviceId: DEV_1, admission: 'suppressed', reasonCode: 'maintenance_suppressed' },
        { requestedDeviceId: DEV_2, admission: 'denied', reasonCode: 'site_access_denied' },
        { requestedDeviceId: DEV_3, admission: 'excluded', reasonCode: 'device_decommissioned' },
      ],
    } as never);

    await renderAgentFleet();
    fireEvent.click(screen.getByTestId('bulk-run-script'));
    fireEvent.click(await screen.findByTestId('pick-script'));
    fireEvent.click(await screen.findByTestId('confirm-fleet-action'));

    await waitFor(() => expect(vi.mocked(executeScript)).toHaveBeenCalledTimes(1));
    const toastTypes = vi.mocked(showToast).mock.calls.map(([toast]) => toast.type);
    expect(toastTypes).toContain('error');
    expect(toastTypes).not.toContain('success');
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
      // The discovered asset's own address (routes/devices/network.ts emits
      // `ipAddress`); the network arm renames it to lanIp — see the #2503 test.
      ipAddress: '192.168.1.55',
    };
  }

  // #2503 — the network arm is the ONLY place the `ipAddress` -> `lanIp`
  // rename happens, and the transform guards it with `typeof === 'string'`, so
  // a rename on the API side would silently blank the LAN IP column for every
  // discovered asset with nothing logged. Pin both halves: the rename, and the
  // fact that a discovered asset never claims a WAN address.
  it('maps a discovered asset ipAddress to lanIp and leaves wanIp null', async () => {
    const { decodeFilterFromHash } = await import('./filterUrl');
    vi.mocked(decodeFilterFromHash).mockReturnValue(null);
    vi.mocked(fetchAllDevices).mockResolvedValueOnce({ data: [] } as never);
    vi.mocked(fetchAllNetworkDevices).mockResolvedValue({
      data: [rawNetworkDevice(NET_1, 'Lobby Printer')],
      total: 1,
      pagesWalked: 1,
    } as never);

    render(<DevicesPage />);

    const list = await screen.findByTestId('device-list');
    await waitFor(() => {
      expect(list.getAttribute('data-device-count')).toBe('1');
    });
    expect(list.getAttribute('data-lan-ips')).toBe('192.168.1.55');
    expect(list.getAttribute('data-wan-ips')).toBe('');
  });

  // RMM-QA-176 D10: bulk `maintenance-on` no longer fires N requests from the
  // click. It opens MaintenanceModeDialog, which collects the now-REQUIRED
  // reason + duration and makes ONE call to POST /devices/bulk/maintenance
  // under ONE step-up grant. These helpers drive that dialog so the cases below
  // keep asserting the same intent against the new shape.
  async function submitMaintenanceDialog(reason = 'scheduled patching') {
    const textarea = await screen.findByTestId('maintenance-reason');
    fireEvent.change(textarea, { target: { value: reason } });
    fireEvent.click(screen.getByTestId('maintenance-submit'));
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

  // FLIPPED (RMM-QA-176). Was: 'skips the network row and only toggles
  // maintenance on the 3 agent devices' — it asserted
  // toggleMaintenanceMode toHaveBeenCalledTimes(3) and the targeted-id list of
  // the client loop. Same intent, now against the single server-side call.
  it('sends ONE bulk maintenance call carrying the 3 agent ids, never the network asset id', async () => {
    const { bulkEnterMaintenanceMode, enterMaintenanceMode } = await import('../../services/deviceActions');
    const { showToast } = await import('../shared/Toast');
    vi.mocked(bulkEnterMaintenanceMode).mockResolvedValue({
      succeeded: [DEV_1, DEV_2, DEV_3].map(deviceId => ({ deviceId, action: 'enable', maintenanceUntil: 'x' })),
      failed: [],
    } as never);

    await renderWithFleet();
    fireEvent.click(screen.getByTestId('bulk-maintenance-on'));
    await submitMaintenanceDialog();

    await waitFor(() => {
      expect(vi.mocked(bulkEnterMaintenanceMode)).toHaveBeenCalledTimes(1);
    });
    // One call for the whole set — N single-device calls would demand N
    // step-up grants and 403 on every one of them.
    expect(vi.mocked(enterMaintenanceMode)).not.toHaveBeenCalled();
    const body = vi.mocked(bulkEnterMaintenanceMode).mock.calls[0][0];
    // The network asset id must NEVER reach the maintenance endpoint.
    expect(body.deviceIds).not.toContain(NET_1);
    expect([...body.deviceIds].sort()).toEqual([DEV_1, DEV_2, DEV_3].sort());
    expect(body.reason).toBe('scheduled patching');

    // User is told the network device was skipped, then the success summary.
    const messages = vi.mocked(showToast).mock.calls.map(c => c[0].message ?? '');
    expect(messages.some(m => /network device.*skipped/i.test(m))).toBe(true);
    expect(messages.some(m => /3 devices put into maintenance mode/i.test(m))).toBe(true);
  });

  // FLIPPED (RMM-QA-176). Was: 'does not abort the batch when one agent device
  // fails mid-loop (per-item catch)'. The per-item catch is gone with the loop;
  // the server now reports per-device outcomes in `failed[]`, and the SAME
  // intent — one device's failure neither aborts the batch nor is swallowed —
  // is asserted against that list.
  it('renders the partial-failure summary from the response failed[] (a 200 is not a success)', async () => {
    const { bulkEnterMaintenanceMode } = await import('../../services/deviceActions');
    const { showToast } = await import('../shared/Toast');
    vi.mocked(bulkEnterMaintenanceMode).mockResolvedValue({
      succeeded: [DEV_2, DEV_3].map(deviceId => ({ deviceId, action: 'enable', maintenanceUntil: 'x' })),
      failed: [{ deviceId: DEV_1, code: 'STATE_CONFLICT', message: 'nope' }],
    } as never);

    await renderWithFleet();
    fireEvent.click(screen.getByTestId('bulk-maintenance-on'));
    await submitMaintenanceDialog();

    await waitFor(() => expect(vi.mocked(bulkEnterMaintenanceMode)).toHaveBeenCalledTimes(1));

    const toasts = vi.mocked(showToast).mock.calls.map(c => c[0]);
    const summary = toasts.find(x => /2 device.*maintenance mode.*1 failed/i.test(x.message ?? ''));
    expect(summary).toBeDefined();
    expect(summary!.type).toBe('error');
  });

  // The negative case that "always report success" would pass without: the
  // bulk route answers 200 with an EMPTY `succeeded` when every device fails
  // preflight. Reporting that as success would tell the technician the fleet
  // is suppressed when nothing is.
  it('reports an ALL-FAILED 200 as a failure, never as success', async () => {
    const { bulkEnterMaintenanceMode } = await import('../../services/deviceActions');
    const { showToast } = await import('../shared/Toast');
    vi.mocked(bulkEnterMaintenanceMode).mockResolvedValue({
      succeeded: [],
      failed: [DEV_1, DEV_2, DEV_3].map(deviceId => ({
        deviceId,
        code: 'DECOMMISSIONED',
        message: 'Cannot change maintenance mode for a decommissioned device.',
      })),
    } as never);

    await renderWithFleet();
    fireEvent.click(screen.getByTestId('bulk-maintenance-on'));
    await submitMaintenanceDialog();

    await waitFor(() => expect(vi.mocked(bulkEnterMaintenanceMode)).toHaveBeenCalledTimes(1));

    const afterSubmit = vi.mocked(showToast).mock.calls.map(c => c[0]);
    const allFailed = afterSubmit.find(x => /failed to update maintenance mode for all 3/i.test(x.message ?? ''));
    expect(allFailed).toBeDefined();
    expect(allFailed!.type).toBe('error');
    // And nothing anywhere claimed devices went INTO maintenance.
    expect(
      afterSubmit.some(x => x.type === 'success' && /maintenance mode/i.test(x.message ?? '')),
    ).toBe(false);
  });

  it('blocks a network-only selection from an agent-only action with a clear message', async () => {
    // Unchanged in meaning: the agent-only maintenance endpoint must not be
    // reached at all. Only the service name moved.
    const { bulkEnterMaintenanceMode } = await import('../../services/deviceActions');
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
    expect(vi.mocked(bulkEnterMaintenanceMode)).not.toHaveBeenCalled();
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
// exist. The page must surface a "N removed hidden — show" hint in both
// views. #5023 paper cut: "show" ADDS the removed rows to whatever is on
// screen (page-level showRemoved flag) instead of swapping the view to a
// removed-only status filter; the hint then flips to "N removed shown — hide".
describe('DevicesPage — hidden-decommissioned hint (#2251, #5023)', () => {
  it('grid view: "show" adds the removed cards alongside the active one, leaves the filter alone, and offers "hide"', async () => {
    const { decodeFilterFromHash, writeFilterToHash } = await import('./filterUrl');
    vi.mocked(decodeFilterFromHash).mockReturnValueOnce(null);
    vi.mocked(fetchAllDevices).mockResolvedValue({
      data: [
        rawDevice(DEV_1, 'host-alpha'),
        { ...rawDevice(DEV_2, 'host-beta'), status: 'decommissioned' },
        { ...rawDevice(DEV_3, 'host-gamma'), status: 'decommissioned' },
      ],
    } as never);

    render(<DevicesPage />);
    fireEvent.click(await screen.findByLabelText('Grid view'));

    // Hidden rows are called out; only the online card renders.
    const hint = await screen.findByTestId('decommissioned-hidden-hint');
    expect(hint).toHaveTextContent('2 removed hidden');
    expect(screen.getByTestId(`device-card-${DEV_1}`)).toBeTruthy();
    expect(screen.queryByTestId(`device-card-${DEV_2}`)).toBeNull();

    fireEvent.click(screen.getByTestId('decommissioned-hidden-show'));

    // The removed cards are ADDED — the active card stays, the hidden hint
    // gives way to the "shown — hide" line.
    expect(await screen.findByTestId(`device-card-${DEV_2}`)).toBeTruthy();
    expect(screen.getByTestId(`device-card-${DEV_3}`)).toBeTruthy();
    expect(screen.getByTestId(`device-card-${DEV_1}`)).toBeTruthy();
    expect(screen.queryByTestId('decommissioned-hidden-hint')).toBeNull();
    const shown = screen.getByTestId('decommissioned-shown-hint');
    expect(shown).toHaveTextContent('2 removed shown');

    // No filter was applied or rewritten — the advanced filter is untouched.
    expect(vi.mocked(writeFilterToHash).mock.calls.some(([f]) => f !== null)).toBe(false);
    expect(
      vi.mocked(fetchWithAuth).mock.calls.some(([url]) => String(url).startsWith('/filters/preview'))
    ).toBe(false);

    // "hide" restores the default view.
    fireEvent.click(screen.getByTestId('decommissioned-hidden-hide'));
    await waitFor(() => {
      expect(screen.queryByTestId(`device-card-${DEV_2}`)).toBeNull();
    });
    expect(screen.getByTestId(`device-card-${DEV_1}`)).toBeTruthy();
    expect(screen.getByTestId('decommissioned-hidden-hint')).toHaveTextContent('2 removed hidden');
  });

  it('grid view: the hint counts only removed devices the advanced filter admits', async () => {
    const { decodeFilterFromHash } = await import('./filterUrl');
    vi.mocked(decodeFilterFromHash).mockReturnValueOnce({
      operator: 'AND',
      conditions: [{ field: 'os', operator: 'equals', value: 'windows' }],
    });
    vi.mocked(fetchAllDevices).mockResolvedValue({
      data: [
        rawDevice(DEV_1, 'host-alpha'),
        { ...rawDevice(DEV_2, 'host-beta'), status: 'decommissioned' },
        { ...rawDevice(DEV_3, 'host-gamma'), status: 'decommissioned' },
      ],
    } as never);
    // The os filter admits the active device and ONE of the two removed ones.
    vi.mocked(fetchWithAuth).mockImplementation(async (url: string) => {
      if (url.startsWith('/filters/preview')) {
        return jsonResponse({
          data: { totalCount: 2, deviceIds: [DEV_1, DEV_2], evaluatedAt: new Date().toISOString() },
        });
      }
      return jsonResponse({ data: [] });
    });

    render(<DevicesPage />);
    fireEvent.click(await screen.findByLabelText('Grid view'));

    const hint = await screen.findByTestId('decommissioned-hidden-hint');
    await waitFor(() => expect(hint).toHaveTextContent('1 removed hidden'));

    fireEvent.click(screen.getByTestId('decommissioned-hidden-show'));
    expect(await screen.findByTestId(`device-card-${DEV_2}`)).toBeTruthy();
    // DEV_3 is excluded by the filter, not by the hidden-by-default rule.
    expect(screen.queryByTestId(`device-card-${DEV_3}`)).toBeNull();
    expect(screen.getByTestId('decommissioned-shown-hint')).toHaveTextContent('1 removed shown');
  });

  it('grid view renders no hint when no decommissioned devices exist', async () => {
    const { decodeFilterFromHash } = await import('./filterUrl');
    vi.mocked(decodeFilterFromHash).mockReturnValueOnce(null);

    render(<DevicesPage />);
    fireEvent.click(await screen.findByLabelText('Grid view'));

    await screen.findByTestId(`device-card-${DEV_1}`);
    expect(screen.queryByTestId('decommissioned-hidden-hint')).toBeNull();
  });

  it('list view: "show" flips includeDecommissioned without rewriting the existing filter; "hide" flips it back', async () => {
    const { decodeFilterFromHash, writeFilterToHash } = await import('./filterUrl');
    const existing = {
      operator: 'AND' as const,
      conditions: [
        { field: 'os', operator: 'equals' as const, value: 'windows' },
        { field: 'status', operator: 'equals' as const, value: 'online' },
      ],
    };
    vi.mocked(decodeFilterFromHash).mockReturnValueOnce(existing);

    render(<DevicesPage />);
    const list = await screen.findByTestId('device-list');
    expect(list.getAttribute('data-include-decommissioned')).toBe('false');
    expect(list.getAttribute('data-can-hide-decommissioned')).toBe('false');

    fireEvent.click(screen.getByTestId('stub-show-decommissioned'));

    await waitFor(() => {
      expect(list.getAttribute('data-include-decommissioned')).toBe('true');
    });
    expect(list.getAttribute('data-can-hide-decommissioned')).toBe('true');
    // status=online is NOT replaced — the tech's filter survives "show".
    const lastWritten = vi.mocked(writeFilterToHash).mock.calls.at(-1)?.[0];
    expect(lastWritten).toEqual(existing);

    fireEvent.click(screen.getByTestId('stub-hide-decommissioned'));
    await waitFor(() => {
      expect(list.getAttribute('data-include-decommissioned')).toBe('false');
    });
    expect(list.getAttribute('data-can-hide-decommissioned')).toBe('false');
  });

  it('list view: an explicit Decommissioned status filter shows the rows with no "hide" affordance', async () => {
    const { decodeFilterFromHash } = await import('./filterUrl');
    vi.mocked(decodeFilterFromHash).mockReturnValueOnce({
      operator: 'AND',
      conditions: [{ field: 'status', operator: 'equals', value: 'decommissioned' }],
    });

    render(<DevicesPage />);
    const list = await screen.findByTestId('device-list');
    await waitFor(() => {
      expect(list.getAttribute('data-include-decommissioned')).toBe('true');
    });
    // The filter (not the showRemoved flag) is what unhid them, so "hide"
    // would be a no-op — it must not be offered.
    expect(list.getAttribute('data-can-hide-decommissioned')).toBe('false');
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

// #2866: the bulk "Deploy software" action used to navigate to /software with
// no state — the selection was lost and the wizard started empty. It must now
// carry the selected device ids in the hash for SoftwareCatalog to consume.
describe('DevicesPage — deploy-software carries the selection via the hash (#2866)', () => {
  it('bulk action navigates to /software#deploy=<ids> with the selected agent devices', async () => {
    render(<DevicesPage />);
    await screen.findByTestId('device-list');

    fireEvent.click(screen.getByTestId('bulk-deploy-software'));

    await waitFor(() => {
      expect(vi.mocked(navigateTo)).toHaveBeenCalledWith(
        `/software#deploy=${[DEV_1, DEV_2, DEV_3].join(',')}`,
      );
    });
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
        /1 of 3 selected devices are removed and will be skipped.*Continue with the remaining 2 device\(s\)\?/i,
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

  // #5128 W2 — the bulk toast reads `queuedOffline` off the W1 response
  // shape and appends the count via `queuedOfflineTail`. Untested until now:
  // a wrong field name, an off-by-one, or a broken interpolation key would
  // ship silently, and bulk reboot of a partly-offline fleet is a core flow.
  it('bulk toast reports how many of the sent commands were queued for offline devices', async () => {
    const { sendBulkCommand } = await import('../../services/deviceActions');
    const { showToast } = await import('../shared/Toast');
    vi.mocked(sendBulkCommand).mockResolvedValue({
      commands: [{}, {}, {}],
      failed: [],
      skipped: [],
      queuedOffline: [DEV_2, DEV_3],
    } as never);

    render(<DevicesPage />);
    await screen.findByTestId('device-list');
    fireEvent.click(screen.getByTestId('bulk-reboot'));

    await waitFor(() => {
      const messages = vi.mocked(showToast).mock.calls.map(c => c[0].message ?? '');
      expect(messages.some(m => /2 queued for offline devices/i.test(m))).toBe(true);
    });
  });

  it('bulk toast omits the queued-offline clause when nothing was queued', async () => {
    const { sendBulkCommand } = await import('../../services/deviceActions');
    const { showToast } = await import('../shared/Toast');
    vi.mocked(sendBulkCommand).mockResolvedValue({
      commands: [{}, {}, {}],
      failed: [],
      skipped: [],
      queuedOffline: [],
    } as never);

    render(<DevicesPage />);
    await screen.findByTestId('device-list');
    fireEvent.click(screen.getByTestId('bulk-reboot'));

    await waitFor(() => {
      const messages = vi.mocked(showToast).mock.calls.map(c => c[0].message ?? '');
      expect(messages.some(m => /queued for offline devices/i.test(m))).toBe(false);
    });
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
      expect(messages.some(m => /all 2 selected device\(s\) are already removed/i.test(m))).toBe(true);
    });
    expect(screen.queryByTestId('confirm-decommissioned-skip')).toBeNull();
    expect(vi.mocked(sendBulkCommand)).not.toHaveBeenCalled();
  });

  it('narrows bulk Run Script past the decommissioned device, keeping the offline one', async () => {
    const { executeScript } = await import('../../services/deviceActions');
    vi.mocked(executeScript).mockResolvedValue({
      requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      status: 'queued',
      targets: [DEV_1, DEV_2].map((requestedDeviceId, index) => ({
        requestedDeviceId,
        admission: 'admitted' as const,
        executionId: `execution-${index + 1}`,
      })),
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

  // #3987 fix wave: bulk Remove ("decommission") was the one action exempted
  // from this gate — reasoning "retiring dead machines IS the use case" — which
  // is true for OFFLINE devices but not for ones that are ALREADY removed.
  // bulkDecommissionDevices fires one DELETE /devices/:id per selected device,
  // and the API 400s "Device is already decommissioned" for an already-removed
  // one, so an ungated mixed/all-removed selection fired doomed requests.
  it('bulk Remove: skips the already-removed device and still removes the offline one', async () => {
    const { bulkDecommissionDevices } = await import('../../services/deviceActions');
    vi.mocked(bulkDecommissionDevices).mockResolvedValue({ succeeded: 2, failed: [] } as never);

    boundaryFleet();
    await renderMixedFleet();
    fireEvent.click(screen.getByTestId('bulk-decommission'));

    expect(await screen.findByTestId('confirm-decommissioned-skip')).toBeTruthy();
    expect(vi.mocked(bulkDecommissionDevices)).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('confirm-decommissioned-skip'));

    // #3987: the skip gate hands off to the agent-choice dialog, which is what
    // actually fires the batch.
    fireEvent.click(await screen.findByTestId('confirm-bulk-remove'));

    await waitFor(() => expect(vi.mocked(bulkDecommissionDevices)).toHaveBeenCalledTimes(1));
    // DEV_3 (already decommissioned) must NOT be re-submitted — that's the
    // doomed request the API 400s. DEV_2 (offline) IS a legitimate target:
    // retiring a dead machine is still the use case.
    const submitted = vi.mocked(bulkDecommissionDevices).mock.calls[0][0] as Array<{ id: string; hostname: string }>;
    expect([...submitted.map(d => d.id)].sort()).toEqual([DEV_1, DEV_2].sort());
  });

  it('bulk Remove: refuses outright when EVERY selected device is already removed', async () => {
    const { bulkDecommissionDevices } = await import('../../services/deviceActions');
    const { showToast } = await import('../shared/Toast');
    vi.mocked(fetchAllDevices).mockResolvedValue({
      data: [
        { ...rawDevice(DEV_1, 'host-alpha'), status: 'decommissioned' },
        { ...rawDevice(DEV_2, 'host-beta'), status: 'decommissioned' },
      ],
    } as never);
    await renderMixedFleet([DEV_1, DEV_2]);

    fireEvent.click(screen.getByTestId('bulk-decommission'));

    await waitFor(() => {
      const messages = vi.mocked(showToast).mock.calls.map(c => c[0].message ?? '');
      expect(messages.some(m => /all 2 selected device\(s\) are already removed/i.test(m))).toBe(true);
    });
    expect(screen.queryByTestId('confirm-decommissioned-skip')).toBeNull();
    expect(vi.mocked(bulkDecommissionDevices)).not.toHaveBeenCalled();
  });

  // #3987 fix wave 2: a partial-failure batch previously collapsed into a bare
  // "Bulk Remove Failed" — the user couldn't tell how many succeeded, which
  // devices failed, or why. Assert the toast now names both counts and the
  // failed hostnames.
  it('bulk Remove: partial failure names both counts and the failed device', async () => {
    const { bulkDecommissionDevices } = await import('../../services/deviceActions');
    const { showToast } = await import('../shared/Toast');
    vi.mocked(fetchAllDevices).mockResolvedValue({
      data: [
        { ...rawDevice(DEV_1, 'host-alpha'), status: 'online' },
        { ...rawDevice(DEV_2, 'host-beta'), status: 'online' },
      ],
    } as never);
    vi.mocked(bulkDecommissionDevices).mockResolvedValue({
      succeeded: 1,
      failed: [{ id: DEV_2, hostname: 'host-beta' }],
    } as never);
    await renderMixedFleet([DEV_1, DEV_2]);

    fireEvent.click(screen.getByTestId('bulk-decommission'));
    fireEvent.click(await screen.findByTestId('confirm-bulk-remove'));

    await waitFor(() => expect(vi.mocked(bulkDecommissionDevices)).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      const messages = vi.mocked(showToast).mock.calls.map(c => c[0].message ?? '');
      expect(messages.some(m => /1/.test(m) && /host-beta/.test(m))).toBe(true);
    });
  });

  // Queued commands can fire at devices with no connected agent. A 201 there
  // means "a row was inserted", NOT "the machine rebooted" — there is no dispatch
  // step, and staleCommandReaper flips it to failed ~30min later with nothing
  // notifying the user. A flat "sent" toast would therefore be a false success,
  // so the copy must name the queue.
  describe('single-device command toast tells the truth about delivery (#2630)', () => {
    // #5128 W2 — the toast now reads the dispatch core's own `delivery`
    // outcome (and `deliverBy` for the expiry clause) off the response,
    // rather than inferring from the pre-request device.status snapshot.
    // `delivered` defaults to the device's status ONLY as a realistic stand-in
    // for what the real API would answer; a case can override it to exercise
    // the response independent of status (e.g. a device that came online
    // between page load and click).
    async function rebootDeviceWithStatus(
      status: string,
      opts: {
        delivered?: boolean;
        deliverBy?: string | null;
        // Raw override for the 'queued_live' outcome — the device IS online,
        // only the immediate socket push missed (no live session,
        // preferHeartbeat); distinct from both 'delivered' and
        // 'queued_offline'. Takes precedence over `delivered` when set.
        delivery?: 'delivered' | 'queued_offline' | 'queued_live';
      } = {},
    ) {
      const { sendDeviceCommand } = await import('../../services/deviceActions');
      const { showToast } = await import('../shared/Toast');
      const delivered = opts.delivered ?? status === 'online';
      // `?? ` would treat an explicit `deliverBy: null` override the same as
      // "not provided" (both are nullish) — check membership instead so the
      // no-expiry test case actually gets null through.
      const deliverBy = delivered ? null : ('deliverBy' in opts ? opts.deliverBy! : '2026-09-08T00:00:00.000Z');
      vi.mocked(sendDeviceCommand).mockResolvedValue({
        id: 'cmd-1',
        deviceId: DEV_1,
        type: 'reboot',
        status: 'pending',
        createdAt: '2026-09-01T00:00:00.000Z',
        delivery: opts.delivery ?? (delivered ? 'delivered' : 'queued_offline'),
        deliverBy,
      } as never);

      vi.mocked(fetchAllDevices).mockResolvedValue({
        data: [{ ...rawDevice(DEV_1, 'host-alpha'), status }],
      } as never);

      render(<DevicesPage />);
      fireEvent.click(await screen.findByTestId(`row-reboot-${DEV_1}`));

      // #3698: the row action is confirm-gated now, matching the device detail
      // page. Nothing may reach the API until the operator confirms.
      expect(vi.mocked(sendDeviceCommand)).not.toHaveBeenCalled();
      fireEvent.click(await screen.findByTestId('confirm-device-action'));

      await waitFor(() => expect(vi.mocked(sendDeviceCommand)).toHaveBeenCalledTimes(1));
      return vi.mocked(showToast).mock.calls.map(c => c[0]);
    }

    // #3698: the reason this issue existed — the list fired immediately while
    // the detail page confirmed. Pin both halves of the gate.
    it('does not queue anything until the confirm is accepted', async () => {
      const { sendDeviceCommand } = await import('../../services/deviceActions');
      vi.mocked(sendDeviceCommand).mockResolvedValue({ command: {} } as never);
      vi.mocked(fetchAllDevices).mockResolvedValue({
        data: [{ ...rawDevice(DEV_1, 'host-alpha'), status: 'online' }],
      } as never);

      render(<DevicesPage />);
      fireEvent.click(await screen.findByTestId(`row-reboot-${DEV_1}`));

      // The dialog names the machine, so a mis-click on a dense list is
      // recoverable rather than merely delayed.
      expect(await screen.findByText(/host-alpha/)).toBeTruthy();
      expect(vi.mocked(sendDeviceCommand)).not.toHaveBeenCalled();
    });

    // #3698 follow-up: the gate lives on the shared handler, so the GRID card
    // inherits it. Todd flagged this path as gated-but-untested on review.
    it('grid card reboot is confirm-gated on the same terms as the list row', async () => {
      const { sendDeviceCommand } = await import('../../services/deviceActions');
      vi.mocked(sendDeviceCommand).mockResolvedValue({ command: {} } as never);
      vi.mocked(fetchAllDevices).mockResolvedValue({
        data: [{ ...rawDevice(DEV_1, 'host-alpha'), status: 'online' }],
      } as never);

      render(<DevicesPage />);
      fireEvent.click(await screen.findByLabelText('Grid view'));
      fireEvent.click(await screen.findByTestId(`card-reboot-${DEV_1}`));

      expect(vi.mocked(sendDeviceCommand)).not.toHaveBeenCalled();
      fireEvent.click(await screen.findByTestId('confirm-device-action'));
      await waitFor(() => expect(vi.mocked(sendDeviceCommand)).toHaveBeenCalledTimes(1));
      expect(vi.mocked(sendDeviceCommand)).toHaveBeenCalledWith(DEV_1, 'reboot');
    });

    it('online device: reports the command as sent, naming the device', async () => {
      const toasts = await rebootDeviceWithStatus('online');
      const success = toasts.find(c => c.type === 'success');
      expect(success?.message).toMatch(/sent to host-alpha/i);
      expect(success?.message).not.toMatch(/runs when the device is online/i);
    });

    it.each(['offline', 'maintenance', 'quarantined', 'updating', 'pending'])(
      '%s device: reports the runs-when-online copy with its expiry, never a bare "sent"',
      async (status) => {
        const toasts = await rebootDeviceWithStatus(status);
        const success = toasts.find(c => c.type === 'success');
        expect(success?.message).toMatch(/runs when the device is online/i);
        expect(success?.message).not.toMatch(/sent to/i);
      },
    );

    // #5128 W2 regression: 'queued_live' means the device IS online — only
    // the immediate socket push missed (no live session, preferHeartbeat),
    // so the next heartbeat (seconds away) claims it. A `!== 'delivered'`
    // check would misreport this as "runs when the device is online",
    // telling the operator an online device is offline.
    it('a queued_live result (device online, immediate push missed) reports "sent", not "runs when online"', async () => {
      const toasts = await rebootDeviceWithStatus('online', { delivery: 'queued_live', deliverBy: null });
      const success = toasts.find(c => c.type === 'success');
      expect(success?.message).toMatch(/sent to host-alpha/i);
      expect(success?.message).not.toMatch(/runs when the device is online/i);
    });

    // #5128 W2 — a queued command that carries no deliverBy (a legacy row,
    // or a policy that never sets a TTL) falls back to the no-expiry copy
    // rather than rendering a literal "undefined" date.
    it('a queued command with no deliverBy omits the expiry clause', async () => {
      const toasts = await rebootDeviceWithStatus('offline', { deliverBy: null });
      const success = toasts.find(c => c.type === 'success');
      expect(success?.message).toBe('Runs when the device is online');
    });

    // `delivery` is the dispatch core's own outcome, not a re-derivation of
    // device.status — a device that reconnected between page load and click
    // must still report "sent", even though the row's cached status is stale.
    it('trusts the response delivery outcome over a stale device.status snapshot', async () => {
      const toasts = await rebootDeviceWithStatus('offline', { delivered: true });
      const success = toasts.find(c => c.type === 'success');
      expect(success?.message).toMatch(/sent to host-alpha/i);
    });
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
    // Be precise about what THIS test fences, because it is narrower than it
    // looks: it re-dispatches at a stale reference to a button already detached
    // by the first click, so the second event never reaches React's delegated
    // listener. The unmount is still the only thing it exercises. It stays
    // green with the #3705 latch reverted.
    //
    // In production the latch is the guard that matters, because it also holds
    // when the dialog STAYS mounted — see ConfirmDialog.test.tsx, which drives
    // that case directly. What neither test discriminates is the
    // set-state-before-dispatch ORDER: under React 18 both updates flush
    // together at the end of the handler, so swapping them would still pass.
    fireEvent.click(confirm);
    fireEvent.click(confirm);

    await waitFor(() => expect(vi.mocked(sendBulkCommand)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(sendBulkCommand)).toHaveBeenCalledTimes(1);
  });

  // #3705, the OTHER half of the double-click. The one above proves the same
  // button cannot fire twice. This proves the second press cannot fire
  // something ELSE: confirming tears the portal out, and in a browser that
  // press is hit-tested afterwards against whatever now occupies those
  // coordinates — the bulk bar and the device rows the dialog was centred over.
  //
  // jsdom has no layout, so it cannot pick that target itself; the test hands
  // the press to the bulk Wake button directly, which is what a browser does.
  // What is faithfully modelled is the part that matters: the press arrives
  // carrying detail === 2, because the platform click counter comes from the
  // time and distance between presses, never from the hit-test target.
  it('a double-click on confirm cannot fire an unrelated action underneath', async () => {
    const { sendDeviceCommand, sendBulkWakeCommand } = await import('../../services/deviceActions');
    vi.mocked(sendDeviceCommand).mockResolvedValue({ command: {} } as never);
    vi.mocked(sendBulkWakeCommand).mockResolvedValue({ sent: [], failed: [] } as never);
    vi.mocked(fetchAllDevices).mockResolvedValue({
      data: [{ ...rawDevice(DEV_1, 'host-alpha'), status: 'online' }],
    } as never);

    render(<DevicesPage />);
    fireEvent.click(await screen.findByTestId(`row-reboot-${DEV_1}`));

    // Press 1 of the double-click: lands on Confirm, unmounts the dialog.
    const confirmBtn = await screen.findByTestId('confirm-device-action');
    fireEvent.mouseDown(confirmBtn, { detail: 1 });
    fireEvent.mouseUp(confirmBtn, { detail: 1 });
    fireEvent.click(confirmBtn, { detail: 1 });
    await waitFor(() => expect(vi.mocked(sendDeviceCommand)).toHaveBeenCalledTimes(1));

    // Press 2, now hit-testing through to the fleet Wake the operator never
    // aimed at. Wake is deliberately UNGATED, so nothing else would stop it.
    const wake = screen.getByTestId('bulk-wake');
    fireEvent.mouseDown(wake, { detail: 2 });
    fireEvent.mouseUp(wake, { detail: 2 });
    fireEvent.click(wake, { detail: 2 });

    expect(vi.mocked(sendBulkWakeCommand)).not.toHaveBeenCalled();
    expect(vi.mocked(sendDeviceCommand)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendDeviceCommand)).toHaveBeenCalledWith(DEV_1, 'reboot');
  });
});

// #4009: `decommission` from the row kebab / grid card fired on a single click
// while the device DETAIL page had always confirmed it — the same split-brain
// #3698 set out to remove, left on the one kebab action that pulls a machine out
// of monitoring. Nothing had to be built: the dialog renderer already composes
// `deviceActions.confirm.${action}.*` and those decommission strings already
// shipped for the detail page. Only CONFIRM_REQUIRED_ACTIONS omitted the action,
// which is precisely the kind of one-token regression a test pins cheaply.
//
// Note the 5s undo toast inside runDeviceAction is NOT this gate. It is a
// post-hoc recovery window that a user who has looked away never sees, and it
// was already there while the bug was live.
describe('DevicesPage — decommission from the row/grid kebab is confirm-gated (#4009)', () => {
  beforeEach(() => {
    vi.mocked(fetchAllDevices).mockResolvedValue({
      data: [{ ...rawDevice(DEV_1, 'host-alpha'), status: 'online' }],
    } as never);
  });

  async function mockedDecommission() {
    const { decommissionDevice } = await import('../../services/deviceActions');
    vi.mocked(decommissionDevice).mockResolvedValue(undefined as never);
    return vi.mocked(decommissionDevice);
  }

  async function toastTypes(): Promise<string[]> {
    const { showToast } = await import('../shared/Toast');
    return vi.mocked(showToast).mock.calls.map(c => c[0].type);
  }

  it('row kebab opens the dialog instead of decommissioning, in the detail page\'s own words', async () => {
    const decommissionDevice = await mockedDecommission();

    render(<DevicesPage />);
    fireEvent.click(await screen.findByTestId(`row-decommission-${DEV_1}`));

    // Pre-#4009 this went straight into runDeviceAction, whose decommission
    // branch synchronously raises the undo toast and schedules the API call.
    // Neither may happen before the operator has answered.
    expect(decommissionDevice).not.toHaveBeenCalled();
    expect(await toastTypes()).not.toContain('undo');

    // The SAME component DeviceActions.tsx renders — RemoveDeviceDialog
    // (#3987) — proving the two screens still read identically. The generic
    // deviceActions.confirm.decommission.* copy this used to assert was
    // replaced by the dialog's own removeDialog.* block, which asks the agent
    // question instead of just "are you sure?"; asserting the rendered text is
    // what makes a future divergence between the two screens visible here.
    expect(await screen.findByText('Remove host-alpha?')).toBeTruthy();
    expect(screen.getByTestId('remove-choice-uninstall')).toBeChecked();

    const confirmBtn = await screen.findByTestId('confirm-device-action');
    expect(confirmBtn.textContent).toBe('Remove');
    // DeviceActions.tsx grades decommission `destructive`. ConfirmDialog encodes
    // that as a stop-octagon, not just a colour, so a drift to `warning` here
    // would visibly downgrade the severity on the denser of the two surfaces.
    expect(confirmBtn.className).toContain('bg-destructive');
  });

  it('cancelling the dialog decommissions nothing', async () => {
    const decommissionDevice = await mockedDecommission();

    render(<DevicesPage />);
    fireEvent.click(await screen.findByTestId(`row-decommission-${DEV_1}`));
    await screen.findByTestId('confirm-device-action');

    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

    await waitFor(() => expect(screen.queryByTestId('confirm-device-action')).toBeNull());
    expect(decommissionDevice).not.toHaveBeenCalled();
    expect(await toastTypes()).not.toContain('undo');
  });

  it('confirming still decommissions the device, undo window and all', async () => {
    const decommissionDevice = await mockedDecommission();

    render(<DevicesPage />);
    fireEvent.click(await screen.findByTestId(`row-decommission-${DEV_1}`));
    const confirmBtn = await screen.findByTestId('confirm-device-action');

    // Only setTimeout is faked: the undo window is a plain 5s timer inside
    // runDeviceAction, and faking Date/microtasks as well would disturb React's
    // own scheduling for the rest of this render.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      fireEvent.click(confirmBtn);
      // The decommission branch runs synchronously up to the timer, so both of
      // these are already settled: gate cleared, nothing sent yet.
      expect(await toastTypes()).toContain('undo');
      expect(decommissionDevice).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
    } finally {
      vi.useRealTimers();
    }

    expect(decommissionDevice).toHaveBeenCalledTimes(1);
    // #3987: uninstall is the web's default answer, so an untouched dialog
    // still queues the agent teardown.
    expect(decommissionDevice).toHaveBeenCalledWith(DEV_1, { uninstallAgent: true });
  });

  // The gate lives on the shared handleDeviceAction, so the grid card inherits
  // it — the same follow-up Todd flagged as gated-but-untested on #3698.
  //
  // Scope, so this is not read as a clean bill of health for the grid kebab:
  // it proves the CONFIRM gate reaches the card, nothing more. The separate
  // network-class gap this note used to flag — DeviceCard having no
  // deviceClass branch, where DeviceList swaps the whole actions cell for a
  // "View" button — was #4014 and is now fixed. Note that DeviceCard is
  // STUBBED in this file, so no test here can vet the real card's kebab; that
  // lives in DeviceCard.networkClass.test.tsx against the real component.
  it('grid card decommission is gated on the same terms as the list row', async () => {
    const decommissionDevice = await mockedDecommission();

    render(<DevicesPage />);
    fireEvent.click(await screen.findByLabelText('Grid view'));
    fireEvent.click(await screen.findByTestId(`card-decommission-${DEV_1}`));

    expect(decommissionDevice).not.toHaveBeenCalled();
    expect(await screen.findByText('Remove host-alpha?')).toBeTruthy();
  });

  // Deliberate scope boundary (#4009): `restore` is the UNDO of a decommission.
  // Gating it would put a dialog in front of the recovery path, so it stays
  // ungated — pinned here so a future "confirm every lifecycle action" sweep has
  // to argue with a test rather than quietly change the answer.
  it('restore stays ungated — it is the recovery path, not a destructive one', async () => {
    const { restoreDevice } = await import('../../services/deviceActions');
    vi.mocked(restoreDevice).mockResolvedValue(undefined as never);

    render(<DevicesPage />);
    fireEvent.click(await screen.findByTestId(`row-restore-${DEV_1}`));

    await waitFor(() => expect(vi.mocked(restoreDevice)).toHaveBeenCalledWith(DEV_1));
    expect(screen.queryByTestId('confirm-device-action')).toBeNull();
  });
});

// #4014: the SINGLE-device funnel had no network guard. `handleBulkAction` has
// dropped network rows since #1322, but `handleDeviceAction` — the shared entry
// point behind the list kebab, the grid card and DeviceSettingsModal — took any
// device it was handed. The real DeviceCard (stubbed in this file) had no
// deviceClass branch at all, so the grid kebab offered Terminal / Run Script /
// Reboot / Settings / Remove for a network-discovered asset, whose id is
// a `discovered_assets.id` and NOT a `devices.id`. The card now collapses to a
// "View" button (pinned against the real component in
// DeviceCard.networkClass.test.tsx); this pins the handler's backstop, so a
// future surface that wires `onAction` cannot silently re-open the hole.
describe('DevicesPage — single-device actions refuse network rows (#4014)', () => {
  const NET_1 = '44444444-4444-4444-4444-444444444444';

  beforeEach(async () => {
    const { decodeFilterFromHash } = await import('./filterUrl');
    vi.mocked(decodeFilterFromHash).mockReturnValue(null); // no advanced filter
    vi.mocked(fetchAllDevices).mockResolvedValue({ data: [] } as never);
    vi.mocked(fetchAllNetworkDevices).mockResolvedValue({
      data: [{
        id: NET_1,
        deviceClass: 'network',
        assetType: 'printer',
        hostname: 'Lobby Printer',
        status: 'online',
        lastSeenAt: new Date().toISOString(),
        orgId: 'org-1',
        siteId: 'site-1',
        tags: [],
        ipAddress: '192.168.1.55',
      }],
      total: 1,
      pagesWalked: 1,
    } as never);
  });

  async function toastMessages(): Promise<string[]> {
    const { showToast } = await import('../shared/Toast');
    return vi.mocked(showToast).mock.calls.map(c => c[0].message ?? '');
  }

  it('refuses reboot from the grid card — no command queued on the asset id', async () => {
    const { sendDeviceCommand } = await import('../../services/deviceActions');

    render(<DevicesPage />);
    fireEvent.click(await screen.findByLabelText('Grid view'));
    fireEvent.click(await screen.findByTestId(`card-reboot-${NET_1}`));

    await waitFor(async () => {
      expect(await toastMessages()).toContainEqual(
        expect.stringMatching(/applies to agent devices only/i)
      );
    });
    expect(vi.mocked(sendDeviceCommand)).not.toHaveBeenCalled();
    // Refused outright, NOT merely put behind the #4009 confirm dialog — a
    // dialog here would still end in a 404 once the operator said yes.
    expect(screen.queryByTestId('confirm-device-action')).toBeNull();
  });

  it('refuses decommission from the grid card — no undo toast, no DELETE', async () => {
    const { decommissionDevice } = await import('../../services/deviceActions');
    const { showToast } = await import('../shared/Toast');

    render(<DevicesPage />);
    fireEvent.click(await screen.findByLabelText('Grid view'));
    fireEvent.click(await screen.findByTestId(`card-decommission-${NET_1}`));

    await waitFor(async () => {
      expect(await toastMessages()).toContainEqual(
        expect.stringMatching(/applies to agent devices only/i)
      );
    });
    expect(vi.mocked(decommissionDevice)).not.toHaveBeenCalled();
    expect(screen.queryByTestId('confirm-device-action')).toBeNull();
    // runDeviceAction's decommission branch raises the 5s undo toast the moment
    // it is entered, so its absence proves the branch was never reached.
    expect(vi.mocked(showToast).mock.calls.map(c => c[0].type)).not.toContain('undo');
  });

  it('refuses the same action from the list row kebab (one guard, both surfaces)', async () => {
    const { sendDeviceCommand } = await import('../../services/deviceActions');

    render(<DevicesPage />);
    fireEvent.click(await screen.findByTestId(`row-reboot-${NET_1}`));

    await waitFor(async () => {
      expect(await toastMessages()).toContainEqual(
        expect.stringMatching(/applies to agent devices only/i)
      );
    });
    expect(vi.mocked(sendDeviceCommand)).not.toHaveBeenCalled();
  });

  // The guard is a single early return with no per-action branching, but it
  // sits in front of BOTH the confirm-gated and the ungated paths. reboot and
  // decommission above only exercise the confirm-gated one; these two prove the
  // ungated actions (which reach runDeviceAction directly) are refused as well.
  it('refuses run-script — the script picker never opens on an asset id', async () => {
    render(<DevicesPage />);
    fireEvent.click(await screen.findByLabelText('Grid view'));
    fireEvent.click(await screen.findByTestId(`card-run-script-${NET_1}`));

    await waitFor(async () => {
      expect(await toastMessages()).toContainEqual(
        expect.stringMatching(/applies to agent devices only/i)
      );
    });
    expect(screen.queryByTestId('pick-script')).toBeNull();
  });

  it('refuses settings — the device settings modal never opens on an asset id', async () => {
    const settingsModal = await import('./DeviceSettingsModal');
    const settingsSpy = vi.mocked(settingsModal.default);

    render(<DevicesPage />);
    fireEvent.click(await screen.findByLabelText('Grid view'));
    fireEvent.click(await screen.findByTestId(`card-settings-${NET_1}`));

    await waitFor(async () => {
      expect(await toastMessages()).toContainEqual(
        expect.stringMatching(/applies to agent devices only/i)
      );
    });
    // DeviceSettingsModal is only rendered once settingsDevice is set, which
    // only runDeviceAction's `settings` branch does.
    expect(settingsSpy).not.toHaveBeenCalled();
  });

  it('still runs the action for an agent row (the guard is not a blanket block)', async () => {
    const { sendDeviceCommand } = await import('../../services/deviceActions');
    vi.mocked(sendDeviceCommand).mockResolvedValue(undefined as never);
    vi.mocked(fetchAllDevices).mockResolvedValue({
      data: [{ ...rawDevice(DEV_1, 'host-alpha'), status: 'online' }],
    } as never);

    render(<DevicesPage />);
    fireEvent.click(await screen.findByLabelText('Grid view'));
    fireEvent.click(await screen.findByTestId(`card-reboot-${DEV_1}`));

    // reboot is confirm-gated (#4009), so the dialog is the correct next step.
    fireEvent.click(await screen.findByTestId('confirm-device-action'));
    await waitFor(() => {
      expect(vi.mocked(sendDeviceCommand)).toHaveBeenCalledWith(DEV_1, 'reboot');
    });
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
    expect(screen.getByText(/1 of 3 selected devices are removed/i)).toBeTruthy();

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

  it('decommissions every offline device — no skip gate', async () => {
    const { bulkDecommissionDevices } = await import('../../services/deviceActions');
    vi.mocked(bulkDecommissionDevices).mockResolvedValue({ succeeded: 2, failed: [] } as never);

    await renderOfflineFleet();
    fireEvent.click(screen.getByTestId('bulk-decommission'));

    // #3987: the agent-choice dialog is NOT the #2465 skip gate — it asks what
    // to do with the agent, it does not drop devices from the batch. The
    // exemption this test pins is the absence of `confirm-decommissioned-skip`.
    fireEvent.click(await screen.findByTestId('confirm-bulk-remove'));

    await waitFor(() => expect(vi.mocked(bulkDecommissionDevices)).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('confirm-decommissioned-skip')).toBeNull();
    const submitted = vi.mocked(bulkDecommissionDevices).mock.calls[0][0] as Array<{ id: string; hostname: string }>;
    expect([...submitted.map(d => d.id)].sort()).toEqual([DEV_1, DEV_2].sort());
  });

  // FLIPPED (RMM-QA-176): the loop became one bulk call. The property under
  // test is unchanged — no decommissioned-skip confirm gates an offline fleet,
  // and both offline devices are targeted.
  it('flags every offline device into maintenance — no decommissioned-skip gate', async () => {
    const { bulkEnterMaintenanceMode } = await import('../../services/deviceActions');
    vi.mocked(bulkEnterMaintenanceMode).mockResolvedValue({
      succeeded: [DEV_1, DEV_2].map(deviceId => ({ deviceId, action: 'enable', maintenanceUntil: 'x' })),
      failed: [],
    } as never);

    await renderOfflineFleet();
    fireEvent.click(screen.getByTestId('bulk-maintenance-on'));
    expect(screen.queryByTestId('confirm-decommissioned-skip')).toBeNull();

    const textarea = await screen.findByTestId('maintenance-reason');
    fireEvent.change(textarea, { target: { value: 'scheduled patching' } });
    fireEvent.click(screen.getByTestId('maintenance-submit'));

    await waitFor(() => expect(vi.mocked(bulkEnterMaintenanceMode)).toHaveBeenCalledTimes(1));
    expect([...vi.mocked(bulkEnterMaintenanceMode).mock.calls[0][0].deviceIds].sort()).toEqual(
      [DEV_1, DEV_2].sort(),
    );
  });
});

// Compare bulk action — pure navigation, not an agent command. The 'compare'
// action string is the contract between DeviceList's bulk menu and
// DevicesPage.handleBulkAction (same drift risk as 'link-vm-host' above).
describe('DevicesPage — compare bulk action navigates with selected ids', () => {
  it("handles 'compare': navigates to /devices/compare?ids= without any agent call", async () => {
    render(<DevicesPage />);
    await screen.findByTestId('device-list');

    fireEvent.click(screen.getByTestId('bulk-compare'));

    expect(vi.mocked(navigateTo)).toHaveBeenCalledWith(
      `/devices/compare?ids=${DEV_1},${DEV_2},${DEV_3}`,
    );
    // Navigation only — nothing queued against the agents.
    const { sendBulkCommand } = await import('../../services/deviceActions');
    expect(vi.mocked(sendBulkCommand)).not.toHaveBeenCalled();
  });

  it('drops network rows from the compare link (their ids are asset ids)', async () => {
    const NET_1 = '44444444-4444-4444-4444-444444444444';
    vi.mocked(fetchAllNetworkDevices).mockResolvedValue({
      data: [{
        id: NET_1,
        deviceClass: 'network',
        assetType: 'printer',
        hostname: 'lobby-printer',
        status: 'online',
        lastSeenAt: new Date().toISOString(),
        orgId: 'org-1',
        siteId: 'site-1',
        tags: [],
      }],
      total: 1,
      pagesWalked: 1,
    } as never);

    render(<DevicesPage />);
    await screen.findByTestId('device-list');
    await waitFor(() =>
      expect(screen.getByTestId('device-list').getAttribute('data-device-count')).toBe('4'),
    );

    fireEvent.click(screen.getByTestId('bulk-compare'));

    const url = vi.mocked(navigateTo).mock.calls.at(-1)?.[0] as string;
    expect(url.startsWith('/devices/compare?ids=')).toBe(true);
    expect(url).not.toContain(NET_1);
    expect(url).toContain(DEV_1);

    const { showToast } = await import('../shared/Toast');
    expect(vi.mocked(showToast)).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'warning' }),
    );
  });

  it('refuses to navigate when fewer than 2 agent devices survive the network filter', async () => {
    const NET_1 = '44444444-4444-4444-4444-444444444444';
    // 1 agent + 1 network row: passes DeviceList's 2-4 menu gate, but only one
    // comparable device remains after the filter — a 1-device "comparison".
    vi.mocked(fetchAllDevices).mockResolvedValue({
      data: [rawDevice(DEV_1, 'host-alpha')],
    } as never);
    vi.mocked(fetchAllNetworkDevices).mockResolvedValue({
      data: [{
        id: NET_1,
        deviceClass: 'network',
        assetType: 'printer',
        hostname: 'lobby-printer',
        status: 'online',
        lastSeenAt: new Date().toISOString(),
        orgId: 'org-1',
        siteId: 'site-1',
        tags: [],
      }],
      total: 1,
      pagesWalked: 1,
    } as never);

    render(<DevicesPage />);
    await screen.findByTestId('device-list');
    await waitFor(() =>
      expect(screen.getByTestId('device-list').getAttribute('data-device-count')).toBe('2'),
    );

    fireEvent.click(screen.getByTestId('bulk-compare'));

    expect(vi.mocked(navigateTo)).not.toHaveBeenCalled();
    const { showToast } = await import('../shared/Toast');
    expect(vi.mocked(showToast)).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', message: expect.stringContaining('at least 2') }),
    );
  });
});

// #4368 was "surface the API's `warning` when the agent could not be reached
// for remote uninstall". #2787 DELETED that warning: the best-effort WS
// uninstall it described is gone, and permanent delete now REFUSES
// (409 UNINSTALL_PENDING) while a durable agent uninstall is still
// collectable, rather than deleting the device and hoping. So there is no
// warning to surface any more, and the toast is unconditionally the success
// one. What is pinned here is that the branch really is gone — not that it
// happens not to fire for the bodies the API sends today.
describe('DevicesPage — permanent delete toasts success, with no warning branch (#2787, was #4368)', () => {
  beforeEach(() => {
    vi.mocked(fetchAllDevices).mockResolvedValue({
      data: [{ ...rawDevice(DEV_1, 'host-alpha'), status: 'decommissioned' }],
    } as never);
  });

  async function runPermanentDelete() {
    render(<DevicesPage />);
    fireEvent.click(await screen.findByTestId(`row-permanent-delete-${DEV_1}`));
    // #5023: the kebab only opens the confirm now — the delete and its undo
    // window start from the dialog.
    const confirmBtn = await screen.findByTestId('confirm-device-action');

    // Only setTimeout is faked, and fake timers must be installed BEFORE the
    // confirm — the 5s undo-window timer is scheduled synchronously inside the
    // handler, so installing fake timers after it would leave it running on
    // the real clock.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      fireEvent.click(confirmBtn);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
    } finally {
      vi.useRealTimers();
    }
  }

  it('shows a success toast for the plain { success: true } body the API now returns', async () => {
    const { permanentDeleteDevice } = await import('../../services/deviceActions');
    const { showToast } = await import('../shared/Toast');
    vi.mocked(permanentDeleteDevice).mockResolvedValue({ success: true });

    await runPermanentDelete();

    const calls = vi.mocked(showToast).mock.calls.map(c => c[0]);
    expect(calls).toContainEqual(
      expect.objectContaining({ type: 'success', message: expect.stringContaining('host-alpha') }),
    );
    expect(calls.some(c => c.type === 'warning')).toBe(false);
  });

  /**
   * The DISCRIMINATING half. Feeding a body that still carries the retired
   * `warning` field proves the branch was removed rather than merely being
   * unreachable with today's payloads — a dead `if` would resurrect the
   * warning toast here and claim an uninstall attempt that no longer exists.
   */
  it('ignores a stray legacy `warning` field instead of resurrecting the old toast', async () => {
    const { permanentDeleteDevice } = await import('../../services/deviceActions');
    const { showToast } = await import('../shared/Toast');
    vi.mocked(permanentDeleteDevice).mockResolvedValue({
      success: true,
      warning: 'The agent could not be reached for remote uninstall.',
    } as never);

    await runPermanentDelete();

    const calls = vi.mocked(showToast).mock.calls.map(c => c[0]);
    expect(calls.some(c => c.type === 'warning')).toBe(false);
    expect(calls).toContainEqual(expect.objectContaining({ type: 'success' }));
  });

  // Paper cut: the undo toast shown the instant the delete is triggered never
  // named which device was being deleted (locale value was the untranslated
  // "Permanent Deleting" constant, with no {{hostname}} interpolation).
  it('names the device in the initial undo toast', async () => {
    const { showToast } = await import('../shared/Toast');

    render(<DevicesPage />);
    fireEvent.click(await screen.findByTestId(`row-permanent-delete-${DEV_1}`));
    fireEvent.click(await screen.findByTestId('confirm-device-action'));

    const calls = vi.mocked(showToast).mock.calls.map(c => c[0]);
    expect(calls).toContainEqual(
      expect.objectContaining({
        type: 'undo',
        message: expect.stringContaining('host-alpha'),
      }),
    );
  });
});

// #3987 items 2 + 6: every Remove surface asks what should happen to the agent
// and forwards the answer to the API. Before this, the web issued a bodyless
// DELETE, so `uninstallAgent` defaulted to false server-side and every removed
// machine kept a zombie agent heartbeating into a 403.
describe('DevicesPage — Remove asks about the agent (#3987)', () => {
  it('single Remove from the row kebab defaults to uninstall and sends uninstallAgent: true', async () => {
    const { decommissionDevice } = await import('../../services/deviceActions');
    vi.mocked(decommissionDevice).mockResolvedValue({ success: true } as never);
    vi.mocked(fetchAllDevices).mockResolvedValue({
      data: [{ ...rawDevice(DEV_1, 'host-alpha'), status: 'online' }],
    } as never);

    render(<DevicesPage />);
    fireEvent.click(await screen.findByTestId(`row-decommission-${DEV_1}`));

    const uninstallRadio = await screen.findByTestId('remove-choice-uninstall');
    expect(uninstallRadio).toBeChecked();

    // Only setTimeout is faked — the 5s undo window is a plain timer inside
    // runDeviceAction (see the #4009 describe above for why not Date).
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      fireEvent.click(screen.getByTestId('confirm-device-action'));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
    } finally {
      vi.useRealTimers();
    }

    await waitFor(() =>
      expect(vi.mocked(decommissionDevice)).toHaveBeenCalledWith(DEV_1, { uninstallAgent: true }),
    );
  });

  it('single Remove forwards uninstallAgent: false when the operator leaves the agent', async () => {
    const { decommissionDevice } = await import('../../services/deviceActions');
    vi.mocked(decommissionDevice).mockResolvedValue({ success: true } as never);
    vi.mocked(fetchAllDevices).mockResolvedValue({
      data: [{ ...rawDevice(DEV_1, 'host-alpha'), status: 'online' }],
    } as never);

    render(<DevicesPage />);
    fireEvent.click(await screen.findByTestId(`row-decommission-${DEV_1}`));
    fireEvent.click(await screen.findByTestId('remove-choice-leave'));

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      fireEvent.click(screen.getByTestId('confirm-device-action'));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
    } finally {
      vi.useRealTimers();
    }

    await waitFor(() =>
      expect(vi.mocked(decommissionDevice)).toHaveBeenCalledWith(DEV_1, { uninstallAgent: false }),
    );
  });

  it('bulk Remove asks once and forwards the one choice to bulkDecommissionDevices', async () => {
    const { bulkDecommissionDevices } = await import('../../services/deviceActions');
    vi.mocked(bulkDecommissionDevices).mockResolvedValue({ succeeded: 2, failed: [] } as never);
    vi.mocked(fetchAllDevices).mockResolvedValue({
      data: [
        { ...rawDevice(DEV_1, 'host-alpha'), status: 'online' },
        { ...rawDevice(DEV_2, 'host-beta'), status: 'offline' },
      ],
    } as never);
    const { decodeFilterFromHash } = await import('./filterUrl');
    vi.mocked(decodeFilterFromHash).mockReturnValue(null);

    render(<DevicesPage />);
    const list = await screen.findByTestId('device-list');
    await waitFor(() => expect(list.getAttribute('data-device-count')).toBe('2'));

    fireEvent.click(screen.getByTestId('bulk-decommission'));

    // One dialog for the whole selection, bucketed online vs not-currently-online.
    expect(await screen.findByText('Remove 2 devices?')).toBeTruthy();
    expect(screen.getByTestId('remove-dialog-summary').textContent)
      .toBe('1 online, 1 not currently online.');
    expect(vi.mocked(bulkDecommissionDevices)).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('remove-choice-leave'));
    fireEvent.click(screen.getByTestId('confirm-bulk-remove'));

    await waitFor(() => expect(vi.mocked(bulkDecommissionDevices)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(bulkDecommissionDevices).mock.calls[0][1]).toEqual({ uninstallAgent: false });
  });
});

// ---------------------------------------------------------------------------
// #2787 — bulk Restore + async bulk Delete permanently
// ---------------------------------------------------------------------------
describe('DevicesPage — bulk restore and bulk permanent delete (#2787)', () => {
  const removedFleet = () =>
    ({
      data: [
        { ...rawDevice(DEV_1, 'host-alpha'), status: 'decommissioned' },
        { ...rawDevice(DEV_2, 'host-beta'), status: 'decommissioned' },
      ],
    }) as never;

  async function renderWithRemovedFleet() {
    vi.mocked(fetchAllDevices).mockResolvedValue(removedFleet());
    const { decodeFilterFromHash } = await import('./filterUrl');
    vi.mocked(decodeFilterFromHash).mockReturnValue(null);
    render(<DevicesPage />);
    const list = await screen.findByTestId('device-list');
    await waitFor(() => expect(list.getAttribute('data-device-count')).toBe('2'));
  }

  it('bulk Restore calls bulkRestoreDevices with the selected ids and toasts success', async () => {
    const { bulkRestoreDevices } = await import('../../services/deviceActions');
    const { showToast } = await import('../shared/Toast');
    vi.mocked(bulkRestoreDevices).mockResolvedValue({
      succeeded: [
        { deviceId: DEV_1, uninstallAlreadyDispatched: false },
        { deviceId: DEV_2, uninstallAlreadyDispatched: false },
      ],
      failed: [],
    });

    await renderWithRemovedFleet();
    fireEvent.click(screen.getByTestId('bulk-restore'));

    await waitFor(() => expect(vi.mocked(bulkRestoreDevices)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(bulkRestoreDevices).mock.calls[0]![0]).toEqual([DEV_1, DEV_2]);
    await waitFor(() =>
      expect(vi.mocked(showToast)).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'success', message: '2 device(s) restored' }),
      ),
    );
  });

  it('warns separately when a restored device had already received its uninstall', async () => {
    const { bulkRestoreDevices } = await import('../../services/deviceActions');
    const { showToast } = await import('../shared/Toast');
    vi.mocked(bulkRestoreDevices).mockResolvedValue({
      succeeded: [
        { deviceId: DEV_1, uninstallAlreadyDispatched: true },
        { deviceId: DEV_2, uninstallAlreadyDispatched: false },
      ],
      failed: [],
    });

    await renderWithRemovedFleet();
    fireEvent.click(screen.getByTestId('bulk-restore'));

    // The device row came back, but the MACHINE may already be wiped — a
    // success toast alone would tell the operator everything is fine.
    await waitFor(() =>
      expect(vi.mocked(showToast)).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'warning', message: expect.stringContaining('reinstalled') }),
      ),
    );
  });

  it('reports a partial bulk-restore failure as an error, not a success', async () => {
    const { bulkRestoreDevices } = await import('../../services/deviceActions');
    const { showToast } = await import('../shared/Toast');
    vi.mocked(bulkRestoreDevices).mockResolvedValue({
      succeeded: [{ deviceId: DEV_1, uninstallAlreadyDispatched: false }],
      failed: [{ deviceId: DEV_2, code: 'NOT_REMOVED', message: 'nope' }],
    });

    await renderWithRemovedFleet();
    fireEvent.click(screen.getByTestId('bulk-restore'));

    await waitFor(() =>
      expect(vi.mocked(showToast)).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error', message: '1 device(s) restored; 1 failed' }),
      ),
    );
  });

  it('bulk Delete permanently confirms with a typed count, then polls the run to completion', async () => {
    const { startBulkPurge, fetchPurgeRun } = await import('../../services/deviceActions');
    const { showToast } = await import('../shared/Toast');
    vi.mocked(startBulkPurge).mockResolvedValue({ jobId: 'job-1', accepted: 2, rejected: [] });
    vi.mocked(fetchPurgeRun)
      .mockResolvedValueOnce({
        state: 'active',
        progress: { done: 1, total: 2 },
        result: null,
        failedReason: null,
      })
      .mockResolvedValue({
        state: 'completed',
        progress: { done: 2, total: 2 },
        result: { purged: [DEV_1, DEV_2], skipped: [] },
        failedReason: null,
      });

    await renderWithRemovedFleet();
    const fetchesBefore = vi.mocked(fetchAllDevices).mock.calls.length;

    fireEvent.click(screen.getByTestId('bulk-permanent-delete'));

    // Nothing is started by opening the dialog.
    expect(await screen.findByTestId('bulk-purge-count')).toBeInTheDocument();
    expect(vi.mocked(startBulkPurge)).not.toHaveBeenCalled();

    fireEvent.change(screen.getByTestId('bulk-purge-count'), { target: { value: '2' } });

    // Fake timers must be installed BEFORE the confirm: runBulkPurge schedules
    // the FIRST poll tick synchronously after startBulkPurge resolves, and a
    // tick scheduled on the real clock is invisible to advanceTimersByTime.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      fireEvent.click(screen.getByTestId('confirm-bulk-purge'));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(vi.mocked(startBulkPurge)).toHaveBeenCalledWith([DEV_1, DEV_2]);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
    } finally {
      vi.useRealTimers();
    }

    await waitFor(() =>
      expect(vi.mocked(showToast)).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'success', message: '2 device(s) permanently deleted' }),
      ),
    );
    // The purged rows must leave the list; without a refetch they linger and
    // the next action against them 404s.
    await waitFor(() =>
      expect(vi.mocked(fetchAllDevices).mock.calls.length).toBeGreaterThan(fetchesBefore),
    );
  });

  it('surfaces a whole-selection rejection and never starts polling', async () => {
    const { startBulkPurge, fetchPurgeRun } = await import('../../services/deviceActions');
    const { showToast } = await import('../shared/Toast');
    vi.mocked(startBulkPurge).mockRejectedValue(
      new Error('No selected device can be permanently deleted'),
    );

    await renderWithRemovedFleet();
    fireEvent.click(screen.getByTestId('bulk-permanent-delete'));
    fireEvent.change(await screen.findByTestId('bulk-purge-count'), { target: { value: '2' } });
    fireEvent.click(screen.getByTestId('confirm-bulk-purge'));

    await waitFor(() =>
      expect(vi.mocked(showToast)).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'error',
          message: 'No selected device can be permanently deleted',
        }),
      ),
    );
    expect(vi.mocked(fetchPurgeRun)).not.toHaveBeenCalled();
  });

  it('reports a failed run with the reason instead of a silent stall', async () => {
    const { startBulkPurge, fetchPurgeRun } = await import('../../services/deviceActions');
    const { showToast } = await import('../shared/Toast');
    vi.mocked(startBulkPurge).mockResolvedValue({ jobId: 'job-2', accepted: 2, rejected: [] });
    vi.mocked(fetchPurgeRun).mockResolvedValue({
      state: 'failed',
      progress: { done: 0, total: 2 },
      result: null,
      failedReason: 'Redis went away',
    });

    await renderWithRemovedFleet();
    fireEvent.click(screen.getByTestId('bulk-permanent-delete'));
    fireEvent.change(await screen.findByTestId('bulk-purge-count'), { target: { value: '2' } });

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      fireEvent.click(screen.getByTestId('confirm-bulk-purge'));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(vi.mocked(startBulkPurge)).toHaveBeenCalled();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
    } finally {
      vi.useRealTimers();
    }

    await waitFor(() =>
      expect(vi.mocked(showToast)).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error', message: expect.stringContaining('Redis went away') }),
      ),
    );
  });

  it('names the skipped devices when a run completes with refusals', async () => {
    const { startBulkPurge, fetchPurgeRun } = await import('../../services/deviceActions');
    const { showToast } = await import('../shared/Toast');
    vi.mocked(startBulkPurge).mockResolvedValue({ jobId: 'job-3', accepted: 2, rejected: [] });
    vi.mocked(fetchPurgeRun).mockResolvedValue({
      state: 'completed',
      progress: { done: 2, total: 2 },
      result: {
        purged: [DEV_1],
        skipped: [{ deviceId: DEV_2, code: 'UNINSTALL_PENDING' }],
      },
      failedReason: null,
    });

    await renderWithRemovedFleet();
    fireEvent.click(screen.getByTestId('bulk-permanent-delete'));
    fireEvent.change(await screen.findByTestId('bulk-purge-count'), { target: { value: '2' } });

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      fireEvent.click(screen.getByTestId('confirm-bulk-purge'));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(vi.mocked(startBulkPurge)).toHaveBeenCalled();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
    } finally {
      vi.useRealTimers();
    }

    // A bare "1 deleted" would hide the refusal entirely — the operator would
    // never learn that a device is waiting on an agent uninstall.
    await waitFor(() =>
      expect(vi.mocked(showToast)).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'warning',
          message: expect.stringContaining('UNINSTALL_PENDING'),
        }),
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// #5023 — a mutation must re-resolve the SERVER-side advanced filter, not just
// the device rows.
//
// Advanced filters ("Status is Removed") are resolved server-side into an id
// set by useAdvancedFilterIds and handed to the list/grid as `serverFilterIds`.
// `fetchDevices()` after a mutation refreshed the ROWS only, so a Restore left
// the now-non-matching device in that stale id set and it stayed on screen,
// with a stale count, until a full page reload. Asserting the row disappears
// alone is not enough — the refreshed rows still carry the restored device, so
// what has to be pinned is that the id set was re-resolved.
// ---------------------------------------------------------------------------
describe('DevicesPage — post-mutation refresh re-resolves the advanced filter (#5023)', () => {
  /**
   * Stand in for a "Status is Removed" advanced filter over a removed fleet:
   * the first resolution matches both devices, every later one matches only
   * the device that is still removed.
   */
  async function removedFilterFleet() {
    // An earlier describe pins decodeFilterFromHash to null with
    // mockReturnValue, and vi.clearAllMocks() does not restore an
    // implementation — re-arm the active filter explicitly rather than
    // depending on suite order.
    const { decodeFilterFromHash } = await import('./filterUrl');
    vi.mocked(decodeFilterFromHash).mockReturnValue(activeFilter);

    vi.mocked(fetchAllDevices).mockResolvedValue({
      data: [
        { ...rawDevice(DEV_1, 'host-alpha'), status: 'decommissioned' },
        { ...rawDevice(DEV_3, 'host-gamma'), status: 'decommissioned' },
      ],
    } as never);

    const state = { previewCalls: 0 };
    vi.mocked(fetchWithAuth).mockImplementation(async (url: string) => {
      if (url.startsWith('/filters/preview')) {
        state.previewCalls += 1;
        const deviceIds = state.previewCalls === 1 ? [DEV_1, DEV_3] : [DEV_3];
        return jsonResponse({
          data: { totalCount: deviceIds.length, deviceIds, evaluatedAt: new Date().toISOString() },
        });
      }
      return jsonResponse({ data: [] });
    });
    return state;
  }

  async function renderAndSettle(state: { previewCalls: number }) {
    render(<DevicesPage />);
    const list = await screen.findByTestId('device-list');
    await waitFor(() =>
      expect(list.getAttribute('data-filter-ids')).toBe([DEV_1, DEV_3].sort().join(',')),
    );
    expect(state.previewCalls).toBe(1);
  }

  const filterIds = () => screen.getByTestId('device-list').getAttribute('data-filter-ids');

  it('single Restore drops the restored device from the resolved id set', async () => {
    const { restoreDevice } = await import('../../services/deviceActions');
    vi.mocked(restoreDevice).mockResolvedValue({ success: true } as never);

    const state = await removedFilterFleet();
    await renderAndSettle(state);

    fireEvent.click(screen.getByTestId(`row-restore-${DEV_1}`));

    await waitFor(() => expect(vi.mocked(restoreDevice)).toHaveBeenCalledWith(DEV_1));
    await waitFor(() => expect(state.previewCalls).toBe(2));
    await waitFor(() => expect(filterIds()).toBe(DEV_3));
  });

  it('bulk Restore re-resolves the id set too', async () => {
    const { bulkRestoreDevices } = await import('../../services/deviceActions');
    vi.mocked(bulkRestoreDevices).mockResolvedValue({
      succeeded: [{ deviceId: DEV_1, uninstallAlreadyDispatched: false }],
      failed: [],
    });

    const state = await removedFilterFleet();
    await renderAndSettle(state);

    fireEvent.click(screen.getByTestId('bulk-restore'));

    await waitFor(() => expect(vi.mocked(bulkRestoreDevices)).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(state.previewCalls).toBe(2));
    await waitFor(() => expect(filterIds()).toBe(DEV_3));
  });
});

// ---------------------------------------------------------------------------
// #5023 — single "Delete permanently" is gated like every other destructive
// action.
//
// Bulk purge has always demanded a typed device count (BulkPurgeDialog), but
// the row/card kebab's single Delete permanently went straight to the 5s undo
// toast. Same irreversible operation, one accidental click away in a dense
// list — and unlike Remove there is nothing to restore afterwards.
// ---------------------------------------------------------------------------
describe('DevicesPage — single permanent delete asks first (#5023)', () => {
  beforeEach(() => {
    vi.mocked(fetchAllDevices).mockResolvedValue({
      data: [{ ...rawDevice(DEV_1, 'host-alpha'), status: 'decommissioned' }],
    } as never);
  });

  it('opens a purge-framed confirm dialog instead of deleting immediately', async () => {
    const { permanentDeleteDevice } = await import('../../services/deviceActions');
    const { showToast } = await import('../shared/Toast');

    render(<DevicesPage />);
    fireEvent.click(await screen.findByTestId(`row-permanent-delete-${DEV_1}`));

    expect(await screen.findByText('Delete host-alpha permanently?')).toBeTruthy();
    // The copy has to say what is actually destroyed — "are you sure?" would
    // read as the (reversible) Remove the operator already knows.
    expect(
      screen.getByText(/deletes all history for this device/i),
    ).toBeTruthy();

    const confirmBtn = screen.getByTestId('confirm-device-action');
    expect(confirmBtn.textContent).toBe('Delete permanently');
    // Irreversible: the stop-octagon variant, not the caution triangle.
    expect(confirmBtn.className).toContain('bg-destructive');

    // Nothing has been queued — not even the undo toast, which is the point:
    // the gate must precede the timer, not race it.
    expect(vi.mocked(permanentDeleteDevice)).not.toHaveBeenCalled();
    expect(vi.mocked(showToast).mock.calls.some(([toast]) => toast.type === 'undo')).toBe(false);
  });

  it('cancelling deletes nothing', async () => {
    const { permanentDeleteDevice } = await import('../../services/deviceActions');

    render(<DevicesPage />);
    fireEvent.click(await screen.findByTestId(`row-permanent-delete-${DEV_1}`));
    await screen.findByTestId('confirm-device-action');

    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

    await waitFor(() => expect(screen.queryByTestId('confirm-device-action')).toBeNull());
    expect(vi.mocked(permanentDeleteDevice)).not.toHaveBeenCalled();
  });

  it('confirming still deletes, undo window and all', async () => {
    const { permanentDeleteDevice } = await import('../../services/deviceActions');
    vi.mocked(permanentDeleteDevice).mockResolvedValue({ success: true });

    render(<DevicesPage />);
    fireEvent.click(await screen.findByTestId(`row-permanent-delete-${DEV_1}`));
    const confirmBtn = await screen.findByTestId('confirm-device-action');

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      fireEvent.click(confirmBtn);
      // The confirm replaces the click as the trigger; the undo window it
      // starts is kept, so a mis-confirm is still recoverable for 5s.
      expect(vi.mocked(permanentDeleteDevice)).not.toHaveBeenCalled();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
    } finally {
      vi.useRealTimers();
    }

    expect(vi.mocked(permanentDeleteDevice)).toHaveBeenCalledWith(DEV_1);
  });
});

// 2026-09-06 critique P0: the server filter engine cannot see network rows,
// so the page evaluates them client-side and the segment badges must count
// the SAME rows the list renders — never an unfiltered total.
describe('DevicesPage — class segment badges tell the truth under a filter', () => {
  const NET_ON = '77777777-7777-7777-7777-777777777777';
  const NET_OFF = '88888888-8888-8888-8888-888888888888';

  function rawNetworkDevice(id: string, hostname: string, status: string) {
    return {
      id,
      deviceClass: 'network',
      assetType: 'switch',
      hostname,
      status,
      lastSeenAt: new Date().toISOString(),
      orgId: 'org-1',
      siteId: 'site-1',
      tags: [],
    };
  }

  beforeEach(() => {
    history.replaceState(null, '', '/devices');
    vi.mocked(fetchAllNetworkDevices).mockResolvedValue({
      data: [rawNetworkDevice(NET_ON, 'core-sw', 'online'), rawNetworkDevice(NET_OFF, 'old-cam', 'offline')],
      total: 2,
      pagesWalked: 1,
    } as never);
  });

  it('counts only the rows the Online filter leaves: 2 agents from the server id set, 1 network from the client evaluator', async () => {
    const { decodeFilterFromHash } = await import('./filterUrl');
    vi.mocked(decodeFilterFromHash).mockReturnValue(activeFilter); // status = online
    render(<DevicesPage />);
    await screen.findByTestId('device-list');
    await waitFor(() => expect(screen.getByTestId('device-class-segment-all')).toHaveTextContent('3'));
    expect(screen.getByTestId('device-class-segment-agent')).toHaveTextContent('2');
    expect(screen.getByTestId('device-class-segment-network')).toHaveTextContent('1');
    expect(screen.queryByTestId('hidden-network-notice')).toBeNull();
  });

  it('says how many network rows an agent-only filter hides, and which field caused it', async () => {
    const { decodeFilterFromHash } = await import('./filterUrl');
    vi.mocked(decodeFilterFromHash).mockReturnValue({
      operator: 'AND',
      conditions: [{ field: 'patches.pending', operator: 'equals', value: 'yes' }],
    });
    render(<DevicesPage />);
    await screen.findByTestId('device-list');
    const notice = await screen.findByTestId('hidden-network-notice');
    expect(notice.textContent).toMatch(/2 network devices hidden/);
    expect(notice.textContent).toMatch(/Needs Patches/);
    await waitFor(() => expect(screen.getByTestId('device-class-segment-network')).toHaveTextContent('0'));
  });
});
