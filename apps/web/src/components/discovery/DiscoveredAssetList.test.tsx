import '@/lib/i18n';

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DiscoveredAssetList, { mapAsset, toDetail, type ApiDiscoveryAsset } from './DiscoveredAssetList';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
const navigateMock = vi.mocked(navigateTo);
const fetchMock = vi.mocked(fetchWithAuth);

const jsonResponse = (payload: unknown, ok = true): Response =>
  ({
    ok,
    status: ok ? 200 : 500,
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

// These guard the load-bearing transform seam for #1731: the API now projects
// snmpData, but the modal is fed through mapAsset → toDetail. If either transform
// drops snmpData/discoveryMethods, the SNMP card silently regresses to empty with
// no type error — exactly the bug class this PR fixes. The API test proves the
// server emits the fields and the modal test proves it renders an AssetDetail that
// has them; these tests prove the middle carries them through.

const apiAsset: ApiDiscoveryAsset = {
  id: 'asset-1',
  assetType: 'switch',
  approvalStatus: 'pending',
  isOnline: true,
  hostname: 'core-sw-01',
  ipAddress: '10.0.2.1',
  macAddress: 'aa:bb:cc:dd:ee:ff',
  manufacturer: 'Cisco',
  openPorts: [],
  snmpData: { sysName: 'core-sw-01', sysDescr: 'Cisco IOS', sysObjectId: '1.3.6.1.4.1.9.1.1' },
  discoveryMethods: ['ping', 'snmp'],
  lastSeenAt: '2026-06-22T00:00:00.000Z',
};

describe('DiscoveredAssetList transforms — snmpData seam (#1731)', () => {
  it('mapAsset carries snmpData and discoveryMethods through from the API DTO', () => {
    const mapped = mapAsset(apiAsset);
    expect(mapped.snmpData).toEqual(apiAsset.snmpData);
    expect(mapped.discoveryMethods).toEqual(['ping', 'snmp']);
  });

  it('toDetail preserves snmpData for the detail modal', () => {
    const detail = toDetail(mapAsset(apiAsset));
    expect(detail.snmpData).toEqual(apiAsset.snmpData);
    expect(detail.discoveryMethods).toEqual(['ping', 'snmp']);
  });

  it('toDetail coerces missing snmpData to an empty object (no undefined leak)', () => {
    const detail = toDetail(mapAsset({ ...apiAsset, snmpData: null }));
    expect(detail.snmpData).toEqual({});
  });
});

it('mapAsset carries typeSource and detectedType through', () => {
  const mapped = mapAsset({
    id: 'a1', assetType: 'router', typeSource: 'manual', detectedAssetType: 'workstation'
  } as any);
  expect(mapped.typeSource).toBe('manual');
  expect(mapped.detectedType).toBe('workstation');
});

it('mapAsset defaults typeSource to auto and detectedType to null when absent', () => {
  const mapped = mapAsset({ id: 'a2', assetType: 'server' } as any);
  expect(mapped.typeSource).toBe('auto');
  expect(mapped.detectedType).toBe(null);
});

it('mapAsset falls back to unknown for an unrecognized detectedAssetType', () => {
  const mapped = mapAsset({ id: 'a3', assetType: 'server', detectedAssetType: 'martian-device' } as any);
  expect(mapped.detectedType).toBe('unknown');
});

it('mapAsset defends an invalid typeSource string to auto', () => {
  const mapped = mapAsset({ id: 'a4', assetType: 'server', typeSource: 'garbage' } as any);
  expect(mapped.typeSource).toBe('auto');
});

it('mapAsset preserves a manual typeSource', () => {
  const mapped = mapAsset({ id: 'a5', assetType: 'server', typeSource: 'manual' } as any);
  expect(mapped.typeSource).toBe('manual');
});

// #3261: replaces the old bare check + name with a labeled "Same device as"
// badge, and the modal no longer needs a devices prop (its picker is gone).
describe('DiscoveredAssetList — "Same device as" badge (#3261)', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('renders a labeled badge linking to the linked device', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        data: [
          {
            id: 'asset-1',
            assetType: 'workstation',
            approvalStatus: 'approved',
            isOnline: true,
            hostname: 'ws-01',
            ipAddress: '10.0.0.5',
            linkedDeviceId: 'dev-1',
            linkedDeviceName: 'WS-FRONTDESK',
            linkSource: 'auto',
          },
        ],
      }),
    );

    render(<DiscoveredAssetList />);

    // ResponsiveTable renders both a desktop table and a mobile card view of
    // the same row (one hidden via CSS, not the DOM) — assert on the first.
    const badges = await screen.findAllByTestId('discovered-asset-same-device-badge');
    expect(badges.length).toBeGreaterThan(0);
    expect(badges[0]).toHaveTextContent(/^Agent$/);
    expect(badges[0]).not.toHaveTextContent('Same device as');
    expect(badges[0]!.getAttribute('title')).toBe('WS-FRONTDESK');
    expect(badges[0]!.getAttribute('href')).toBe('/devices/dev-1');
  });

  it('renders no badge for an unlinked asset', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        data: [
          {
            id: 'asset-2',
            assetType: 'workstation',
            approvalStatus: 'pending',
            isOnline: true,
            hostname: 'ws-02',
            ipAddress: '10.0.0.6',
            linkedDeviceId: null,
          },
        ],
      }),
    );

    render(<DiscoveredAssetList />);

    await waitFor(() => expect(screen.getAllByText('ws-02').length).toBeGreaterThan(0));
    expect(screen.queryByTestId('discovered-asset-same-device-badge')).not.toBeInTheDocument();
  });

  it('never fetches /devices now that the modal has no device picker to feed', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [] }));

    render(<DiscoveredAssetList />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls.some(([url]) => url === '/devices')).toBe(false);
  });
});



