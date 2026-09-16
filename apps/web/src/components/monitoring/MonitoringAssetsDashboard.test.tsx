// apps/web/src/components/monitoring/MonitoringAssetsDashboard.test.tsx
import '@/lib/i18n';

import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import MonitoringAssetsDashboard from './MonitoringAssetsDashboard';
import { fetchWithAuth } from '@/stores/auth';
import { navigateTo } from '@/lib/navigation';

vi.mock('@/stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('@/components/shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('../../stores/orgStore', () => ({ useOrgStore: (sel: (s: unknown) => unknown) => sel({ currentOrgId: 'org-1' }) }));
vi.mock('@/hooks/useOrgScope', () => ({
  useOrgScope: () => ({ ready: true, status: 'resolved', scope: 'org', orgId: 'org-1', org: null, error: null }),
}));

const fetchMock = vi.mocked(fetchWithAuth);
const navigateMock = vi.mocked(navigateTo);
const res = (payload: unknown, status = 200): Response =>
  ({ ok: status < 400, status, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

const baseAsset = {
  id: 'asset-1',
  hostname: 'core-sw-01',
  ipAddress: '10.0.0.2',
  assetType: 'switch',
  lastSeenAt: minutesAgo(5),
  monitoring: { configured: true, active: true },
  snmp: {
    configured: true, deviceId: 'snmp-1', snmpVersion: 'v2c', templateId: 't-1',
    pollingInterval: 300, port: 161, isActive: true, lastPolled: minutesAgo(2), lastStatus: 'online',
  },
  network: { configured: true, totalCount: 2, activeCount: 2 },
  reachability: { state: 'responding', source: 'snmp', observedAt: minutesAgo(2), lastKnown: null },
};

function wire(assets: unknown[] = [baseAsset]) {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method) return Promise.resolve(res({ success: true }));
    if (url.startsWith('/monitoring/assets')) return Promise.resolve(res({ data: assets }));
    if (url === '/snmp/templates') return Promise.resolve(res({ templates: [] }));
    return Promise.resolve(res({}));
  });
}

const writes = () => fetchMock.mock.calls.filter(([, init]) => (init as RequestInit)?.method);

beforeEach(() => {
  fetchMock.mockReset();
  navigateMock.mockReset();
});

