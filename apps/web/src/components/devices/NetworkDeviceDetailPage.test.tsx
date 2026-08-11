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
    expect(ports.textContent).toContain('22 (ssh)');
    expect(ports.textContent).toContain('443 (https)');

    const snmp = screen.getByTestId('network-detail-snmp');
    expect(snmp.textContent).toContain('System Name');
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

    fireEvent.click(screen.getByTestId('network-detail-tab-monitoring'));

    await screen.findByTestId('network-detail-monitoring');
    expect(window.location.hash).toBe('#monitoring');
    const monitoring = screen.getByTestId('network-detail-monitoring');
    expect(monitoring.textContent).toContain('SNMP Monitoring');
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

  it('renders a link to the managed device when the asset is linked', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({
        data: { ...baseAsset, linkedDeviceId: 'dev-9', linkedDeviceName: 'agent-host' },
      }),
    );

    render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
    await screen.findByTestId('network-device-detail');

    fireEvent.click(screen.getByTestId('network-detail-tab-monitoring'));
    const link = await screen.findByTestId('network-detail-linked-device');
    expect(link.getAttribute('href')).toBe('/devices/dev-9');
    expect(link.textContent).toContain('agent-host');
  });

  it('shows Unlink for a manually linked asset', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({
        data: { ...baseAsset, linkedDeviceId: 'dev-9', linkedDeviceName: 'agent-host', linkSource: 'manual' },
      }),
    );

    render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
    await screen.findByTestId('network-device-detail');
    fireEvent.click(screen.getByTestId('network-detail-tab-monitoring'));

    expect(await screen.findByTestId('network-detail-unlink')).toBeTruthy();
  });

  it('hides Unlink for an auto-linked asset', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({
        data: { ...baseAsset, linkedDeviceId: 'dev-9', linkedDeviceName: 'agent-host', linkSource: 'auto' },
      }),
    );

    render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
    await screen.findByTestId('network-device-detail');
    fireEvent.click(screen.getByTestId('network-detail-tab-monitoring'));

    await screen.findByTestId('network-detail-linked-device');
    expect(screen.queryByTestId('network-detail-unlink')).toBeNull();
  });

  it('hides Unlink for an unlinked asset', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ data: baseAsset }));

    render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
    await screen.findByTestId('network-device-detail');
    fireEvent.click(screen.getByTestId('network-detail-tab-monitoring'));

    await screen.findByTestId('network-detail-monitoring');
    expect(screen.queryByTestId('network-detail-unlink')).toBeNull();
  });

  it('calls DELETE on the link endpoint when unlink is confirmed', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
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
    fireEvent.click(screen.getByTestId('network-detail-tab-monitoring'));

    fireEvent.click(await screen.findByTestId('network-detail-unlink'));

    await waitFor(() =>
      expect(fetchWithAuthMock).toHaveBeenCalledWith(
        `/discovery/assets/${ASSET_ID}/link`,
        { method: 'DELETE' },
      ),
    );
    confirmSpy.mockRestore();
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
    it('renders the "Open Web UI" trigger only for web-ish ports', async () => {
      fetchWithAuthMock
        .mockResolvedValueOnce(makeJsonResponse({ data: baseAsset }))
        .mockResolvedValueOnce(devicesResponse([]));

      render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
      await screen.findByTestId('network-device-detail');

      // baseAsset.openPorts = [{port: 22, service: 'ssh'}, {port: 443, service: 'https'}]
      expect(screen.getByTestId('network-detail-port-proxy-443')).toBeTruthy();
      expect(screen.queryByTestId('network-detail-port-proxy-22')).toBeNull();
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
        expect(screen.getByText('This target has been disabled for proxy access. An administrator must re-enable it in Settings before you can connect.')).toBeTruthy(),
      );
      expect(openSpy).not.toHaveBeenCalled();
      expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));

      openSpy.mockRestore();
    });
  });
});
