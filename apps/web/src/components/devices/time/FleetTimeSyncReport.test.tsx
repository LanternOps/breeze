import '@/lib/i18n';
import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import FleetTimeSyncReport from './FleetTimeSyncReport';
import DomainGroupView from './DomainGroupView';
import type { FleetTimeResult, FleetTimeRow } from './fleetTypes';
const m = vi.hoisted(() => ({
  fetch: vi.fn(),
  download: vi.fn(),
  sites: vi.fn(),
  currentOrgId: null as string | null,
}));
vi.mock('../../../stores/auth', () => ({
  fetchWithAuth: m.fetch,
  registerOrgIdProvider: vi.fn(),
}));
vi.mock('../../../lib/downloadBlob', () => ({ downloadBlob: m.download }));
vi.mock('../../../lib/fetchAllSites', () => ({ fetchAllSites: m.sites }));
vi.mock('../../../stores/orgStore', () => ({
  useOrgStore: (selector: any) =>
    selector({
      currentOrgId: m.currentOrgId,
      organizations: [
        { id: '11111111-1111-4111-8111-111111111111', name: 'Customer' },
      ],
    }),
}));
const org = '11111111-1111-4111-8111-111111111111';
function row(
  id: string,
  role: 'member' | 'pdc_emulator' = 'member',
): FleetTimeRow {
  return {
    deviceId: id,
    hostname: id,
    orgId: org,
    orgName: 'Customer',
    siteId: null,
    siteName: null,
    view: {
      deviceId: id,
      state: 'reported',
      stale: false,
      receivedAt: '2026-09-28T12:00:00Z',
      collectedAt: '2026-09-28T12:00:00Z',
      health: 'healthy',
      findings: [],
      config: null,
      status: null,
      domain: {
        joinType: 'on_prem_ad',
        role,
        domainDns: 'example.com',
        forestDns: 'example.com',
        pdcName: 'PDC',
      },
      timezone: null,
      recentEvents: [],
      enforcement: null,
    },
  };
}
const result = (data: FleetTimeRow[] = []): FleetTimeResult => ({
  data,
  total: data.length,
  page: 1,
  limit: 50,
  domains: [],
});
const response = (value: unknown, ok = true) =>
  ({
    ok,
    status: ok ? 200 : 500,
    json: async () => value,
    blob: async () => new Blob(['csv']),
  }) as Response;