describe('DiscoveredAssetList — settings hand-off and hook-routed triage (W04)', () => {
  const listAsset: ApiDiscoveryAsset = {
    ...apiAsset,
    id: 'asset-7',
    approvalStatus: 'pending',
  };

  beforeEach(() => {
    fetchMock.mockReset();
    navigateMock.mockReset();
    fetchMock.mockResolvedValue(jsonResponse({ data: [listAsset] }));
  });

  it('opens the device page on the Monitoring section from the row action', async () => {
    render(<DiscoveredAssetList />);
    const button = (await screen.findAllByTestId('discovered-asset-settings-asset-7'))[0]!;

    fireEvent.click(button);

    expect(navigateMock).toHaveBeenCalledWith('/devices/network/asset-7#overview/settings/monitoring');
  });

  it('does not open the peek modal when the settings action is clicked', async () => {
    render(<DiscoveredAssetList />);
    fireEvent.click((await screen.findAllByTestId('discovered-asset-settings-asset-7'))[0]!);

    expect(screen.queryByTestId('asset-modal-open-device-page')).not.toBeInTheDocument();
  });

  it('approves through the mutation hook and refetches the list', async () => {
    render(<DiscoveredAssetList />);
    fireEvent.click((await screen.findAllByTestId('discovered-asset-approve-asset-7'))[0]!);

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url, init]) =>
        url === '/discovery/assets/asset-7/approve' && (init as RequestInit)?.method === 'PATCH')).toBe(true),
    );
    // One list load on mount, the PATCH, then the reload.
    await waitFor(() =>
      expect(fetchMock.mock.calls.filter(([url]) => url === '/discovery/assets').length).toBe(2),
    );
  });

  it('dismisses through the mutation hook', async () => {
    render(<DiscoveredAssetList />);
    fireEvent.click((await screen.findAllByTestId('discovered-asset-dismiss-asset-7'))[0]!);

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url, init]) =>
        url === '/discovery/assets/asset-7/dismiss' && (init as RequestInit)?.method === 'PATCH')).toBe(true),
    );
  });

  it('still bulk-approves through the list-level endpoint (deliberately not the hook)', async () => {
    render(<DiscoveredAssetList />);
    fireEvent.click(await screen.findByLabelText('Select all visible assets'));
    fireEvent.click(screen.getByRole('button', { name: /Approve selected/ }));

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => url === '/discovery/assets/bulk-approve')).toBe(true),
    );
  });
});

it('preserves API reachability through the list-to-peek transform', () => {
  const reachability = { state: 'responding', source: 'snmp', observedAt: '2026-09-15T10:00:00Z', lastKnown: null } as const;
  expect(toDetail(mapAsset({ ...apiAsset, reachability })).reachability).toEqual(reachability);
});

it('preserves agent-reported BMC provenance through both asset transforms', () => {
  const mapped = mapAsset({ id: 'bmc-1', ipAddress: '192.0.2.10', linkedDeviceId: 'dev-9', linkSource: 'agent_report' });
  expect(mapped.linkSource).toBe('agent_report');
  expect(toDetail(mapped).linkSource).toBe('agent_report');
});
