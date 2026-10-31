import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import DeviceList, { type Device } from './DeviceList';
import { DEFAULT_VISIBLE_COLUMNS, writeColumnVisibility } from './columnVisibility';
import { writeVisibleCustomFieldKeys } from './customFieldColumnVisibility';
import { useCustomFieldDefinitionsStore } from '../../stores/customFieldDefinitions';
import { fetchWithAuth } from '../../stores/auth';
import { downloadBlob } from '../../lib/downloadBlob';
import { csvRow } from '../../lib/csvExport';

// #9726: Export CSV on the Devices list — the full filtered set (not the drawn
// page), or the checked rows; visible columns in drawn order.

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn(), registerOrgIdProvider: vi.fn() }));
vi.mock('@/stores/orgStore', () => ({
  useOrgStore: (selector: (s: { currentOrgId: string | null; allOrgs: boolean }) => unknown) =>
    selector({ currentOrgId: null, allOrgs: true }),
}));
vi.mock('../remote/ConnectDesktopButton', () => ({ default: () => null }));
vi.mock('@/lib/formatTime', () => ({ formatLastSeen: () => 'just now' }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../../lib/permissions', () => ({
  usePermissions: () => ({ permissions: [], can: () => true }),
  hasPermission: () => true,
}));
vi.mock('../../lib/downloadBlob', () => ({ downloadBlob: vi.fn() }));

const fetchMock = vi.mocked(fetchWithAuth);
const downloadMock = vi.mocked(downloadBlob);

function device(n: number, overrides: Partial<Device> = {}): Device {
  const id = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  return {
    id,
    deviceClass: 'agent',
    hostname: `host-${String(n).padStart(2, '0')}`,
    os: 'linux',
    osVersion: '22.04',
    status: 'online',
    cpuPercent: 1,
    ramPercent: 1,
    lastSeen: '2026-10-01T12:00:00.000Z',
    orgId: 'org-1',
    orgName: 'Acme',
    siteId: 'site-1',
    siteName: 'HQ',
    agentVersion: '0.110.0',
    tags: [],
    ...overrides,
  };
}

const fleet = Array.from({ length: 23 }, (_, i) => device(i + 1));

async function exportedCsv(): Promise<string> {
  await waitFor(() => expect(downloadMock).toHaveBeenCalledTimes(1));
  return await (downloadMock.mock.calls[0]![0] as Blob).text();
}
const lines = (csv: string) => csv.split('\n');
// toCsv quotes every cell; compare through the same serializer.
const row = (...cells: string[]) => csvRow(cells);
const firstCell = (line: string) => line.slice(1, line.indexOf('"', 1));

beforeEach(() => {
  fetchMock.mockReset();
  downloadMock.mockReset();
  writeColumnVisibility([...DEFAULT_VISIBLE_COLUMNS]);
  useCustomFieldDefinitionsStore.setState({ definitions: [], status: 'idle' });
});
afterEach(() => {
  window.localStorage.clear();
});

