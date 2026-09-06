import '@/lib/i18n';

import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import NetworkDeviceDetailPage from './NetworkDeviceDetailPage';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { showToast } from '../shared/Toast';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

vi.mock('@/lib/navigation', () => ({
  navigateTo: vi.fn(),
}));

// runAction surfaces outcome through showToast; mock it so the popover's
// Connect assertions don't depend on the real toast DOM/timers.
vi.mock('../shared/Toast', () => ({
  showToast: vi.fn(),
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);
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

const baseAsset = {
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

// OverflowTabs measures button widths via `offsetWidth`, which jsdom always
// reports as 0 against a `clientWidth` of 0 — that collapses to "fits 1 tab"
// (see computeVisible in OverflowTabs.tsx), so with two tabs "Overview" stays
// visible and "Monitoring" always lands in the "More" dropdown in tests.
function openMonitoringTab() {
  fireEvent.click(screen.getByText('More'));
  fireEvent.click(screen.getByTestId('network-detail-tab-monitoring'));
}

describe('NetworkDeviceDetailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    expect(screen.getByTestId('network-device-status').textContent).toContain('Online');
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

  it('renders the offline state and a dash ping when the asset is down', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({ data: { ...baseAsset, isOnline: false, responseTimeMs: null } }),
    );

    render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
    await screen.findByTestId('network-device-detail');

    expect(screen.getByTestId('network-device-status').textContent).toContain('Offline');
    expect(screen.getByTestId('network-detail-ping').textContent).toBe('—');
  });

  it('shows empty-state guidance for an asset with no SNMP data and no open ports', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({ data: { ...baseAsset, snmpData: {}, openPorts: [] } }),
    );

    render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
    await screen.findByTestId('network-device-detail');

    expect(screen.getByTestId('network-detail-snmp').textContent).toContain('No SNMP data was collected');
    expect(screen.getByTestId('network-detail-ports').textContent).toContain('No open ports detected');
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
    expect(monitoring.textContent).toContain('SNMP monitoring');
    expect(monitoring.textContent).toContain('Enabled');
    expect(monitoring.textContent).toContain('Not linked');
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

    openMonitoringTab();
    const link = await screen.findByTestId('network-detail-linked-device');
    expect(link.getAttribute('href')).toBe('/devices/dev-9');
    expect(link.textContent).toContain('agent-host');
    expect(screen.getByTestId('network-detail-link-provenance').textContent).toContain('auto-detected');
  });

  it('shows Unlink for a manually linked asset, labeled "set manually"', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({
        data: { ...baseAsset, linkedDeviceId: 'dev-9', linkedDeviceName: 'agent-host', linkSource: 'manual' },
      }),
    );

    render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
    await screen.findByTestId('network-device-detail');
    openMonitoringTab();

    expect(await screen.findByTestId('network-detail-unlink')).toBeTruthy();
    expect(screen.getByTestId('network-detail-link-provenance').textContent).toContain('set manually');
  });

  // #3261 regression: unlink used to be hidden for auto-links (the 2026-06-27
  // manual-only rule). Suppression makes unlink meaningful for both
  // provenances, so the server accepts it and the button must render.
  it('shows Unlink for an auto-linked asset too (#3261)', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({
        data: { ...baseAsset, linkedDeviceId: 'dev-9', linkedDeviceName: 'agent-host', linkSource: 'auto' },
      }),
    );

    render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
    await screen.findByTestId('network-device-detail');
    openMonitoringTab();

    await screen.findByTestId('network-detail-linked-device');
    expect(screen.getByTestId('network-detail-unlink')).toBeTruthy();
  });

  it('shows the "Auto-linking disabled" line when unlinked and suppressed', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({
        data: { ...baseAsset, linkedDeviceId: null, autoLinkSuppressedAt: '2026-08-08T00:00:00.000Z' },
      }),
    );

    render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
    await screen.findByTestId('network-device-detail');
    openMonitoringTab();

    await screen.findByTestId('network-detail-monitoring');
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
    openMonitoringTab();

    await screen.findByTestId('network-detail-monitoring');
    expect(screen.queryByTestId('network-detail-suppressed')).toBeNull();
  });

  describe('"Link manually…" picker (#3261)', () => {
    it('fetches devices scoped to the asset\'s site and links the chosen device via runAction', async () => {
      fetchWithAuthMock
        .mockResolvedValueOnce(
          makeJsonResponse({ data: { ...baseAsset, linkedDeviceId: null, siteId: 'site-1' } }),
        )
        .mockResolvedValueOnce(devicesResponse([])) // mount's unscoped proxy-popover device fetch
        .mockResolvedValueOnce(
          devicesResponse([{ id: 'dev-5', displayName: 'WS-5', status: 'online' }]),
        ) // site-scoped picker fetch
        .mockResolvedValueOnce(makeJsonResponse({ success: true }))
        .mockResolvedValueOnce(
          makeJsonResponse({ data: { ...baseAsset, linkedDeviceId: 'dev-5', linkedDeviceName: 'WS-5', linkSource: 'manual' } }),
        );

      render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
      await screen.findByTestId('network-device-detail');
      openMonitoringTab();

      fireEvent.click(await screen.findByTestId('network-detail-link-manually'));

      await waitFor(() =>
        expect(fetchWithAuthMock).toHaveBeenCalledWith('/devices?siteId=site-1'),
      );

      const select = (await screen.findByTestId(
        'network-detail-link-manually-select',
      )) as HTMLSelectElement;
      fireEvent.change(select, { target: { value: 'dev-5' } });

      fireEvent.click(screen.getByTestId('network-detail-link-manually-submit'));

      await waitFor(() =>
        expect(fetchWithAuthMock).toHaveBeenCalledWith(
          `/discovery/assets/${ASSET_ID}/link`,
          expect.objectContaining({ method: 'POST', body: JSON.stringify({ deviceId: 'dev-5' }) }),
        ),
      );
    });

    it('surfaces a server error inline without closing the picker', async () => {
      fetchWithAuthMock
        .mockResolvedValueOnce(
          makeJsonResponse({ data: { ...baseAsset, linkedDeviceId: null, siteId: 'site-1' } }),
        )
        .mockResolvedValueOnce(devicesResponse([]))
        .mockResolvedValueOnce(
          devicesResponse([{ id: 'dev-5', displayName: 'WS-5', status: 'online' }]),
        )
        .mockResolvedValueOnce(
          makeJsonResponse({ error: 'Device belongs to a different site' }, false, 400),
        );

      render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
      await screen.findByTestId('network-device-detail');
      openMonitoringTab();

      fireEvent.click(await screen.findByTestId('network-detail-link-manually'));
      const select = (await screen.findByTestId(
        'network-detail-link-manually-select',
      )) as HTMLSelectElement;
      fireEvent.change(select, { target: { value: 'dev-5' } });
      fireEvent.click(screen.getByTestId('network-detail-link-manually-submit'));

      expect(
        await screen.findByTestId('network-detail-link-manually-error'),
      ).toHaveTextContent('Device belongs to a different site');
      // The picker stays open on failure so the user can retry.
      expect(screen.getByTestId('network-detail-link-manually-picker')).toBeTruthy();
    });
  });

  it('hides Unlink for an unlinked asset', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ data: baseAsset }));

    render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
    await screen.findByTestId('network-device-detail');
    openMonitoringTab();

    await screen.findByTestId('network-detail-monitoring');
    expect(screen.queryByTestId('network-detail-unlink')).toBeNull();
  });

  it('opens a confirm dialog before unlinking, and calls DELETE once confirmed', async () => {
    fetchWithAuthMock
      .mockResolvedValueOnce(
        makeJsonResponse({
          data: { ...baseAsset, linkedDeviceId: 'dev-9', linkedDeviceName: 'agent-host', linkSource: 'manual' },
        }),
      )
      .mockResolvedValueOnce(makeJsonResponse({ data: { ...baseAsset, linkedDeviceId: 'dev-9' } }))
      .mockResolvedValueOnce(makeJsonResponse({ data: { ...baseAsset, linkedDeviceId: null, linkSource: null } }));

    render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
    await screen.findByTestId('network-device-detail');
    openMonitoringTab();

    fireEvent.click(await screen.findByTestId('network-detail-unlink'));

    // The DELETE must not fire until the dialog is confirmed.
    const dialog = await screen.findByTestId('network-detail-unlink-confirm');
    expect(
      fetchWithAuthMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'DELETE'),
    ).toBe(false);
    expect(screen.getByText('The discovery asset and the managed device will be shown as separate items. Auto-linking stays off for this asset until you link it again.')).toBeTruthy();

    fireEvent.click(dialog);

    await waitFor(() =>
      expect(fetchWithAuthMock).toHaveBeenCalledWith(
        `/discovery/assets/${ASSET_ID}/link`,
        { method: 'DELETE' },
      ),
    );
  });

  it('does not call DELETE when the unlink confirmation is cancelled', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({
        data: { ...baseAsset, linkedDeviceId: 'dev-9', linkedDeviceName: 'agent-host', linkSource: 'manual' },
      }),
    );

    render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
    await screen.findByTestId('network-device-detail');
    openMonitoringTab();

    fireEvent.click(await screen.findByTestId('network-detail-unlink'));
    await screen.findByTestId('network-detail-unlink-confirm');

    fireEvent.click(screen.getByText('Cancel'));

    await waitFor(() => expect(screen.queryByTestId('network-detail-unlink-confirm')).toBeNull());
    expect(
      fetchWithAuthMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'DELETE'),
    ).toBe(false);
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

  it('changing the type Select issues a PATCH with the chosen assetType', async () => {
    fetchWithAuthMock
      // initial load (type=workstation)
      .mockResolvedValueOnce(makeJsonResponse({ data: { ...baseAsset, assetType: 'workstation' } }))
      // PATCH response
      .mockResolvedValueOnce(makeJsonResponse({ data: { ...baseAsset, assetType: 'router', typeSource: 'manual' } }))
      // reload after the change
      .mockResolvedValueOnce(makeJsonResponse({ data: { ...baseAsset, assetType: 'router', typeSource: 'manual' } }));

    render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
    await screen.findByTestId('network-device-detail');

    const select = screen.getByTestId('network-asset-type-select') as HTMLSelectElement;
    expect(select.value).toBe('workstation');

    fireEvent.change(select, { target: { value: 'router' } });

    await waitFor(() =>
      expect(fetchWithAuthMock).toHaveBeenCalledWith(
        `/discovery/assets/${ASSET_ID}`,
        expect.objectContaining({ method: 'PATCH' }),
      ),
    );

    const patchCall = fetchWithAuthMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === 'PATCH',
    );
    expect(patchCall).toBeTruthy();
    const body = JSON.parse((patchCall![1] as RequestInit).body as string);
    expect(body).toEqual({ assetType: 'router' });
  });

  it('shows a reset-to-auto control only when typeSource is manual', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({ data: { ...baseAsset, typeSource: 'manual', detectedAssetType: 'workstation' } }),
    );

    const { unmount } = render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
    await screen.findByTestId('network-device-detail');
    expect(screen.getByTestId('network-asset-type-reset')).toBeTruthy();

    unmount();
    vi.clearAllMocks();

    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({ data: { ...baseAsset, typeSource: 'auto' } }),
    );
    render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
    await screen.findByTestId('network-device-detail');
    expect(screen.queryByTestId('network-asset-type-reset')).toBeNull();
  });

  it('resets the type to auto-detected via PATCH when the reset control is clicked', async () => {
    fetchWithAuthMock
      .mockResolvedValueOnce(
        makeJsonResponse({ data: { ...baseAsset, typeSource: 'manual', detectedAssetType: 'workstation' } }),
      )
      .mockResolvedValueOnce(makeJsonResponse({ data: { ...baseAsset, typeSource: 'auto' } }))
      .mockResolvedValueOnce(makeJsonResponse({ data: { ...baseAsset, typeSource: 'auto' } }));

    render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
    await screen.findByTestId('network-device-detail');

    fireEvent.click(screen.getByTestId('network-asset-type-reset'));

    await waitFor(() =>
      expect(fetchWithAuthMock).toHaveBeenCalledWith(
        `/discovery/assets/${ASSET_ID}`,
        expect.objectContaining({ method: 'PATCH' }),
      ),
    );

    const patchCall = fetchWithAuthMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === 'PATCH',
    );
    const body = JSON.parse((patchCall![1] as RequestInit).body as string);
    expect(body).toEqual({ resetTypeToAuto: true });
  });

  it('disables the type select while a change is in flight, then re-enables it', async () => {
    let resolvePatch!: (value: Response) => void;
    const patchPromise = new Promise<Response>((resolve) => {
      resolvePatch = resolve;
    });

    fetchWithAuthMock
      // initial load
      .mockResolvedValueOnce(makeJsonResponse({ data: { ...baseAsset, assetType: 'workstation' } }))
      // mount's device-list fetch (proxy bridge picker) — fires alongside the
      // asset load and would otherwise consume the PATCH mock's slot below.
      .mockResolvedValueOnce(devicesResponse([]))
      // PATCH — stays pending until we resolve it
      .mockReturnValueOnce(patchPromise as unknown as Promise<Response>)
      // reload after the change
      .mockResolvedValueOnce(makeJsonResponse({ data: { ...baseAsset, assetType: 'router', typeSource: 'manual' } }));

    render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
    await screen.findByTestId('network-device-detail');

    const select = screen.getByTestId('network-asset-type-select') as HTMLSelectElement;
    expect(select.disabled).toBe(false);

    fireEvent.change(select, { target: { value: 'router' } });

    await waitFor(() => expect(select.disabled).toBe(true));

    resolvePatch(makeJsonResponse({ data: { ...baseAsset, assetType: 'router', typeSource: 'manual' } }));

    await waitFor(() => expect(select.disabled).toBe(false));
  });

  it('points the "Manage in Discovery" link at the discovery asset deep-link', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ data: baseAsset }));

    render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
    await screen.findByTestId('network-device-detail');

    const link = screen.getByTestId('network-detail-manage-discovery');
    expect(link.getAttribute('href')).toBe(`/discovery?asset=${ASSET_ID}#assets`);
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
  });

  describe('stat strip', () => {
    it('renders status, ping, last seen and linked device stats', async () => {
      fetchWithAuthMock.mockResolvedValueOnce(
        makeJsonResponse({
          data: { ...baseAsset, linkedDeviceId: 'dev-9', linkedDeviceName: 'agent-host' },
        }),
      );

      render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
      await screen.findByTestId('network-device-detail');

      const stats = screen.getByTestId('network-detail-stats');
      expect(stats.textContent).toContain('Online');
      expect(stats.textContent).toContain('2.4 ms');
      // baseAsset.lastSeenAt is well over a week in the past relative to any
      // real test run, so formatLastSeen falls back to an absolute date —
      // stable to assert on without mocking the clock.
      expect(stats.textContent).toMatch(/as of/i);

      const linked = screen.getByTestId('network-detail-stat-linked');
      expect(linked.getAttribute('href')).toBe('/devices/dev-9');
      expect(linked.textContent).toContain('agent-host');
    });

    it('shows a dash for the linked-device stat when the asset is unlinked', async () => {
      fetchWithAuthMock.mockResolvedValueOnce(
        makeJsonResponse({ data: { ...baseAsset, linkedDeviceId: null } }),
      );

      render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
      await screen.findByTestId('network-device-detail');

      expect(screen.queryByTestId('network-detail-stat-linked')).toBeNull();
      const stats = screen.getByTestId('network-detail-stats');
      expect(stats.textContent).toContain('—');
    });

    it('colors the ping value using the same thresholds as the discovery list', async () => {
      fetchWithAuthMock.mockResolvedValueOnce(
        makeJsonResponse({ data: { ...baseAsset, responseTimeMs: 2.4 } }),
      );

      render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
      await screen.findByTestId('network-device-detail');

      // 2.4ms falls in the fastest tier (pingColor thresholds in pingFormat.ts).
      expect(screen.getByTestId('network-detail-ping').className).toContain('text-green-600');
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
});