describe.each(['responsive-table-desktop', 'responsive-table-cards'])('%s', (surface) => {
  const row = async () => within(await screen.findByTestId(surface));

  describe('MonitoringAssetsDashboard — reachability and collection columns (W01 fields)', () => {
    it('names the source and the age, never a bare "Online"', async () => {
      wire();
      render(<MonitoringAssetsDashboard />);

      const cell = await (await row()).findByTestId('monitoring-asset-reachability-asset-1');
      expect(cell.textContent).toMatch(/Responding · SNMP \d+m ago/);
      expect((await row()).queryByText('Online')).not.toBeInTheDocument();
      expect(cell.textContent).not.toBe('Online');
      expect(cell.textContent).not.toMatch(/\bOnline\b/);
    });

    it('renders an explicit unknown when the API has no reachability yet (pre-W01)', async () => {
      const { reachability, ...withoutReachability } = baseAsset;
      wire([withoutReachability]);
      render(<MonitoringAssetsDashboard />);

      const cell = await (await row()).findByTestId('monitoring-asset-reachability-asset-1');
      expect(cell).toHaveTextContent('—');
      expect(cell).toHaveAttribute('aria-label', 'unknown');
    });

    it('reports a collecting device with its poll age', async () => {
      wire();
      render(<MonitoringAssetsDashboard />);

      const cell = await (await row()).findByTestId('monitoring-asset-collection-asset-1');
      expect(cell.textContent).toMatch(/Collecting/);
      expect(cell.textContent).toMatch(/Last polled \d+m ago/);
    });

    it('reports W01\'s no_template status as its own state, not as a failure', async () => {
      wire([{ ...baseAsset, snmp: { ...baseAsset.snmp, lastStatus: 'no_template' } }]);
      render(<MonitoringAssetsDashboard />);

      expect(await (await row()).findByTestId('monitoring-asset-collection-asset-1')).toHaveTextContent('No template');
    });

    it('reports a paused poller as paused and a never-polled one as never polled', async () => {
      wire([
        { ...baseAsset, id: 'a-paused', snmp: { ...baseAsset.snmp, isActive: false } },
        { ...baseAsset, id: 'a-new', snmp: { ...baseAsset.snmp, lastPolled: null, lastStatus: null } },
      ]);
      render(<MonitoringAssetsDashboard />);

      expect(await (await row()).findByTestId('monitoring-asset-collection-a-paused')).toHaveTextContent('Paused');
      expect((await row()).getByTestId('monitoring-asset-collection-a-new')).toHaveTextContent('Never polled');
    });
  });

  describe('MonitoringAssetsDashboard — row actions', () => {
    it('launches the device page settings instead of an in-page editor', async () => {
      wire();
      render(<MonitoringAssetsDashboard />);

      fireEvent.click(await (await row()).findByTestId('monitoring-asset-settings-asset-1'));

      expect(navigateMock).toHaveBeenCalledWith('/devices/network/asset-1#overview/settings/monitoring');
      expect(screen.queryByText('Configure Monitoring')).not.toBeInTheDocument();
    });

    it('pauses SNMP polling through the mutation hook', async () => {
      wire();
      render(<MonitoringAssetsDashboard />);

      fireEvent.click(await (await row()).findByTestId('monitoring-asset-pause-asset-1'));

      await waitFor(() => expect(writes()).toHaveLength(1));
      expect(writes()[0]![0]).toBe('/monitoring/assets/asset-1/snmp');
      expect((writes()[0]![1] as RequestInit).method).toBe('PATCH');
      expect(JSON.parse((writes()[0]![1] as RequestInit).body as string)).toEqual({ isActive: false });
      await waitFor(() => expect(fetchMock.mock.calls.filter(([url, init]) => url.startsWith('/monitoring/assets') && !init?.method)).toHaveLength(2));
    });

    it('resumes a paused poller with isActive:true', async () => {
      wire([{ ...baseAsset, snmp: { ...baseAsset.snmp, isActive: false } }]);
      render(<MonitoringAssetsDashboard />);

      fireEvent.click(await (await row()).findByTestId('monitoring-asset-resume-asset-1'));

      await waitFor(() => expect(writes()).toHaveLength(1));
      expect(JSON.parse((writes()[0]![1] as RequestInit).body as string)).toEqual({ isActive: true });
    });

    it('disables all monitoring through the mutation hook', async () => {
      wire();
      render(<MonitoringAssetsDashboard />);

      fireEvent.click(await (await row()).findByTestId('monitoring-asset-disable-asset-1'));

      await waitFor(() => expect(writes()).toHaveLength(1));
      expect(writes()[0]![0]).toBe('/monitoring/assets/asset-1');
      expect((writes()[0]![1] as RequestInit).method).toBe('DELETE');
    });
  });

  describe('MonitoringAssetsDashboard — the ?assetId deep link still lands somewhere', () => {
    it('redirects to the device page settings rather than opening a panel', async () => {
      wire();
      render(<MonitoringAssetsDashboard initialAssetId="asset-9" />);

      await waitFor(() =>
        expect(navigateMock).toHaveBeenCalledWith('/devices/network/asset-9#overview/settings/monitoring', { replace: true }),
      );
    });

    it('never fetches the per-asset detail endpoint any more', async () => {
      wire();
      render(<MonitoringAssetsDashboard />);
      await (await row()).findByTestId('monitoring-asset-reachability-asset-1');

      expect(fetchMock.mock.calls.some(([url]) => url === '/monitoring/assets/asset-1')).toBe(false);
    });
  });

});
