import '@/lib/i18n';

import { render, screen, waitFor, fireEvent, cleanup, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import NetworkDeviceDetailPage from './NetworkDeviceDetailPage';
import { navigateTo } from '@/lib/navigation';
import { showToast } from '../shared/Toast';
import { topologyGraphFixture, topologySettingsFixture, SITE, NODE } from '../topology/topologyFixtures';

// Keep legacy discovery/action queues separate from the new parallel reads.
const { fetchWithAuthMock, monitoringFetchMock } = vi.hoisted(() => ({
  fetchWithAuthMock: vi.fn(), monitoringFetchMock: vi.fn(),
}));
vi.mock('../../stores/auth', () => ({
  registerOrgIdProvider: vi.fn(),
  fetchWithAuth: (url: string, init?: RequestInit) =>
    url.startsWith('/monitoring/assets/') || url.startsWith('/monitors?assetId=') || url === '/snmp/templates'
      ? monitoringFetchMock(url, init) : init === undefined ? fetchWithAuthMock(url) : fetchWithAuthMock(url, init),
}));

vi.mock('@/lib/navigation', () => ({
  navigateTo: vi.fn(),
}));

// runAction surfaces outcome through showToast; mock it so the popover's
// Connect assertions don't depend on the real toast DOM/timers.
vi.mock('../shared/Toast', () => ({
  showToast: vi.fn(),
}));

vi.mock('../topology/TopologyCanvas', () => ({ default: () => <div data-testid="topology-canvas" /> }));

const showToastMock = vi.mocked(showToast);

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

const devicesResponse = (devices: Array<{ id: string; displayName?: string; hostname?: string; status: string }>) =>
  makeJsonResponse({ data: devices });

const ASSET_ID = '11111111-1111-1111-1111-111111111111';

const baseReachability = {
  state: 'responding' as const,
  source: 'snmp' as const,
  observedAt: new Date(Date.now() - 2 * 60_000).toISOString(),
  lastKnown: null,
  detail: { snmp: { state: 'ok' as const, observedAt: new Date(Date.now() - 2 * 60_000).toISOString(), consecutiveFailures: 0 } },
};

const baseAsset = {
  reachability: baseReachability,
  id: ASSET_ID,
  orgId: 'org-1',
  siteId: 'site-1',
  assetType: 'switch',
  approvalStatus: 'approved',
  isOnline: true,
  hostname: 'core-switch-01',
  label: 'Main Switch',
  ipAddress: '10.0.0.2',
  macAddress: 'aa:bb:cc:dd:ee:ff',
  manufacturer: 'Cisco',
  model: 'C9300',
  openPorts: [
    { port: 22, service: 'ssh' },
    { port: 443, service: 'https' },
  ],
  osFingerprint: 'IOS-XE',
  snmpData: { sysName: 'core-switch-01', sysDescr: 'Cisco IOS' },
  responseTimeMs: 2.4,
  linkedDeviceId: null,
  linkedDeviceName: null,
  snmpMonitoringEnabled: true,
  networkMonitoringEnabled: false,
  monitoringEnabled: true,
  discoveryMethods: ['arp', 'snmp'],
  profileName: 'HQ LAN',
  notes: 'Closet A',
  tags: ['critical', 'core'],
  firstSeenAt: '2026-05-01T10:00:00.000Z',
  lastSeenAt: '2026-06-26T10:00:00.000Z',
};

const baseCollection = {
  status: 'ok', templateId: 'template-1', pollingInterval: 300,
  lastPolledAt: new Date(Date.now() - 120_000).toISOString(), nextPollAt: null,
  consecutiveFailures: 0, oids: [],
};
function monitoringResponse(url: string): Promise<Response> {
  if (url === `/monitoring/assets/${ASSET_ID}`) return Promise.resolve(makeJsonResponse({ collection: baseCollection, snmpDevice: null }));
  if (url === '/snmp/templates') return Promise.resolve(makeJsonResponse({ data: [{ id: 'template-1', name: 'Switch template' }] }));
  return Promise.resolve(makeJsonResponse({ data: [] }));
}

// OverflowTabs measures button widths via `offsetWidth`, which jsdom always
// reports as 0 against a `clientWidth` of 0 — that collapses to "fits 1 tab"
// (see computeVisible in OverflowTabs.tsx), so with two tabs "Overview" stays
// visible and "Monitoring" always lands in the "More" dropdown in tests.
function openMonitoringTab() {
  fireEvent.click(screen.getByText('More'));
  fireEvent.click(screen.getByTestId('network-detail-tab-monitoring'));
}

describe('NetworkDeviceDetailPage', () => {
  it('shows the persisted SNMP error in the header', async () => {
    fetchWithAuthMock.mockImplementation((url: string) => Promise.resolve(
      makeJsonResponse(url === `/discovery/assets/${ASSET_ID}` ? { data: baseAsset } : { data: [] }),
    ));
    monitoringFetchMock.mockImplementation((url: string) => url === `/monitoring/assets/${ASSET_ID}`
      ? Promise.resolve(makeJsonResponse({ collection: baseCollection, snmpDevice: {
        lastError: 'SNMP walk timed out', lastErrorAt: '2026-09-16T10:00:00.000Z',
      } }))
      : monitoringResponse(url));
    render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
    expect(await screen.findByTestId('network-device-last-error')).toHaveTextContent('Last error: SNMP walk timed out');
  });

  it('omits the last error line when the successful poll cleared the error', async () => {
    fetchWithAuthMock.mockImplementation((url: string) => Promise.resolve(
      makeJsonResponse(url === `/discovery/assets/${ASSET_ID}` ? { data: baseAsset } : { data: [] }),
    ));
    monitoringFetchMock.mockImplementation((url: string) => url === `/monitoring/assets/${ASSET_ID}`
      ? Promise.resolve(makeJsonResponse({ collection: baseCollection, snmpDevice: { lastError: null, lastErrorAt: null } }))
      : monitoringResponse(url));
    render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
    await screen.findByTestId('network-device-name');
    expect(screen.queryByTestId('network-device-last-error')).not.toBeInTheDocument();
  });

  it('composes the reachability card, the type health card and the monitoring sections from the asset and monitoring endpoints', async () => {
    fetchWithAuthMock.mockImplementation((url: string) => Promise.resolve(
      makeJsonResponse(url === `/discovery/assets/${ASSET_ID}` ? { data: baseAsset } : { data: [] }),
    ));
    monitoringFetchMock.mockImplementation(monitoringResponse);
    render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
    expect(await screen.findByTestId('network-detail-reachability-card')).toBeInTheDocument();
    expect(screen.getByTestId('network-detail-health')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('network-detail-stat-last-poll')).toHaveTextContent('Polling'));
    expect(screen.getByTestId('network-detail-health')).toHaveTextContent('Device health');
    openMonitoringTab();
    for (const id of ['poll-config', 'oid-table', 'charts', 'checks', 'thresholds']) {
      expect(await screen.findByTestId(`network-detail-${id}`)).toBeInTheDocument();
    }
    expect(monitoringFetchMock).toHaveBeenCalledWith(`/monitors?assetId=${ASSET_ID}`, undefined);
    expect(monitoringFetchMock).toHaveBeenCalledWith(`/monitoring/assets/${ASSET_ID}/thresholds`, undefined);
    expect(monitoringFetchMock).toHaveBeenCalledWith('/snmp/templates', undefined);
  });

  it.each(['approve', 'dismiss'] as const)('reports a failed read after a saved %s', async (action) => {
    let saved = false;
    fetchWithAuthMock.mockImplementation((url: string) => {
      if (url === `/discovery/assets/${ASSET_ID}/${action}`) {
        saved = true;
        return Promise.resolve(makeJsonResponse({ success: true }));
      }
      if (url === `/discovery/assets/${ASSET_ID}`) return Promise.resolve(saved
        ? makeJsonResponse({}, false) : makeJsonResponse({ data: { ...baseAsset, approvalStatus: 'pending' } }));
      return Promise.resolve(devicesResponse([]));
    });
    render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
    fireEvent.click(await screen.findByTestId(`network-detail-${action}`));
    await waitFor(() => expect(showToastMock).toHaveBeenCalledWith({
      type: 'error', message: 'Saved, but the page could not refresh. Reload to see the change.',
    }));
    expect(screen.getByTestId(`network-detail-${action}`)).toBeEnabled();
  });

  it('uses the site Chicago timezone for the badge title and First seen', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ data: {
      ...baseAsset, siteTimezone: 'America/Chicago', firstSeenAt: '2026-09-16T10:07:00.000Z',
      reachability: { ...baseReachability, observedAt: '2026-09-16T10:07:00.000Z' },
    } }));
    render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
    expect(await screen.findByTestId('network-device-status')).toHaveAttribute('title', expect.stringContaining('05:07'));
    expect(screen.getByTestId('network-detail-first-seen')).toHaveTextContent('05:07');
  });

  it('polls a pending 202 probe after 3 s and displays timeout after 63 s', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let pending = false;
      fetchWithAuthMock.mockImplementation((url: string) => {
        if (url.endsWith('/probe')) {
          pending = true;
          return Promise.resolve(makeJsonResponse({ probe: { state: 'pending' } }, true, 202));
        }
        // Exercise the compatibility fallback when only reachability.detail.probe is present.
        if (url === `/discovery/assets/${ASSET_ID}`) return Promise.resolve(makeJsonResponse({ data: {
          ...baseAsset, reachability: { ...baseReachability, detail: {
            ...baseReachability.detail, ...(pending ? { probe: { state: 'pending', observedAt: null, responseMs: null } } : {}),
          } },
        } }));
        return Promise.resolve(devicesResponse([]));
      });
      render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
      fireEvent.click(await screen.findByTestId('network-detail-check-now'));
      await waitFor(() => expect(screen.getByTestId('network-detail-probe-status')).toBeInTheDocument());
      const gets = () => fetchWithAuthMock.mock.calls.filter(([url]) => url === `/discovery/assets/${ASSET_ID}`).length;
      await act(async () => {});
      const before = gets();
      await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
      expect(gets()).toBe(before + 1);
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      expect(screen.getByTestId('network-detail-probe-error')).toHaveTextContent("The agent didn't answer within a minute");
      expect(screen.getByTestId('network-detail-check-now')).toBeEnabled();
    } finally { vi.useRealTimers(); }
  });

  it('names the probe source in the header after a successful check', async () => {
    let checked = false;
    fetchWithAuthMock.mockImplementation((url: string) => {
      const probe = { state: 'ok', observedAt: new Date().toISOString(), responseMs: 4 };
      if (url.endsWith('/probe')) { checked = true; return Promise.resolve(makeJsonResponse({ probe })); }
      if (url === `/discovery/assets/${ASSET_ID}`) return Promise.resolve(makeJsonResponse({ data: {
        ...baseAsset, ...(checked ? { probe, reachability: {
          ...baseReachability, source: 'probe', observedAt: probe.observedAt, detail: { probe },
        } } : {}),
      } }));
      return Promise.resolve(devicesResponse([]));
    });
    render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
    fireEvent.click(await screen.findByTestId('network-detail-check-now'));
    await waitFor(() => expect(screen.getByTestId('network-device-status')).toHaveTextContent(/Responding · probe/i));
    expect(fetchWithAuthMock.mock.calls.filter(([url]) => url.endsWith('/probe'))).toHaveLength(1);
  });

  it.each(['approve', 'dismiss'] as const)('uses the single writer to %s and refreshes the banner', async (action) => {
    const approvalStatus = action === 'approve' ? 'approved' : 'dismissed';
    fetchWithAuthMock
      .mockResolvedValueOnce(makeJsonResponse({ data: { ...baseAsset, approvalStatus: 'pending' } }))
      .mockResolvedValueOnce(devicesResponse([]))
      .mockResolvedValueOnce(makeJsonResponse({ success: true }))
      .mockResolvedValueOnce(makeJsonResponse({ data: { ...baseAsset, approvalStatus } }));
    render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
    fireEvent.click(await screen.findByTestId(`network-detail-${action}`));
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledWith(
      `/discovery/assets/${ASSET_ID}/${action}`, { method: 'PATCH' },
    ));
    await waitFor(() => expect(screen.getByTestId('network-detail-live').textContent).toMatch(
      action === 'approve' ? /approved/i : /dismissed/i,
    ));
    expect(screen.queryByTestId('network-detail-dismiss')).toBeNull();
  });

  it.each(['approve', 'dismiss'] as const)('clears busy after a failed %s without duplicate feedback', async (action) => {
    fetchWithAuthMock
      .mockResolvedValueOnce(makeJsonResponse({ data: { ...baseAsset, approvalStatus: 'pending' } }))
      .mockResolvedValueOnce(devicesResponse([]))
      .mockResolvedValueOnce(makeJsonResponse({ error: 'Decision failed' }, false));
    render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
    fireEvent.click(await screen.findByTestId(`network-detail-${action}`));
    await waitFor(() => expect(showToastMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId('network-detail-approve')).toBeEnabled());
    expect(screen.getByTestId('network-detail-dismiss')).toBeEnabled();
    expect(screen.getByTestId('network-detail-live')).toBeEmptyDOMElement();
  });

  it('renders unknown approval muted without triage actions and missing reachability as unverified', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({
      data: { ...baseAsset, approvalStatus: 'future-status', reachability: null },
    }));
    render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
    await screen.findByTestId('network-device-detail');
    expect(screen.getByTestId('network-detail-approval-badge')).toHaveClass('bg-muted');
    expect(screen.queryByTestId('network-detail-approval-banner')).toBeNull();
    expect(screen.getByTestId('network-device-status')).toHaveTextContent('Unverified · never observed');
  });

  it('hides the approval badge when approved and shows the banner when pending', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({ data: { ...baseAsset, reachability: baseReachability } }),
    );
    render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
    await screen.findByTestId('network-device-detail');
    expect(screen.queryByTestId('network-detail-approval-badge')).toBeNull();
    expect(screen.queryByTestId('network-detail-approval-banner')).toBeNull();

    cleanup();
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({ data: { ...baseAsset, approvalStatus: 'pending', reachability: baseReachability } }),
    );
    render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
    await screen.findByTestId('network-device-detail');
    expect(screen.getByTestId('network-detail-approval-badge')).toBeInTheDocument();
    expect(screen.getByTestId('network-detail-approval-banner')).toBeInTheDocument();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    fetchWithAuthMock.mockReset();
    monitoringFetchMock.mockReset().mockImplementation(monitoringResponse);
    window.location.hash = '';
  });

  afterEach(() => {
    window.location.hash = '';
  });

  it('renders identity, network, SNMP and ports from the discovery asset endpoint', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ data: baseAsset }));

    render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);

    await screen.findByTestId('network-device-detail');
    expect(fetchWithAuthMock).toHaveBeenCalledWith(`/discovery/assets/${ASSET_ID}`);

    expect(screen.getByTestId('network-device-name').textContent).toContain('Main Switch');
    expect(screen.getByTestId('network-asset-type').textContent).toContain('Switch');
    const status = screen.getByTestId('network-device-status').textContent ?? '';
    expect(status).toContain('Responding');
    expect(status).toContain('SNMP');
    expect(status).not.toBe('Online');
    expect(screen.getByTestId('network-detail-ping').textContent).toContain('2.4 ms');

    const ports = screen.getByTestId('network-detail-ports');
    expect(ports.textContent).toContain('22');
    expect(ports.textContent).toContain('SSH');
    expect(ports.textContent).toContain('443');
    expect(ports.textContent).toContain('HTTPS');
    expect(ports.querySelector('h3')?.textContent).toContain('Open ports');
    expect(screen.getByTestId('network-detail-ports-count').textContent).toBe('2');

    const snmp = screen.getByTestId('network-detail-snmp');
    expect(snmp.textContent).toContain('System name');
    expect(snmp.textContent).toContain('Description');
    expect(snmp.textContent).toContain('Cisco IOS');
  });

  it('renders sourced non-response and a dash ping when the asset is down', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({ data: { ...baseAsset, isOnline: false, reachability: { ...baseReachability, state: 'not_responding' }, responseTimeMs: null } }),
    );

    render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
    await screen.findByTestId('network-device-detail');

    expect(screen.getByTestId('network-device-status').textContent).toContain('Not responding');
    expect(screen.getByTestId('network-detail-ping').textContent).toBe('—');
  });

  it('shows empty-state guidance for an asset with no SNMP data and no open ports', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({ data: { ...baseAsset, snmpData: {}, openPorts: [] } }),
    );

    render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
    await screen.findByTestId('network-device-detail');

    expect(screen.getByTestId('network-detail-snmp').textContent).toContain('No SNMP data was collected');
    expect(screen.getByTestId('network-detail-ports').textContent).toContain('No open ports were found on the most recent scan');
  });

  it('falls back to hostname for the display name when no label is set', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({ data: { ...baseAsset, label: null } }),
    );

    render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
    await screen.findByTestId('network-device-detail');

    expect(screen.getByTestId('network-device-name').textContent).toContain('core-switch-01');
  });

  it('treats a 200 with a malformed/empty body as a load failure (no blank shell)', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ data: {} }));

    render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);

    await screen.findByTestId('network-device-detail-error');
    expect(screen.queryByTestId('network-device-detail')).toBeNull();
    expect(
      screen.getByText(
        "The server returned an unexpected response for this network device. Try again, and contact support if it keeps happening.",
      ),
    ).toBeTruthy();
  });

  it('shows a recovery message and a "Try again" action that re-fetches the asset on a load failure', async () => {
    fetchWithAuthMock
      .mockResolvedValueOnce(makeJsonResponse({}, false, 500))
      .mockResolvedValueOnce(makeJsonResponse({ data: baseAsset }))
      .mockResolvedValueOnce(devicesResponse([])); // proxy bridge device list, fetched once the asset loads

    render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);

    await screen.findByTestId('network-device-detail-error');
    expect(
      screen.getByText("Couldn't load this network device. Check your connection and try again."),
    ).toBeTruthy();

    fireEvent.click(screen.getByTestId('network-detail-retry'));

    await screen.findByTestId('network-device-detail');
    expect(fetchWithAuthMock.mock.calls[1][0]).toBe(`/discovery/assets/${ASSET_ID}`);
  });

  it('does NOT render agent-only sections (scripts, terminal, remote desktop, processes)', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ data: baseAsset }));

    render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
    await screen.findByTestId('network-device-detail');

    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/remote desktop/i);
    expect(text).not.toMatch(/run script/i);
    expect(text).not.toMatch(/terminal/i);
    expect(text).not.toMatch(/processes/i);
  });

  it('switches to the monitoring tab via the URL hash', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ data: baseAsset }));

    render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
    await screen.findByTestId('network-device-detail');

    expect(screen.getByTestId('network-detail-overview')).toBeTruthy();
    expect(screen.queryByTestId('network-detail-monitoring')).toBeNull();

    openMonitoringTab();

    await screen.findByTestId('network-detail-monitoring');
    expect(window.location.hash).toBe('#monitoring');
    const monitoring = screen.getByTestId('network-detail-monitoring');
    await screen.findByTestId('network-detail-poll-config');
    expect(monitoring.textContent).not.toContain('Enabled');
    expect(monitoring.textContent).toContain('Polling');
  });

  // #reviewFix10b: each tab must point at its panel via aria-controls, and
  // the panel must be named with aria-label (not aria-labelledby) since the
  // labelling tab element doesn't exist in the DOM while it's in overflow.
  it('links each tab to its panel via aria-controls, naming the panel with aria-labelledby', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ data: baseAsset }));

    render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
    await screen.findByTestId('network-device-detail');

    const overviewTab = screen.getByTestId('network-detail-tab-overview');
    const overviewPanel = screen.getByTestId('network-detail-overview');
    expect(overviewTab.getAttribute('aria-controls')).toBe(overviewPanel.id);
    expect(overviewPanel.getAttribute('aria-labelledby')).toBe(overviewTab.id);
    expect(overviewPanel).toHaveAccessibleName('Overview');
    expect(overviewPanel).not.toHaveAttribute('aria-label');

    openMonitoringTab();
    const monitoringPanel = await screen.findByTestId('network-detail-monitoring');
    expect(monitoringPanel.getAttribute('aria-labelledby')).toBe('network-detail-tab-monitoring');
    expect(monitoringPanel).toHaveAccessibleName('Monitoring');
    expect(monitoringPanel).not.toHaveAttribute('aria-label');
  });

  it('initializes the active tab from the URL hash on mount', async () => {
    window.location.hash = '#monitoring';
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ data: baseAsset }));

    render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
    await screen.findByTestId('network-device-detail');

    expect(screen.getByTestId('network-detail-monitoring')).toBeTruthy();
    expect(screen.queryByTestId('network-detail-overview')).toBeNull();
  });

  it('renders a link to the managed device when the asset is linked, labeled "auto-detected"', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({
        data: { ...baseAsset, linkedDeviceId: 'dev-9', linkedDeviceName: 'agent-host', linkSource: 'auto' },
      }),
    );

    render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
    await screen.findByTestId('network-device-detail');

    const link = await screen.findByTestId('network-detail-linked-device');
    expect(link.getAttribute('href')).toBe('/devices/dev-9');
    expect(link.textContent).toContain('agent-host');
    expect(screen.getByTestId('network-detail-link-provenance').textContent).toContain('auto-detected');
  });

  it('offers Link settings for a manually linked asset, labeled "set manually"', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({
        data: { ...baseAsset, linkedDeviceId: 'dev-9', linkedDeviceName: 'agent-host', linkSource: 'manual' },
      }),
    );

    render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
    await screen.findByTestId('network-device-detail');

    expect(await screen.findByTestId('network-detail-edit-link')).toBeTruthy();
    expect(screen.getByTestId('network-detail-link-provenance').textContent).toContain('set manually');
  });

  // Both link provenances retain the same settings entry point.
  it('offers Link settings for an auto-linked asset too (#3261)', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({
        data: { ...baseAsset, linkedDeviceId: 'dev-9', linkedDeviceName: 'agent-host', linkSource: 'auto' },
      }),
    );

    render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
    await screen.findByTestId('network-device-detail');

    await screen.findByTestId('network-detail-linked-device');
    expect(screen.getByTestId('network-detail-edit-link')).toBeTruthy();
  });

  it('shows the "Auto-linking disabled" line when unlinked and suppressed', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({
        data: { ...baseAsset, linkedDeviceId: null, autoLinkSuppressedAt: '2026-08-08T00:00:00.000Z' },
      }),
    );

    render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
    await screen.findByTestId('network-device-detail');

    expect(screen.getByTestId('network-detail-suppressed').textContent).toContain(
      'Auto-linking is off for this asset because someone unlinked it',
    );
  });

  it('shows no suppressed-state line when unlinked and not suppressed', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({ data: { ...baseAsset, linkedDeviceId: null, autoLinkSuppressedAt: null } }),
    );

    render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
    await screen.findByTestId('network-device-detail');

    expect(screen.queryByTestId('network-detail-suppressed')).toBeNull();
  });

  it('does not flash the loading skeleton or unmount the page while Unlink reloads the asset', async () => {
    let resolveReload!: (value: Response) => void;
    const reloadPromise = new Promise<Response>((resolve) => {
      resolveReload = resolve;
    });

    fetchWithAuthMock
      .mockResolvedValueOnce(
        makeJsonResponse({
          data: { ...baseAsset, linkedDeviceId: 'dev-9', linkedDeviceName: 'agent-host', linkSource: 'manual' },
        }),
      )
      .mockResolvedValueOnce(devicesResponse([]))
      .mockResolvedValueOnce(makeJsonResponse({ success: true }))
      .mockReturnValueOnce(reloadPromise as unknown as Promise<Response>);

    render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
    await screen.findByTestId('network-device-detail');
    const nameBefore = screen.getByTestId('network-device-name');

    fireEvent.click(screen.getByTestId('network-detail-edit-link'));
    fireEvent.click(await screen.findByTestId('network-settings-link-unlink'));
    fireEvent.click(await screen.findByTestId('network-settings-link-unlink-confirm'));

    await waitFor(() =>
      expect(fetchWithAuthMock).toHaveBeenCalledWith(`/discovery/assets/${ASSET_ID}/link`, { method: 'DELETE' }),
    );

    // The reload after DELETE is still in flight — must not show the
    // skeleton or unmount/remount the page.
    expect(screen.queryByTestId('network-device-detail-loading')).toBeNull();
    expect(screen.getByTestId('network-device-name')).toBe(nameBefore);

    resolveReload(makeJsonResponse({ data: { ...baseAsset, linkedDeviceId: null, linkSource: null } }));
    await waitFor(() => expect(screen.queryByTestId('network-settings-link-unlink')).toBeNull());
    expect(screen.queryByTestId('network-device-detail-loading')).toBeNull();
  });

  it('shows a not-found error for a 404 response', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({}, false, 404));

    render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);

    await screen.findByTestId('network-device-detail-error');
    expect(screen.getByText('Network device not found')).toBeTruthy();
  });

  it('navigates back to /devices from the error state', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({}, false, 500));

    render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
    await screen.findByTestId('network-device-detail-error');

    fireEvent.click(screen.getByText('Go back'));
    expect(vi.mocked(navigateTo)).toHaveBeenCalledWith('/devices');
  });

  it('does not flash the loading skeleton or unmount the page while Save reloads the asset', async () => {
    let resolveReload!: (value: Response) => void;
    const reloadPromise = new Promise<Response>((resolve) => {
      resolveReload = resolve;
    });

    fetchWithAuthMock
      .mockResolvedValueOnce(makeJsonResponse({ data: { ...baseAsset, assetType: 'workstation' } }))
      .mockResolvedValueOnce(devicesResponse([]))
      .mockResolvedValueOnce(makeJsonResponse({ data: { ...baseAsset, assetType: 'router', typeSource: 'manual' } }))
      .mockReturnValueOnce(reloadPromise as unknown as Promise<Response>);

    render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
    await screen.findByTestId('network-device-detail');
    const nameBefore = screen.getByTestId('network-device-name');

    fireEvent.click(screen.getByTestId('network-detail-edit-identity'));
    fireEvent.change(screen.getByTestId('network-settings-identity-type'), { target: { value: 'router' } });
    fireEvent.click(screen.getByTestId('network-settings-identity-save'));

    await waitFor(() =>
      expect(fetchWithAuthMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH')).toBe(true),
    );

    // The post-Save reload is still in flight here — must not show the
    // skeleton or unmount/remount the page.
    expect(screen.queryByTestId('network-device-detail-loading')).toBeNull();
    expect(screen.getByTestId('network-device-name')).toBe(nameBefore);

    resolveReload(makeJsonResponse({ data: { ...baseAsset, assetType: 'router', typeSource: 'manual' } }));

    await waitFor(() => expect(screen.getByTestId('network-settings-identity-save')).toBeDisabled());
    expect(screen.queryByTestId('network-device-detail-loading')).toBeNull();
  });


  it('opens the settings modal from the header button and writes the hash', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ data: baseAsset }));
    render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
    await screen.findByTestId('network-device-detail');

    fireEvent.click(screen.getByTestId('network-detail-settings'));

    expect(await screen.findByTestId('network-asset-settings-modal')).toBeInTheDocument();
    expect(window.location.hash).toBe('#overview/settings/identity');
  });

  it.each([
    ['#overview/settings/identity', 'danger', '#overview/settings/danger', 'overview'],
    ['#monitoring/settings/link', 'identity', '#monitoring/settings/identity', 'monitoring'],
  ])('clicking a rail section rewrites the hash and keeps the tab (%s)', async (initialHash, section, expectedHash, tab) => {
    window.location.hash = initialHash;
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ data: baseAsset }));
    render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
    await screen.findByTestId('network-asset-settings-modal');

    fireEvent.click(screen.getByTestId(`network-settings-nav-${section}`));

    await waitFor(() => expect(window.location.hash).toBe(expectedHash));
    expect(screen.getByTestId(`network-settings-panel-${section}`)).toBeInTheDocument();
    expect(screen.getByTestId(`network-detail-${tab}`)).toBeInTheDocument();
  });

  it('opens straight to a section from a deep link', async () => {
    window.location.hash = '#overview/settings/monitoring';
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ data: baseAsset }));
    render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);

    expect(await screen.findByTestId('network-settings-panel-monitoring')).toBeInTheDocument();
  });

  it('closing the modal rewrites the hash back to the bare tab', async () => {
    window.location.hash = '#monitoring/settings/link';
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ data: baseAsset }));
    render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
    await screen.findByTestId('network-asset-settings-modal');

    fireEvent.keyDown(screen.getByTestId('network-asset-settings-modal'), { key: 'Escape' });

    await waitFor(() => expect(window.location.hash).toBe('#monitoring'));
    expect(screen.queryByTestId('network-asset-settings-modal')).not.toBeInTheDocument();
  });

  it('a browser back to a tab-only hash closes the modal', async () => {
    window.location.hash = '#overview/settings/danger';
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ data: baseAsset }));
    render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
    await screen.findByTestId('network-asset-settings-modal');

    window.location.hash = '#overview';
    fireEvent(window, new HashChangeEvent('hashchange'));

    await waitFor(() => expect(screen.queryByTestId('network-asset-settings-modal')).not.toBeInTheDocument());
  });

  it('no longer edits the type inline and no longer links out to Discovery', async () => {
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ data: baseAsset }));
    render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
    await screen.findByTestId('network-device-detail');

    expect(screen.queryByTestId('network-asset-type-select')).not.toBeInTheDocument();
    expect(screen.queryByTestId('network-detail-manage-discovery')).not.toBeInTheDocument();
    expect(screen.getByTestId('network-detail-edit-identity')).toBeInTheDocument();
  });

  describe('site name in the header', () => {
    it('renders the site name before the IP address when the asset endpoint returns one', async () => {
      fetchWithAuthMock.mockResolvedValueOnce(
        makeJsonResponse({ data: { ...baseAsset, siteName: 'HQ Office' } }),
      );

      render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
      await screen.findByTestId('network-device-detail');

      const site = screen.getByTestId('network-detail-site');
      expect(site.textContent).toContain('HQ Office');

      const subtitle = site.parentElement!.parentElement as HTMLElement;
      expect(subtitle.textContent).toContain(`HQ Office·${baseAsset.ipAddress}`);
    });

    it('omits the site element when the asset endpoint returns no site name', async () => {
      fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ data: baseAsset }));

      render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
      await screen.findByTestId('network-device-detail');

      expect(screen.queryByTestId('network-detail-site')).toBeNull();
    });
  });

  describe('proxy connect popover', () => {
    it('renders a labeled "Open Web UI" button only for web-ish ports, and it opens that port\'s popover', async () => {
      fetchWithAuthMock
        .mockResolvedValueOnce(makeJsonResponse({ data: baseAsset }))
        .mockResolvedValueOnce(devicesResponse([]));

      render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
      await screen.findByTestId('network-device-detail');

      // baseAsset.openPorts = [{port: 22, service: 'ssh'}, {port: 443, service: 'https'}]
      const trigger = screen.getByTestId('network-detail-port-proxy-443');
      expect(trigger).toBeTruthy();
      expect(trigger.textContent).toContain('Open Web UI');
      expect(screen.queryByTestId('network-detail-port-proxy-22')).toBeNull();

      fireEvent.click(trigger);
      expect(screen.getByTestId('network-detail-proxy-popover-443')).toBeTruthy();
    });

    it('gives the protocol select an accessible label', async () => {
      fetchWithAuthMock
        .mockResolvedValueOnce(makeJsonResponse({ data: baseAsset }))
        .mockResolvedValueOnce(devicesResponse([{ id: 'dev-1', displayName: 'Alpha', status: 'online' }]));

      render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
      await screen.findByTestId('network-device-detail');

      fireEvent.click(screen.getByTestId('network-detail-port-proxy-443'));

      const select = await screen.findByLabelText('Protocol');
      expect(select).toBe(screen.getByTestId('proxy-popover-scheme-select'));
    });

    it("fetches the bridge device list scoped to the asset's site, or unscoped when the asset has no site", async () => {
      fetchWithAuthMock
        .mockResolvedValueOnce(makeJsonResponse({ data: { ...baseAsset, siteId: 'site-1' } }))
        .mockResolvedValueOnce(devicesResponse([]));

      const { unmount } = render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
      await screen.findByTestId('network-device-detail');
      await waitFor(() =>
        expect(fetchWithAuthMock).toHaveBeenCalledWith('/devices?siteId=site-1'),
      );

      unmount();
      vi.clearAllMocks();

      fetchWithAuthMock
        .mockResolvedValueOnce(makeJsonResponse({ data: { ...baseAsset, siteId: null } }))
        .mockResolvedValueOnce(devicesResponse([]));

      render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
      await screen.findByTestId('network-device-detail');
      await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledWith('/devices'));
    });

    it('prepends the suggested bridge device with a fetch-by-id when the site-scoped list omits it', async () => {
      fetchWithAuthMock
        .mockResolvedValueOnce(
          makeJsonResponse({ data: { ...baseAsset, siteId: 'site-1', suggestedBridgeDeviceId: 'dev-99' } }),
        )
        .mockResolvedValueOnce(
          devicesResponse([{ id: 'dev-1', displayName: 'Alpha', status: 'online' }]),
        )
        .mockResolvedValueOnce(
          makeJsonResponse({ id: 'dev-99', displayName: 'Bridge99', status: 'online' }),
        );

      render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
      await screen.findByTestId('network-device-detail');

      await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledWith('/devices/dev-99'));

      fireEvent.click(screen.getByTestId('network-detail-port-proxy-443'));
      const select = (await screen.findByTestId('proxy-popover-bridge-select')) as HTMLSelectElement;
      await waitFor(() => expect(select.value).toBe('dev-99'));
      expect(select.textContent).toContain('Bridge99');
    });

    it('shows a pick-agent hint only with several online candidates and no suggested device', async () => {
      fetchWithAuthMock
        .mockResolvedValueOnce(makeJsonResponse({ data: { ...baseAsset, suggestedBridgeDeviceId: null } }))
        .mockResolvedValueOnce(
          devicesResponse([
            { id: 'dev-a', displayName: 'Alpha', status: 'online' },
            { id: 'dev-b', displayName: 'Beta', status: 'online' },
          ]),
        );

      const { unmount } = render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
      await screen.findByTestId('network-device-detail');
      fireEvent.click(screen.getByTestId('network-detail-port-proxy-443'));
      await screen.findByTestId('proxy-popover-bridge-select');
      expect(screen.getByTestId('proxy-popover-bridge-hint')).toBeTruthy();

      unmount();
      vi.clearAllMocks();

      fetchWithAuthMock
        .mockResolvedValueOnce(makeJsonResponse({ data: { ...baseAsset, suggestedBridgeDeviceId: null } }))
        .mockResolvedValueOnce(
          devicesResponse([{ id: 'dev-a', displayName: 'Alpha', status: 'online' }]),
        );

      render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
      await screen.findByTestId('network-device-detail');
      fireEvent.click(screen.getByTestId('network-detail-port-proxy-443'));
      await screen.findByTestId('proxy-popover-bridge-select');
      expect(screen.queryByTestId('proxy-popover-bridge-hint')).toBeNull();
    });

    it('shows a retry-able failure message when the bridge device list fails to load', async () => {
      fetchWithAuthMock
        .mockResolvedValueOnce(makeJsonResponse({ data: baseAsset }))
        .mockResolvedValueOnce(makeJsonResponse({}, false, 500))
        .mockResolvedValueOnce(
          devicesResponse([{ id: 'dev-1', displayName: 'Alpha', status: 'online' }]),
        );

      render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
      await screen.findByTestId('network-device-detail');

      fireEvent.click(screen.getByTestId('network-detail-port-proxy-443'));
      expect(await screen.findByText("Couldn't load the agent list. Retry.")).toBeTruthy();

      fireEvent.click(screen.getByTestId('proxy-popover-retry-agents'));

      const select = (await screen.findByTestId('proxy-popover-bridge-select')) as HTMLSelectElement;
      await waitFor(() => expect(select.value).toBe('dev-1'));
    });

    it('defaults the bridge device to suggestedBridgeDeviceId — never linkedDeviceId — when both are online', async () => {
      fetchWithAuthMock
        .mockResolvedValueOnce(
          makeJsonResponse({
            data: {
              ...baseAsset,
              linkedDeviceId: 'dev-9',
              linkedDeviceName: 'agent-host',
              suggestedBridgeDeviceId: 'dev-42',
            },
          }),
        )
        .mockResolvedValueOnce(
          devicesResponse([
            { id: 'dev-9', displayName: 'Linked Agent', status: 'online' },
            { id: 'dev-42', displayName: 'Discovering Agent', status: 'online' },
          ]),
        );

      render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
      await screen.findByTestId('network-device-detail');

      fireEvent.click(screen.getByTestId('network-detail-port-proxy-443'));

      const select = (await screen.findByTestId('proxy-popover-bridge-select')) as HTMLSelectElement;
      await waitFor(() => expect(select.value).toBe('dev-42'));
      // The regression this default fixes: the old modal defaulted to the
      // identity-linked device, which is a loopback (proxying to the asset
      // through the device it IS). It must never win when the two differ.
      expect(select.value).not.toBe('dev-9');
    });

    it('falls back to the first online device when suggestedBridgeDeviceId is absent', async () => {
      fetchWithAuthMock
        .mockResolvedValueOnce(makeJsonResponse({ data: { ...baseAsset, suggestedBridgeDeviceId: null } }))
        .mockResolvedValueOnce(
          devicesResponse([
            { id: 'dev-offline', displayName: 'Offline Agent', status: 'offline' },
            { id: 'dev-online', displayName: 'Online Agent', status: 'online' },
          ]),
        );

      render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
      await screen.findByTestId('network-device-detail');

      fireEvent.click(screen.getByTestId('network-detail-port-proxy-443'));

      const select = (await screen.findByTestId('proxy-popover-bridge-select')) as HTMLSelectElement;
      await waitFor(() => expect(select.value).toBe('dev-online'));
    });

    it('Connect POSTs /tunnels/proxy-connect with the selected device and opens the proxy tab with the asset param', async () => {
      const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);

      fetchWithAuthMock
        .mockResolvedValueOnce(
          makeJsonResponse({
            data: { ...baseAsset, linkedDeviceId: 'dev-9', suggestedBridgeDeviceId: 'dev-42' },
          }),
        )
        .mockResolvedValueOnce(
          devicesResponse([
            { id: 'dev-9', displayName: 'Linked Agent', status: 'online' },
            { id: 'dev-42', displayName: 'Discovering Agent', status: 'online' },
          ]),
        )
        .mockResolvedValueOnce(makeJsonResponse({ tunnel: { id: 'tunnel-1' } }, true, 201));

      render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
      await screen.findByTestId('network-device-detail');

      fireEvent.click(screen.getByTestId('network-detail-port-proxy-443'));
      const select = (await screen.findByTestId('proxy-popover-bridge-select')) as HTMLSelectElement;
      await waitFor(() => expect(select.value).toBe('dev-42'));

      fireEvent.click(screen.getByTestId('proxy-popover-connect'));

      await waitFor(() =>
        expect(fetchWithAuthMock).toHaveBeenCalledWith(
          '/tunnels/proxy-connect',
          expect.objectContaining({ method: 'POST' }),
        ),
      );

      const call = fetchWithAuthMock.mock.calls.find(([url]) => url === '/tunnels/proxy-connect');
      const body = JSON.parse((call![1] as RequestInit).body as string);
      expect(body).toEqual({
        deviceId: 'dev-42',
        discoveredAssetId: ASSET_ID,
        port: 443,
        scheme: 'https',
        skipTlsVerify: false,
      });

      await waitFor(() => expect(openSpy).toHaveBeenCalledTimes(1));
      const [url] = openSpy.mock.calls[0] as [string, string?];
      expect(url).toContain('/remote/proxy/tunnel-1');
      expect(url).toContain(`asset=${ASSET_ID}`);
      expect(url).toContain(`target=${encodeURIComponent('10.0.0.2:443')}`);

      openSpy.mockRestore();
    });

    it('always renders a header "Open Web UI" action, even when no open ports were scanned (#proxy-entry)', async () => {
      fetchWithAuthMock
        .mockResolvedValueOnce(makeJsonResponse({ data: { ...baseAsset, openPorts: [] } }))
        .mockResolvedValueOnce(devicesResponse([{ id: 'dev-42', displayName: 'Agent', status: 'online' }]));

      render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
      await screen.findByTestId('network-device-detail');

      expect(screen.queryByTestId('network-detail-port-proxy-443')).toBeNull();
      fireEvent.click(screen.getByTestId('network-detail-open-web-ui'));
      const portInput = (await screen.findByTestId('proxy-popover-port')) as HTMLInputElement;
      // No scanned web port → sensible default.
      expect(portInput.value).toBe('443');
    });

    it('header action flags an out-of-range port and disables Connect', async () => {
      fetchWithAuthMock
        .mockResolvedValueOnce(makeJsonResponse({ data: { ...baseAsset, openPorts: [] } }))
        .mockResolvedValueOnce(devicesResponse([{ id: 'dev-42', displayName: 'Agent', status: 'online' }]));

      render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
      await screen.findByTestId('network-device-detail');
      fireEvent.click(screen.getByTestId('network-detail-open-web-ui'));
      const portInput = (await screen.findByTestId('proxy-popover-port')) as HTMLInputElement;
      await screen.findByTestId('proxy-popover-bridge-select');

      expect(screen.queryByTestId('proxy-popover-port-error')).toBeNull();
      fireEvent.change(portInput, { target: { value: '70000' } });
      expect(screen.getByTestId('proxy-popover-port-error')).toBeTruthy();
      expect(portInput.getAttribute('aria-invalid')).toBe('true');
      expect((screen.getByTestId('proxy-popover-connect') as HTMLButtonElement).disabled).toBe(true);
      expect(fetchWithAuthMock.mock.calls.some(([url]) => url === '/tunnels/proxy-connect')).toBe(false);
    });

    it('header action defaults to the first scanned web port and lets the operator override it', async () => {
      const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
      fetchWithAuthMock
        .mockResolvedValueOnce(makeJsonResponse({ data: { ...baseAsset, suggestedBridgeDeviceId: 'dev-42' } }))
        .mockResolvedValueOnce(devicesResponse([{ id: 'dev-42', displayName: 'Agent', status: 'online' }]))
        .mockResolvedValueOnce(makeJsonResponse({ tunnel: { id: 'tunnel-2' } }, true, 201));

      render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
      await screen.findByTestId('network-device-detail');

      fireEvent.click(screen.getByTestId('network-detail-open-web-ui'));
      const portInput = (await screen.findByTestId('proxy-popover-port')) as HTMLInputElement;
      expect(portInput.value).toBe('443');
      const select = (await screen.findByTestId('proxy-popover-bridge-select')) as HTMLSelectElement;
      await waitFor(() => expect(select.value).toBe('dev-42'));

      fireEvent.change(portInput, { target: { value: '8080' } });
      fireEvent.click(screen.getByTestId('proxy-popover-connect'));

      await waitFor(() =>
        expect(fetchWithAuthMock).toHaveBeenCalledWith('/tunnels/proxy-connect', expect.objectContaining({ method: 'POST' })),
      );
      const call = fetchWithAuthMock.mock.calls.find(([url]) => url === '/tunnels/proxy-connect');
      const body = JSON.parse((call![1] as RequestInit).body as string);
      expect(body).toEqual({
        deviceId: 'dev-42',
        discoveredAssetId: ASSET_ID,
        port: 8080,
        scheme: 'http',
        skipTlsVerify: false,
      });
      await waitFor(() => expect(openSpy).toHaveBeenCalledTimes(1));
      expect((openSpy.mock.calls[0] as [string])[0]).toContain(`target=${encodeURIComponent('10.0.0.2:8080')}`);
      openSpy.mockRestore();
    });

    // #reviewFix5: the header popover's port field used to reseed from
    // `initialPort` whenever it changed for ANY reason — including a
    // background asset refresh landing while the operator has the popover
    // open and has already typed a custom port.
    it('does not clobber a custom-typed port in the open header popover when initialPort changes from a background refresh', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        fetchWithAuthMock
          .mockResolvedValueOnce(makeJsonResponse({ data: baseAsset })) // openPorts: 22, 443 -> defaultWebPort=443
          .mockResolvedValueOnce(devicesResponse([{ id: 'dev-1', displayName: 'Alpha', status: 'online' }]))
          .mockResolvedValueOnce(
            makeJsonResponse({
              data: { ...baseAsset, openPorts: [{ port: 22, service: 'ssh' }, { port: 8443, service: 'https-alt' }] },
            }),
          ); // background refresh: default web port becomes 8443

        render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
        await screen.findByTestId('network-device-detail');

        fireEvent.click(screen.getByTestId('network-detail-open-web-ui'));
        const portInput = (await screen.findByTestId('proxy-popover-port')) as HTMLInputElement;
        expect(portInput.value).toBe('443');

        fireEvent.change(portInput, { target: { value: '9000' } });
        expect(portInput.value).toBe('9000');

        Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));
        vi.setSystemTime(Date.now() + 65_000);
        Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));

        await waitFor(() =>
          expect(screen.getByTestId('network-detail-live').textContent).toBe('Device details refreshed'),
        );

        expect((screen.getByTestId('proxy-popover-port') as HTMLInputElement).value).toBe('9000');
      } finally {
        vi.useRealTimers();
      }
    });

    // #reviewFix6: clicking Retry disables the button; browsers then move
    // focus to <body>, escaping the popover's focus containment (jsdom
    // doesn't reproduce that specific move, so this asserts the mitigation
    // instead: focus is pushed into the panel before the button disables).
    it('moves focus into the panel when Retry agents is clicked, before the button disables', async () => {
      fetchWithAuthMock
        .mockResolvedValueOnce(makeJsonResponse({ data: baseAsset }))
        .mockResolvedValueOnce(makeJsonResponse({}, false, 500))
        .mockResolvedValueOnce(devicesResponse([{ id: 'dev-1', displayName: 'Alpha', status: 'online' }]));

      render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
      await screen.findByTestId('network-device-detail');

      fireEvent.click(screen.getByTestId('network-detail-port-proxy-443'));
      const retryButton = await screen.findByTestId('proxy-popover-retry-agents');
      const dialog = screen.getByTestId('network-detail-proxy-popover-443');

      fireEvent.click(retryButton);

      expect(dialog.contains(document.activeElement)).toBe(true);

      await waitFor(() => expect(screen.getByTestId('proxy-popover-bridge-select')).toBeTruthy());
    });

    // #reviewFix7 (P0): the combobox only updated deviceId on an exact label
    // match and otherwise left the PREVIOUS id in place — so the field could
    // show one agent's text while Connect would bridge through a different,
    // stale one.
    it('clears deviceId and flags aria-invalid on unmatched combobox text, recovering on an exact case-insensitive label or id match', async () => {
      const manyDevices = Array.from({ length: 9 }, (_, i) => ({
        id: `dev-${i}`,
        displayName: `Agent ${i}`,
        status: 'online',
      }));
      fetchWithAuthMock
        .mockResolvedValueOnce(makeJsonResponse({ data: { ...baseAsset, suggestedBridgeDeviceId: 'dev-0' } }))
        .mockResolvedValueOnce(devicesResponse(manyDevices));

      render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
      await screen.findByTestId('network-device-detail');

      fireEvent.click(screen.getByTestId('network-detail-port-proxy-443'));
      const input = (await screen.findByTestId('proxy-popover-bridge-select')) as HTMLInputElement;
      await waitFor(() => expect(input.value).toContain('Agent 0'));
      expect(input.getAttribute('aria-invalid')).toBe('false');

      fireEvent.change(input, { target: { value: 'not a real agent' } });
      expect(input.getAttribute('aria-invalid')).toBe('true');
      expect((screen.getByTestId('proxy-popover-connect') as HTMLButtonElement).disabled).toBe(true);

      // Recovers on an exact, case-insensitive label match.
      fireEvent.change(input, { target: { value: 'agent 3' } });
      expect(input.getAttribute('aria-invalid')).toBe('false');
      expect((screen.getByTestId('proxy-popover-connect') as HTMLButtonElement).disabled).toBe(false);

      // Recovers on a match by the device's own id too.
      fireEvent.change(input, { target: { value: 'dev-5' } });
      expect(input.getAttribute('aria-invalid')).toBe('false');
      expect((screen.getByTestId('proxy-popover-connect') as HTMLButtonElement).disabled).toBe(false);
    });

    it('shows an inline message and does not open a tab when the target is disabled for proxy access', async () => {
      const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);

      fetchWithAuthMock
        .mockResolvedValueOnce(makeJsonResponse({ data: { ...baseAsset, suggestedBridgeDeviceId: 'dev-42' } }))
        .mockResolvedValueOnce(devicesResponse([{ id: 'dev-42', displayName: 'Agent', status: 'online' }]))
        .mockResolvedValueOnce(
          makeJsonResponse({ error: 'This target has been disabled by an administrator', code: 'PROXY_TARGET_DISABLED' }, false, 403),
        );

      render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
      await screen.findByTestId('network-device-detail');

      fireEvent.click(screen.getByTestId('network-detail-port-proxy-443'));
      await screen.findByTestId('proxy-popover-bridge-select');

      fireEvent.click(screen.getByTestId('proxy-popover-connect'));

      await waitFor(() =>
        expect(screen.getByText('An administrator disabled proxy access to this target. Ask them to re-enable it under Settings, Remote access.')).toBeTruthy(),
      );
      expect(openSpy).not.toHaveBeenCalled();
      expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));

      openSpy.mockRestore();
    });

    it('is a labeled non-modal dialog that moves focus in on open and restores it to the trigger on Escape', async () => {
      fetchWithAuthMock
        .mockResolvedValueOnce(makeJsonResponse({ data: baseAsset }))
        .mockResolvedValueOnce(devicesResponse([{ id: 'dev-1', displayName: 'Alpha', status: 'online' }]));

      render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
      await screen.findByTestId('network-device-detail');

      const trigger = screen.getByTestId('network-detail-port-proxy-443');
      expect(trigger.getAttribute('aria-expanded')).toBe('false');

      fireEvent.click(trigger);

      const dialog = await screen.findByTestId('network-detail-proxy-popover-443');
      expect(dialog.getAttribute('role')).toBe('dialog');
      expect(dialog.getAttribute('aria-modal')).toBe('false');
      const labelledBy = dialog.getAttribute('aria-labelledby');
      expect(labelledBy).toBeTruthy();
      expect(document.getElementById(labelledBy!)).toBeTruthy();
      expect(trigger.getAttribute('aria-expanded')).toBe('true');
      expect(trigger.getAttribute('aria-controls')).toBe(dialog.id);

      const bridgeSelect = await screen.findByTestId('proxy-popover-bridge-select');
      await waitFor(() => expect(document.activeElement).toBe(bridgeSelect));

      fireEvent.keyDown(document, { key: 'Escape' });

      await waitFor(() => expect(screen.queryByTestId('network-detail-proxy-popover-443')).toBeNull());
      expect(document.activeElement).toBe(trigger);
      expect(trigger.getAttribute('aria-expanded')).toBe('false');
    });

    // #reviewFix9: the popover is aria-modal="false" (a non-modal dialog) but
    // used to hard-trap Tab like a modal. A real Tab key leaving the last
    // control moves focus to whatever the browser's native tab order finds
    // next, which is often outside the popover entirely — for a non-modal
    // dialog that focus move should be allowed to close the popover, not be
    // dragged back in. jsdom doesn't run native Tab traversal, so the
    // resulting focus move is simulated directly via the focusout it
    // produces (matching the real DOM: `focusout` bubbles, `blur` does not).
    it('closes the popover (no hard Tab trap) when focus leaves both the panel and the trigger, without stealing focus back', async () => {
      fetchWithAuthMock
        .mockResolvedValueOnce(makeJsonResponse({ data: baseAsset }))
        .mockResolvedValueOnce(devicesResponse([{ id: 'dev-1', displayName: 'Alpha', status: 'online' }]));

      render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
      await screen.findByTestId('network-device-detail');

      fireEvent.click(screen.getByTestId('network-detail-port-proxy-443'));
      await screen.findByTestId('proxy-popover-bridge-select');
      const connectButton = screen.getByTestId('proxy-popover-connect');

      const outsideButton = document.createElement('button');
      document.body.appendChild(outsideButton);
      outsideButton.focus();
      fireEvent.focusOut(connectButton, { relatedTarget: outsideButton });

      await waitFor(() => expect(screen.queryByTestId('network-detail-proxy-popover-443')).toBeNull());
      // Restoring nothing: focus already moved where the user sent it, so the
      // popover must not steal it back onto the trigger.
      expect(document.activeElement).toBe(outsideButton);

      document.body.removeChild(outsideButton);
    });

    it('does not close when focus moves between two controls inside the panel', async () => {
      fetchWithAuthMock
        .mockResolvedValueOnce(makeJsonResponse({ data: baseAsset }))
        .mockResolvedValueOnce(devicesResponse([{ id: 'dev-1', displayName: 'Alpha', status: 'online' }]));

      render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
      await screen.findByTestId('network-device-detail');

      fireEvent.click(screen.getByTestId('network-detail-port-proxy-443'));
      const bridgeSelect = await screen.findByTestId('proxy-popover-bridge-select');
      const schemeSelect = screen.getByTestId('proxy-popover-scheme-select');

      fireEvent.focusOut(bridgeSelect, { relatedTarget: schemeSelect });

      expect(screen.getByTestId('network-detail-proxy-popover-443')).toBeTruthy();
    });

    // Chrome fires `focusout` with a null relatedTarget when the focused
    // control is disabled (Connect flips to disabled the moment it is
    // pressed) or removed from the DOM. Neither is the user leaving the
    // popover, so a focus-loss with nowhere-to-go must not close it —
    // otherwise Connect closes its own popover mid-request and the sticky
    // inline errors (MFA / target disabled) can never be seen.
    it('stays open when focus is lost with no related target (disabled Connect, not a real Tab-away)', async () => {
      fetchWithAuthMock
        .mockResolvedValueOnce(makeJsonResponse({ data: baseAsset }))
        .mockResolvedValueOnce(devicesResponse([{ id: 'dev-1', displayName: 'Alpha', status: 'online' }]));

      render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
      await screen.findByTestId('network-device-detail');

      fireEvent.click(screen.getByTestId('network-detail-port-proxy-443'));
      await screen.findByTestId('proxy-popover-bridge-select');
      const connectButton = screen.getByTestId('proxy-popover-connect');
      connectButton.focus();

      fireEvent.focusOut(connectButton, { relatedTarget: null });

      expect(screen.getByTestId('network-detail-proxy-popover-443')).toBeTruthy();
    });

    // Companion to the case above: once the failed request settles and
    // Connect re-enables, the browser has already dropped focus to <body>
    // (disabled controls can't hold it). Put it back on Connect so a
    // keyboard user who pressed Enter can read the toast and retry in place.
    it('returns focus to Connect after a failed connect', async () => {
      fetchWithAuthMock
        .mockResolvedValueOnce(makeJsonResponse({ data: baseAsset }))
        .mockResolvedValueOnce(devicesResponse([{ id: 'dev-1', displayName: 'Alpha', status: 'online' }]))
        .mockResolvedValueOnce(makeJsonResponse({ error: 'Agent is not connected' }, false, 400));

      render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
      await screen.findByTestId('network-device-detail');

      fireEvent.click(screen.getByTestId('network-detail-port-proxy-443'));
      const select = (await screen.findByTestId('proxy-popover-bridge-select')) as HTMLSelectElement;
      await waitFor(() => expect(select.value).toBe('dev-1'));
      const connectButton = screen.getByTestId('proxy-popover-connect');
      connectButton.focus();
      // jsdom never drops focus off a disabled control the way Chrome does,
      // so assert the explicit refocus call rather than activeElement.
      const focusSpy = vi.spyOn(connectButton, 'focus');
      fireEvent.click(connectButton);
      fireEvent.focusOut(connectButton, { relatedTarget: null });

      await waitFor(() => expect(connectButton).not.toBeDisabled());
      expect(screen.getByTestId('network-detail-proxy-popover-443')).toBeTruthy();
      await waitFor(() => expect(focusSpy).toHaveBeenCalled());
    });

    it('breadcrumb back link returns to the Devices list filtered to network devices', async () => {
      fetchWithAuthMock
        .mockResolvedValueOnce(makeJsonResponse({ data: baseAsset }))
        .mockResolvedValueOnce(devicesResponse([]));
      render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
      await screen.findByTestId('network-device-detail');
      const back = screen.getByRole('link', { name: 'Devices & Assets' });
      expect(back.getAttribute('href')).toBe('/devices#deviceClass=network');
    });

    it('sends skipTlsVerify only when HTTPS is chosen and the self-signed box is ticked', async () => {
      vi.spyOn(window, 'open').mockImplementation(() => null);
      fetchWithAuthMock
        .mockResolvedValueOnce(makeJsonResponse({ data: { ...baseAsset, suggestedBridgeDeviceId: 'dev-42' } }))
        .mockResolvedValueOnce(devicesResponse([{ id: 'dev-42', displayName: 'Agent', status: 'online' }]))
        .mockResolvedValueOnce(makeJsonResponse({ tunnel: { id: 'tunnel-2' } }, true, 201));

      render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
      await screen.findByTestId('network-device-detail');
      fireEvent.click(screen.getByTestId('network-detail-port-proxy-443'));
      const select = (await screen.findByTestId('proxy-popover-bridge-select')) as HTMLSelectElement;
      await waitFor(() => expect(select.value).toBe('dev-42'));
      expect((screen.getByTestId('proxy-popover-scheme-select') as HTMLSelectElement).value).toBe('https');
      fireEvent.click(screen.getByLabelText(/self-signed certificate/i));
      fireEvent.click(screen.getByTestId('proxy-popover-connect'));

      await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledWith('/tunnels/proxy-connect', expect.anything()));
      const call = fetchWithAuthMock.mock.calls.find(([url]) => url === '/tunnels/proxy-connect');
      expect(JSON.parse((call![1] as RequestInit).body as string).skipTlsVerify).toBe(true);
    });

    it('shows the MFA inline message when the server answers MFA_REQUIRED', async () => {
      fetchWithAuthMock
        .mockResolvedValueOnce(makeJsonResponse({ data: { ...baseAsset, suggestedBridgeDeviceId: 'dev-42' } }))
        .mockResolvedValueOnce(devicesResponse([{ id: 'dev-42', displayName: 'Agent', status: 'online' }]))
        .mockResolvedValueOnce(makeJsonResponse({ error: 'Step-up required', code: 'MFA_REQUIRED' }, false, 403));

      render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
      await screen.findByTestId('network-device-detail');
      fireEvent.click(screen.getByTestId('network-detail-port-proxy-443'));
      const select = (await screen.findByTestId('proxy-popover-bridge-select')) as HTMLSelectElement;
      await waitFor(() => expect(select.value).toBe('dev-42'));
      fireEvent.click(screen.getByTestId('proxy-popover-connect'));

      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toMatch(/two-factor/i);
      expect(screen.getByTestId('network-detail-proxy-popover-443')).toBeTruthy();
    });

    // #reviewFix8: announce() set the same string twice in a row — React
    // bails out on the no-op state update, so the live region's DOM text
    // never actually changes and a screen reader never hears the repeat.
    it('re-announces an identical live-region message as a fresh, observable DOM mutation', async () => {
      const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
      fetchWithAuthMock
        .mockResolvedValueOnce(makeJsonResponse({ data: { ...baseAsset, suggestedBridgeDeviceId: 'dev-42' } }))
        .mockResolvedValueOnce(devicesResponse([{ id: 'dev-42', displayName: 'Agent', status: 'online' }]))
        .mockResolvedValueOnce(makeJsonResponse({ tunnel: { id: 'tunnel-a' } }, true, 201))
        .mockResolvedValueOnce(makeJsonResponse({ tunnel: { id: 'tunnel-b' } }, true, 201));

      render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
      await screen.findByTestId('network-device-detail');

      fireEvent.click(screen.getByTestId('network-detail-port-proxy-443'));
      let select = (await screen.findByTestId('proxy-popover-bridge-select')) as HTMLSelectElement;
      await waitFor(() => expect(select.value).toBe('dev-42'));
      fireEvent.click(screen.getByTestId('proxy-popover-connect'));

      await waitFor(() =>
        expect(screen.getByTestId('network-detail-live').textContent).toBe('Web UI opened in a new tab'),
      );

      const liveRegion = screen.getByTestId('network-detail-live');
      let mutationCount = 0;
      const observer = new MutationObserver(() => {
        mutationCount++;
      });
      observer.observe(liveRegion, { childList: true, characterData: true, subtree: true });

      // Reopen and connect again — the announced message is byte-identical to
      // the first time.
      fireEvent.click(screen.getByTestId('network-detail-port-proxy-443'));
      select = (await screen.findByTestId('proxy-popover-bridge-select')) as HTMLSelectElement;
      await waitFor(() => expect(select.value).toBe('dev-42'));
      fireEvent.click(screen.getByTestId('proxy-popover-connect'));

      await waitFor(() => expect(mutationCount).toBeGreaterThan(0));
      // announce() clears the region synchronously and re-sets the message on
      // a 0ms timer, so the first observed mutation is the CLEAR. Reading the
      // text synchronously here raced that timer and read '' under CI load
      // (reddened a main run on 2026-09-08) — wait for the re-set instead.
      await waitFor(() => expect(liveRegion.textContent).toBe('Web UI opened in a new tab'));
      // Two mutations = clear + re-set: proves the repeat was a real DOM change,
      // not a bailed-out no-op state update.
      expect(mutationCount).toBeGreaterThanOrEqual(2);

      observer.disconnect();
      openSpy.mockRestore();
    });

    it('announces "Web UI opened in a new tab" to the live region once Connect succeeds', async () => {
      const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
      fetchWithAuthMock
        .mockResolvedValueOnce(
          makeJsonResponse({ data: { ...baseAsset, suggestedBridgeDeviceId: 'dev-42' } }),
        )
        .mockResolvedValueOnce(devicesResponse([{ id: 'dev-42', displayName: 'Agent', status: 'online' }]))
        .mockResolvedValueOnce(makeJsonResponse({ tunnel: { id: 'tunnel-9' } }, true, 201));

      render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
      await screen.findByTestId('network-device-detail');

      fireEvent.click(screen.getByTestId('network-detail-port-proxy-443'));
      const select = (await screen.findByTestId('proxy-popover-bridge-select')) as HTMLSelectElement;
      await waitFor(() => expect(select.value).toBe('dev-42'));

      fireEvent.click(screen.getByTestId('proxy-popover-connect'));

      await waitFor(() =>
        expect(screen.getByTestId('network-detail-live').textContent).toBe('Web UI opened in a new tab'),
      );

      openSpy.mockRestore();
    });
  });

  describe('stat strip', () => {
    it('renders sourced reachability, last poll, ping and open ports stats', async () => {
      fetchWithAuthMock.mockResolvedValueOnce(
        makeJsonResponse({
          data: { ...baseAsset, linkedDeviceId: 'dev-9', linkedDeviceName: 'agent-host' },
        }),
      );

      render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
      await screen.findByTestId('network-device-detail');

      const stats = screen.getByTestId('network-detail-stats');
      expect(stats.textContent).toContain('Responding · SNMP');
      expect(stats.textContent).toContain('2.4 ms');
      await waitFor(() => expect(screen.getByTestId('network-detail-stat-last-poll')).toHaveTextContent('Polling'));
      expect(screen.getByTestId('network-detail-stat-last-poll')).not.toHaveTextContent('Not configured');
      // baseAsset.openPorts has 2 entries.
      expect(screen.getByTestId('network-detail-stat-ports').textContent).toContain('2');

      expect(screen.queryByTestId('network-detail-stat-linked')).toBeNull();
    });

    it('renders 0 (not a dash) for the open-ports stat when the asset has no open ports', async () => {
      fetchWithAuthMock.mockResolvedValueOnce(
        makeJsonResponse({ data: { ...baseAsset, openPorts: [] } }),
      );

      render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
      await screen.findByTestId('network-device-detail');

      expect(screen.getByTestId('network-detail-stat-ports').textContent).toContain('0');
    });

    it('clicking the open-ports stat switches to the overview tab and scrolls the ports section into view', async () => {
      fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ data: baseAsset }));
      const realScrollIntoView = Element.prototype.scrollIntoView;
      const scrollSpy = vi.fn();
      // jsdom has no layout and so no scrollIntoView implementation.
      Element.prototype.scrollIntoView = scrollSpy;

      try {
        render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
        await screen.findByTestId('network-device-detail');

        openMonitoringTab();
        await screen.findByTestId('network-detail-monitoring');

        fireEvent.click(screen.getByTestId('network-detail-stat-ports'));

        await screen.findByTestId('network-detail-overview');
        await waitFor(() => expect(scrollSpy).toHaveBeenCalledWith({ block: 'start' }));
      } finally {
        Element.prototype.scrollIntoView = realScrollIntoView;
      }
    });

    it('omits the linked-device stat when the asset is unlinked', async () => {
      fetchWithAuthMock.mockResolvedValueOnce(
        makeJsonResponse({ data: { ...baseAsset, linkedDeviceId: null } }),
      );

      render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
      await screen.findByTestId('network-device-detail');

      expect(screen.queryByTestId('network-detail-stat-linked')).toBeNull();
      const stats = screen.getByTestId('network-detail-stats');
      expect(stats.textContent).not.toContain('Linked device');
    });

    it('colors the ping value using the same thresholds as the discovery list', async () => {
      fetchWithAuthMock.mockResolvedValueOnce(
        makeJsonResponse({ data: { ...baseAsset, responseTimeMs: 2.4 } }),
      );

      render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
      await screen.findByTestId('network-device-detail');

      // 2.4ms falls in the fastest tier (pingColor thresholds in pingFormat.ts).
      expect(screen.getByTestId('network-detail-ping').className).toContain('text-success');
    });

    it('does not show an "as of" line when the asset has no last-seen timestamp', async () => {
      fetchWithAuthMock.mockResolvedValueOnce(
        makeJsonResponse({ data: { ...baseAsset, lastSeenAt: null, firstSeenAt: null } }),
      );

      render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
      await screen.findByTestId('network-device-detail');

      const stats = screen.getByTestId('network-detail-stats');
      expect(stats.textContent).not.toMatch(/as of/i);
    });
  });

  describe('hardening: loading, SNMP, ports, and background refresh', () => {
    it('shows a layout-matching loading skeleton (not a blank shell) before the asset loads', async () => {
      let resolveFetch!: (value: Response) => void;
      fetchWithAuthMock.mockImplementationOnce(
        () => new Promise((resolve) => { resolveFetch = resolve; }),
      );

      render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
      expect(screen.getByTestId('network-device-detail-loading')).toBeTruthy();
      expect(screen.queryByTestId('network-device-detail')).toBeNull();

      resolveFetch(makeJsonResponse({ data: baseAsset }));
      await screen.findByTestId('network-device-detail');
      expect(screen.queryByTestId('network-device-detail-loading')).toBeNull();
    });

    it('renders SNMP field labels from locale, including the Object ID (OID) field', async () => {
      fetchWithAuthMock
        .mockResolvedValueOnce(
          makeJsonResponse({
            data: {
              ...baseAsset,
              snmpData: { sysName: 'core-switch-01', sysDescr: 'Cisco IOS', sysObjectId: '1.3.6.1.4.1.9.1' },
            },
          }),
        )
        .mockResolvedValueOnce(devicesResponse([]));

      render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
      await screen.findByTestId('network-device-detail');

      const snmp = screen.getByTestId('network-detail-snmp');
      expect(snmp.textContent).toContain('System name');
      expect(snmp.textContent).toContain('Description');
      expect(snmp.textContent).toContain('Object ID (OID)');
      expect(snmp.textContent).toContain('1.3.6.1.4.1.9.1');
    });

    it('clamps a long SNMP value behind a Show more / Show less toggle', async () => {
      const longDescr = 'x'.repeat(250);
      fetchWithAuthMock
        .mockResolvedValueOnce(makeJsonResponse({ data: { ...baseAsset, snmpData: { sysDescr: longDescr } } }))
        .mockResolvedValueOnce(devicesResponse([]));

      render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
      await screen.findByTestId('network-device-detail');

      const toggle = screen.getByTestId('snmp-value-toggle-sysDescr');
      expect(toggle.textContent).toBe('Show more');
      expect(screen.getByTestId('network-detail-snmp').textContent).not.toContain(longDescr);

      fireEvent.click(toggle);
      expect(screen.getByTestId('network-detail-snmp').textContent).toContain(longDescr);
      expect(screen.getByTestId('snmp-value-toggle-sysDescr').textContent).toBe('Show less');
    });

    it('caps open-port chips at 12 with a Show all / Show fewer toggle', async () => {
      const manyPorts = Array.from({ length: 15 }, (_, i) => ({ port: 20000 + i, service: 'custom' }));
      fetchWithAuthMock
        .mockResolvedValueOnce(makeJsonResponse({ data: { ...baseAsset, openPorts: manyPorts } }))
        .mockResolvedValueOnce(devicesResponse([]));

      render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
      await screen.findByTestId('network-device-detail');

      const ports = screen.getByTestId('network-detail-ports');
      expect(ports.textContent).toContain('20000');
      expect(ports.textContent).not.toContain('20014');

      const toggle = screen.getByTestId('network-detail-ports-toggle');
      expect(toggle.textContent).toContain('Show all (15)');

      fireEvent.click(toggle);
      expect(screen.getByTestId('network-detail-ports').textContent).toContain('20014');
      expect(screen.getByTestId('network-detail-ports-toggle').textContent).toBe('Show fewer');
    });

    // #reviewFix2: portsExpanded used to live inside OpenPortsSection, which
    // unmounts when the Monitoring tab is active — so "Show all" silently
    // reset on every tab round-trip.
    it('keeps "Show all" ports expanded across a tab switch and back (state lifted to the page)', async () => {
      const manyPorts = Array.from({ length: 15 }, (_, i) => ({ port: 20000 + i, service: 'custom' }));
      fetchWithAuthMock
        .mockResolvedValueOnce(makeJsonResponse({ data: { ...baseAsset, openPorts: manyPorts } }))
        .mockResolvedValueOnce(devicesResponse([]));

      render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
      await screen.findByTestId('network-device-detail');

      fireEvent.click(screen.getByTestId('network-detail-ports-toggle'));
      expect(screen.getByTestId('network-detail-ports').textContent).toContain('20014');

      openMonitoringTab();
      await screen.findByTestId('network-detail-monitoring');

      fireEvent.click(screen.getByTestId('network-detail-tab-overview'));
      await screen.findByTestId('network-detail-overview');

      expect(screen.getByTestId('network-detail-ports').textContent).toContain('20014');
      expect(screen.getByTestId('network-detail-ports-toggle').textContent).toBe('Show fewer');
    });

    it('shows an "Unencrypted" warning badge on a risky plaintext port instead of an Open button', async () => {
      fetchWithAuthMock
        .mockResolvedValueOnce(
          makeJsonResponse({
            data: { ...baseAsset, openPorts: [{ port: 21, service: 'ftp' }, { port: 443, service: 'https' }] },
          }),
        )
        .mockResolvedValueOnce(devicesResponse([]));

      render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
      await screen.findByTestId('network-device-detail');

      const ports = screen.getByTestId('network-detail-ports');
      expect(ports.textContent).toContain('FTP');
      expect(ports.textContent).toContain('Unencrypted');
      expect(screen.queryByTestId('network-detail-port-proxy-21')).toBeNull();
    });

    // The insecure-port hint used to be reachable only as a `title` attribute
    // on a non-focusable span — invisible to a keyboard-only operator. It must
    // now render as visible text in the DOM.
    it('renders the insecure-port hint as visible text for a telnet row, not just a title', async () => {
      fetchWithAuthMock
        .mockResolvedValueOnce(
          makeJsonResponse({ data: { ...baseAsset, openPorts: [{ port: 23, service: 'telnet' }] } }),
        )
        .mockResolvedValueOnce(devicesResponse([]));

      render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
      await screen.findByTestId('network-device-detail');

      expect(
        screen.getByText('This service sends credentials in clear text. Disable it on the device if you can.'),
      ).toBeTruthy();
    });

    it('shows a muted kind label for a non-web, non-risky port', async () => {
      fetchWithAuthMock
        .mockResolvedValueOnce(
          makeJsonResponse({ data: { ...baseAsset, openPorts: [{ port: 3389, service: 'rdp' }] } }),
        )
        .mockResolvedValueOnce(devicesResponse([]));

      render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
      await screen.findByTestId('network-device-detail');

      const ports = screen.getByTestId('network-detail-ports');
      expect(ports.textContent).toContain('RDP');
      expect(ports.textContent).toContain('Remote access');
    });

    // #stepE cleanup: 'other' is the catch-all kind for uncatalogued/plain
    // ports (e.g. DNS) — it must render no kind label at all, and never
    // consult a locale key to do it (the empty `ports.kind.other` key was
    // removed from every locale file).
    it('renders no kind label, badge, or Open button for an "other" port (e.g. DNS)', async () => {
      fetchWithAuthMock
        .mockResolvedValueOnce(
          makeJsonResponse({ data: { ...baseAsset, openPorts: [{ port: 53, service: 'dns' }] } }),
        )
        .mockResolvedValueOnce(devicesResponse([]));

      render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
      await screen.findByTestId('network-device-detail');

      const ports = screen.getByTestId('network-detail-ports');
      expect(ports.textContent).toContain('DNS');
      expect(ports.textContent).not.toContain('Unencrypted');
      // No stray key-as-label text and no proxy trigger for this port.
      expect(ports.textContent).not.toMatch(/kind\.other/);
      expect(screen.queryByTestId('network-detail-port-proxy-53')).toBeNull();
    });

    it('shows the open port count in the section title', async () => {
      fetchWithAuthMock
        .mockResolvedValueOnce(makeJsonResponse({ data: baseAsset }))
        .mockResolvedValueOnce(devicesResponse([]));

      render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
      await screen.findByTestId('network-device-detail');

      expect(screen.getByTestId('network-detail-ports-count').textContent).toBe('2');
    });

    it('sorts open ports ascending by port number regardless of scan order', async () => {
      fetchWithAuthMock
        .mockResolvedValueOnce(
          makeJsonResponse({
            data: {
              ...baseAsset,
              openPorts: [
                { port: 443, service: 'https' },
                { port: 22, service: 'ssh' },
                { port: 8080, service: 'http-alt' },
              ],
            },
          }),
        )
        .mockResolvedValueOnce(devicesResponse([]));

      render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
      await screen.findByTestId('network-device-detail');

      const portNumbers = Array.from(
        screen.getByTestId('network-detail-ports').querySelectorAll('[data-testid="network-detail-port-number"]'),
      ).map((el) => el.textContent);
      expect(portNumbers).toEqual(['22', '443', '8080']);
    });

    it('renders duplicate-port entries with stable unique keys and no React key warning', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const dupPorts = [
        { port: 443, service: 'https' },
        { port: 443, service: 'https-alt' },
      ];
      fetchWithAuthMock
        .mockResolvedValueOnce(makeJsonResponse({ data: { ...baseAsset, openPorts: dupPorts } }))
        .mockResolvedValueOnce(devicesResponse([]));

      render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
      await screen.findByTestId('network-device-detail');

      const keyWarning = errorSpy.mock.calls.some(([msg]) => typeof msg === 'string' && /key/i.test(msg));
      expect(keyWarning).toBe(false);
      errorSpy.mockRestore();
    });

    it('treats a whitespace-only field value as empty', async () => {
      fetchWithAuthMock.mockResolvedValueOnce(
        makeJsonResponse({ data: { ...baseAsset, osFingerprint: '   ' } }),
      );

      render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
      await screen.findByTestId('network-device-detail');

      const label = screen.getByText('OS fingerprint');
      const dd = label.parentElement?.querySelector('dd');
      expect(dd?.textContent).toBe('—');
    });

    it('re-fetches the asset in place (no skeleton) after the tab is hidden 60+ seconds and becomes visible again', async () => {
      // Only `Date` is faked — `setTimeout` stays real so `waitFor`/`findBy*`
      // (which poll on real timers) keep working without extra `act()`
      // plumbing; only the elapsed-hidden-time math needs a virtual clock.
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        fetchWithAuthMock
          .mockResolvedValueOnce(makeJsonResponse({ data: baseAsset }))
          .mockResolvedValueOnce(devicesResponse([]))
          .mockResolvedValueOnce(makeJsonResponse({ data: { ...baseAsset, label: 'Refreshed Switch' } }));

        render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
        await screen.findByTestId('network-device-detail');

        Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));

        vi.setSystemTime(Date.now() + 65_000);

        Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));

        await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(3));
        expect(fetchWithAuthMock.mock.calls[2][0]).toBe(`/discovery/assets/${ASSET_ID}`);
        // Background refresh must not show the skeleton or drop existing content.
        expect(screen.queryByTestId('network-device-detail-loading')).toBeNull();
        expect(screen.getByTestId('network-device-detail')).toBeTruthy();
        // It's otherwise silent, so screen reader users hear it happened.
        await waitFor(() =>
          expect(screen.getByTestId('network-detail-live').textContent).toBe('Device details refreshed'),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not re-fetch when hidden for less than 60 seconds', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        fetchWithAuthMock
          .mockResolvedValueOnce(makeJsonResponse({ data: baseAsset }))
          .mockResolvedValueOnce(devicesResponse([]));

        render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
        await screen.findByTestId('network-device-detail');

        Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));

        vi.setSystemTime(Date.now() + 5_000);

        Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));

        // Give any (incorrect) async refetch a real tick to fire before
        // asserting its absence — `setTimeout` is real in this test.
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(fetchWithAuthMock).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('opens #topology with passive reads and resolves the canonical inventory binding', async () => {
    window.location.hash = '#topology';
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    fetchWithAuthMock.mockImplementation(async (url: string) => {
      if (url === `/discovery/assets/${ASSET_ID}`) return makeJsonResponse({ data: { ...baseAsset, siteId: SITE } });
      if (url.endsWith('/settings')) return makeJsonResponse(topologySettingsFixture());
      if (url.includes('/nodes?')) return makeJsonResponse({ siteId: SITE, graphRevision: '1', total: 1, nodes: topologyGraphFixture().nodes, cursor: null });
      if (url.includes('/graph?')) return makeJsonResponse(topologyGraphFixture());
      return makeJsonResponse({ data: [] });
    });
    const { unmount } = render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
    try {
      expect(await screen.findByTestId('topology-explorer')).toBeVisible();
      expect(await screen.findByTestId('topology-health-internet')).toHaveTextContent('Not measured');
      expect(fetchWithAuthMock.mock.calls.some(([url]) => String(url).includes(`focusNodeId=${NODE}`))).toBe(true);
      // Opening the map is passive: nothing but GETs leaves the page.
      expect(fetchWithAuthMock.mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true);
    } finally {
      unmount();
      vi.unstubAllGlobals();
      window.location.hash = '';
    }
  });
});
