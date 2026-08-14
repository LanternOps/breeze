import '@/lib/i18n';

import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DiscoveredAssetList, { mapAsset, toDetail, type ApiDiscoveryAsset } from './DiscoveredAssetList';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

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
    expect(badges[0]).toHaveTextContent('Same device as WS-FRONTDESK');
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

// CSV export: an MSP owner hands the discovered inventory to stakeholders for
// pricing/quoting. Two things are load-bearing and silently regressable — that
// the export follows the *filter* (a full-inventory dump would leak rows the
// user deliberately filtered out) and that formula-injection stays neutralized
// (hostname/manufacturer are attacker-influenced network data).
describe('DiscoveredAssetList — Export CSV', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  const exportAssets = [
    {
      id: 'asset-1',
      assetType: 'switch',
      approvalStatus: 'approved',
      isOnline: true,
      hostname: 'core-sw-01',
      ipAddress: '10.0.2.1',
      macAddress: 'aa:bb:cc:dd:ee:ff',
      manufacturer: 'Cisco',
      osFingerprint: 'Cisco IOS 15.2',
      openPorts: [{ port: 22, service: 'ssh' }, { port: 443, service: 'https' }],
      firstSeenAt: '2026-06-01T00:00:00.000Z',
      lastSeenAt: '2026-06-22T00:00:00.000Z',
    },
    {
      id: 'asset-2',
      assetType: 'printer',
      approvalStatus: 'pending',
      isOnline: false,
      // Hostile hostname straight off the wire: a spreadsheet would evaluate
      // this as a formula if it were written to the CSV unneutralized.
      hostname: '=HYPERLINK("http://evil","click")',
      ipAddress: '10.0.2.9',
      macAddress: '11:22:33:44:55:66',
      manufacturer: 'HP',
      openPorts: [],
      firstSeenAt: '2026-06-02T00:00:00.000Z',
      lastSeenAt: '2026-06-21T00:00:00.000Z',
    },
  ];

  /** Click Export CSV and return the CSV text handed to the download anchor. */
  const clickExportAndReadCsv = async (): Promise<{ csv: string; filename: string }> => {
    const blobs: Blob[] = [];
    const createObjectURL = vi.fn((blob: Blob) => {
      blobs.push(blob);
      return 'blob:mock';
    });
    // jsdom implements neither createObjectURL nor revokeObjectURL.
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, writable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), writable: true });

    let filename = '';
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        filename = this.download;
      });

    const buttons = await screen.findAllByRole('button', { name: /export csv/i });
    buttons[0]!.click();

    clickSpy.mockRestore();
    expect(blobs).toHaveLength(1);
    return { csv: await blobs[0]!.text(), filename };
  };

  it('exports the visible rows with human-readable headers and a dated filename', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: exportAssets }));
    vi.setSystemTime(new Date('2026-07-04T12:00:00.000Z'));

    render(<DiscoveredAssetList />);
    await waitFor(() => expect(screen.getAllByText('core-sw-01').length).toBeGreaterThan(0));

    const { csv, filename } = await clickExportAndReadCsv();

    expect(filename).toBe('discovered-assets-2026-07-04.csv');
    const lines = csv.split('\n');
    expect(lines[0]).toBe(
      '"IP Address","MAC Address","Hostname","Vendor","Asset Type","OS Guess","Open Ports","First Seen","Last Seen"',
    );
    // Both rows exported (no filter active), array cell collapsed readably.
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('"10.0.2.1"');
    expect(lines[1]).toContain('"22/ssh; 443/https"');
    expect(lines[1]).toContain('"Cisco IOS 15.2"');

    vi.useRealTimers();
  });

  it('neutralizes a formula-injecting hostname', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: exportAssets }));

    render(<DiscoveredAssetList />);
    await waitFor(() => expect(screen.getAllByText('core-sw-01').length).toBeGreaterThan(0));

    const { csv } = await clickExportAndReadCsv();

    // Leading "'" is the neutralizer; the raw "=..." must never appear at the
    // start of a cell.
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"",""click"")"`);
    expect(csv).not.toContain('"=HYPERLINK');
  });

  it('exports only the filtered rows, not the whole inventory', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: exportAssets }));

    render(<DiscoveredAssetList />);
    await waitFor(() => expect(screen.getAllByText('core-sw-01').length).toBeGreaterThan(0));

    // Narrow to the "approved" status chip; only asset-1 should survive.
    const approvedChip = screen.getAllByRole('button', { name: /approved/i })[0]!;
    approvedChip.click();

    await waitFor(() => expect(screen.queryByText('10.0.2.9')).not.toBeInTheDocument());

    const { csv } = await clickExportAndReadCsv();
    const lines = csv.split('\n');
    expect(lines).toHaveLength(2);
    expect(csv).toContain('"10.0.2.1"');
    expect(csv).not.toContain('"10.0.2.9"');
  });
});