describe('DeviceList — Export CSV (#9726)', () => {
  it('exports every filtered device, not just the drawn page', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ counts: {} }) } as unknown as Response);
    render(<DeviceList devices={fleet} pageSize={10} />);
    expect(screen.getAllByTestId(/^device-.*-select$/)).toHaveLength(10);

    fireEvent.click(screen.getByTestId('device-list-export-csv'));
    const out = lines(await exportedCsv());

    expect(out).toHaveLength(1 + 23);
    expect(out[0]!.startsWith('"Device",')).toBe(true);
    expect(out.some((l) => l.startsWith('"host-23",'))).toBe(true);
    expect(downloadMock.mock.calls[0]![1]).toMatch(/^devices-\d{4}-\d{2}-\d{2}\.csv$/);
  });

  it('applies the active filter: only matching devices are exported', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ counts: {} }) } as unknown as Response);
    render(<DeviceList devices={fleet} pageSize={10} listFilters={{ search: 'host-2', vpn: 'all' }} />);

    fireEvent.click(screen.getByTestId('device-list-export-csv'));
    const out = lines(await exportedCsv());

    // 'host-2' matches host-20..host-23 only (not host-02)
    expect(out.slice(1).map((l) => firstCell(l))).toEqual(
      ['host-20', 'host-21', 'host-22', 'host-23'],
    );
  });

  it('exports only the checked rows when any are checked', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ counts: {} }) } as unknown as Response);
    render(<DeviceList devices={fleet} pageSize={10} />);
    fireEvent.click(screen.getByTestId(`device-${fleet[2]!.id}-select`));
    fireEvent.click(screen.getByTestId(`device-${fleet[4]!.id}-select`));

    expect(screen.getByTestId('device-list-export-csv').textContent).toContain('2');
    fireEvent.click(screen.getByTestId('device-list-export-csv'));
    const out = lines(await exportedCsv());

    expect(out.slice(1).map((l) => firstCell(l))).toEqual(['host-03', 'host-05']);
  });

  it('exports the visible columns in their current order, hostname first', async () => {
    writeColumnVisibility(['hostname', 'status', 'site', 'agentVersion']);
    render(<DeviceList devices={[fleet[0]!]} pageSize={10} />);

    fireEvent.click(screen.getByTestId('device-list-export-csv'));
    const out = lines(await exportedCsv());

    expect(out[0]).toBe(row('Device', 'Site', 'Status', 'Agent Version'));
    expect(out[1]).toBe(row('host-01', 'HQ', 'Online', '0.110.0'));
  });

  it('neutralises a formula-looking hostname', async () => {
    writeColumnVisibility(['hostname']);
    render(<DeviceList devices={[device(1, { hostname: '=HYPERLINK("x")' })]} pageSize={10} />);

    fireEvent.click(screen.getByTestId('device-list-export-csv'));
    const csv = await exportedCsv();

    expect(lines(csv)[1]).toBe(row(`'=HYPERLINK("x")`));
    expect(lines(csv)[1]!.startsWith('=')).toBe(false);
  });

  it('includes a visible custom-field column', async () => {
    useCustomFieldDefinitionsStore.setState({
      definitions: [
        {
          id: 'cf-1', orgId: null, partnerId: 'p1', name: 'Store #', fieldKey: 'store', type: 'text',
          options: null, required: false, defaultValue: null, deviceTypes: ['linux'],
        },
      ],
      status: 'ready',
    } as never);
    writeColumnVisibility(['hostname']);
    writeVisibleCustomFieldKeys(['store']);
    render(<DeviceList devices={[device(1, { customFields: { store: '42' } })]} pageSize={10} />);

    fireEvent.click(screen.getByTestId('device-list-export-csv'));
    const out = lines(await exportedCsv());

    expect(out[0]).toBe(row('Device', 'Store #'));
    expect(out[1]).toBe(row('host-01', '42'));
  });

  it('fetches attention counts for ALL exported ids only when that column is visible', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const ids = new URL(url, 'http://x').searchParams.get('ids')!.split(',');
      const counts = Object.fromEntries(
        ids.map((id) => [id, { alerts: { critical: 1, high: 0, medium: 0, low: 0, info: 0 }, tickets: 2 }]),
      );
      return { ok: true, status: 200, json: async () => ({ counts }) } as unknown as Response;
    });
    writeColumnVisibility(['hostname', 'attention']);
    render(<DeviceList devices={fleet} pageSize={10} />);
    fetchMock.mockClear();

    fireEvent.click(screen.getByTestId('device-list-export-csv'));
    const out = lines(await exportedCsv());

    const exportedIds = fetchMock.mock.calls
      .flatMap(([url]) => new URL(String(url), 'http://x').searchParams.get('ids')!.split(','));
    expect(new Set(exportedIds).size).toBe(23);
    expect(out[0]).toBe(row('Device', 'Attention'));
    expect(out[23]).toBe(row('host-23', 'alerts: critical 1; tickets: 2'));
  });

  it('does not touch attention-counts when that column is hidden', async () => {
    writeColumnVisibility(['hostname', 'status']);
    render(<DeviceList devices={fleet} pageSize={10} />);

    fireEvent.click(screen.getByTestId('device-list-export-csv'));
    await exportedCsv();

    expect(fetchMock.mock.calls.filter(([u]) => String(u).startsWith('/devices/attention-counts'))).toHaveLength(0);
  });

  it('marks failed attention lookups as unavailable instead of blank', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) } as unknown as Response);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    writeColumnVisibility(['hostname', 'attention']);
    render(<DeviceList devices={[fleet[0]!]} pageSize={10} />);

    fireEvent.click(screen.getByTestId('device-list-export-csv'));
    const out = lines(await exportedCsv());

    expect(out[1]).toBe(row('host-01', 'unavailable'));
  });
});