beforeEach(() => {
  window.location.hash = '';
  m.currentOrgId = null;
  m.fetch.mockReset().mockResolvedValue(response(result([row('Member')])));
  m.download.mockReset();
  m.sites.mockReset().mockResolvedValue([]);
});
it('keeps filters and view in the hash and sends scoped transport filters', async () => {
  render(<FleetTimeSyncReport />);
  await screen.findByTestId('time-row-Member');
  fireEvent.change(screen.getByTestId('time-filter-health'), {
    target: { value: 'warning' },
  });
  fireEvent.change(screen.getByTestId('time-view'), {
    target: { value: 'domain' },
  });
  await waitFor(() => expect(window.location.hash).toContain('view=domain'));
  expect(window.location.search).toBe('');
  await waitFor(() =>
    expect(
      m.fetch.mock.calls.some(([url]) =>
        String(url).includes('health=warning'),
      ),
    ).toBe(true),
  );
});
it('pins the context PDC once and marks an unenrolled PDC within caller visibility', () => {
  const pdc = row('PDC', 'pdc_emulator');
  const value = {
    ...result([row('Member'), pdc]),
    domains: [
      {
        orgId: org,
        domainDns: 'example.com',
        pdcEnrolled: true,
        pdcExpected: true,
        pdc,
      },
    ],
  };
  const { rerender } = render(<DomainGroupView result={value} />);
  expect(
    screen
      .getAllByTestId(/^time-row-/)
      .map((e) => e.getAttribute('data-testid')),
  ).toEqual(['time-row-PDC', 'time-row-Member']);
  rerender(
    <DomainGroupView
      result={{
        ...value,
        data: [row('Member')],
        domains: [{ ...value.domains[0]!, pdcEnrolled: false, pdc: null }],
      }}
    />,
  );
  expect(screen.getByTestId('time-pdc-warning')).toBeTruthy();
});
it('shows no-data and stale observations explicitly', async () => {
  const empty = row('NoData');
  empty.view = {
    ...empty.view,
    state: 'not_reported',
    health: 'unknown',
    receivedAt: null,
  };
  const old = row('Old');
  old.view.stale = true;
  m.fetch.mockResolvedValue(response(result([empty, old])));
  render(<FleetTimeSyncReport />);
  await screen.findByTestId('time-row-NoData');
  expect(screen.getByText('No time data yet')).toBeTruthy();
  expect(screen.getByText('Stale')).toBeTruthy();
});
it('does not let an older response replace a new filter result', async () => {
  let finish!: (value: Response) => void;
  m.fetch
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue(response(result([row('New')])));
  render(<FleetTimeSyncReport />);
  fireEvent.change(screen.getByTestId('time-filter-health'), {
    target: { value: 'critical' },
  });
  await screen.findByTestId('time-row-New');
  finish(response(result([row('Old')])));
  await waitFor(() => expect(screen.queryByTestId('time-row-Old')).toBeNull());
});
it('downloads complete authenticated CSV and reports HTTP failures without a download', async () => {
  render(<FleetTimeSyncReport />);
  await screen.findByTestId('time-row-Member');
  fireEvent.click(screen.getByTestId('time-export-current'));
  await waitFor(() =>
    expect(m.download).toHaveBeenCalledWith(
      expect.any(Blob),
      'time-status.csv',
    ),
  );
  m.download.mockClear();
  m.fetch.mockResolvedValueOnce(response({}, false));
  fireEvent.click(screen.getByTestId('time-export-current'));
  await screen.findByTestId('time-export-error');
  expect(m.download).not.toHaveBeenCalled();
});
it('reports 401 and network failures without a successful download', async () => {
  render(<FleetTimeSyncReport />);
  await screen.findByTestId('time-row-Member');
  m.fetch.mockResolvedValueOnce({ ...response({}, false), status: 401 });
  fireEvent.click(screen.getByTestId('time-export-current'));
  await screen.findByTestId('time-export-error');
  expect(m.download).not.toHaveBeenCalled();
  m.fetch.mockRejectedValueOnce(new Error('network unavailable'));
  fireEvent.click(screen.getByTestId('time-export-current'));
  await screen.findByTestId('time-export-error');
  expect(m.download).not.toHaveBeenCalled();
});
it('does not download a partial body when the CSV stream fails', async () => {
  render(<FleetTimeSyncReport />);
  await screen.findByTestId('time-row-Member');
  m.fetch.mockResolvedValueOnce({
    ...response({}),
    blob: async () => {
      throw new Error('stream interrupted');
    },
  });
  fireEvent.click(screen.getByTestId('time-export-current'));
  await screen.findByTestId('time-export-error');
  expect(m.download).not.toHaveBeenCalled();
});
it('clears hidden site and page filters when the global organization changes', async () => {
  window.location.hash = 'siteId=22222222-2222-4222-8222-222222222222&page=3';
  const { rerender } = render(<FleetTimeSyncReport />);
  await screen.findByTestId('time-row-Member');
  m.currentOrgId = org;
  rerender(<FleetTimeSyncReport />);
  await waitFor(() => {
    const hash = new URLSearchParams(window.location.hash.slice(1));
    expect(hash.get('siteId')).toBeNull();
    expect(hash.get('page')).toBe('1');
    expect(hash.get('orgId')).toBe(org);
  });
  await waitFor(() => {
    const url = String(m.fetch.mock.calls.at(-1)![0]);
    expect(url).not.toContain('siteId=');
    expect(url).toContain('page=1');
  });
});
it('offers retry after load failure and distinguishes an empty report', async () => {
  m.fetch
    .mockResolvedValueOnce(response({}, false))
    .mockResolvedValue(response(result()));
  render(<FleetTimeSyncReport />);
  await screen.findByTestId('time-load-error');
  fireEvent.click(screen.getByTestId('time-retry'));
  await screen.findByTestId('time-empty');
});
