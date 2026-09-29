import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithAuth = vi.fn();
const authUser = vi.hoisted(() => ({ canManagePartnerWide: true as boolean | undefined }));
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a),
  useAuthStore: (selector: (s: { user: { canManagePartnerWide?: boolean } }) => unknown) =>
    selector({ user: { canManagePartnerWide: authUser.canManagePartnerWide } }),
}));
vi.mock('./reportExport', () => ({ exportReport: vi.fn(), downloadBlob: vi.fn(), getBrowserTimezone: () => 'UTC' }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
const claims = vi.hoisted(() => ({ value: { status: 'resolved', claims: { scope: 'partner', orgId: null, partnerId: 'p-1' } } as unknown }));
vi.mock('@/lib/authScope', () => ({ useJwtClaims: () => claims.value }));
const org = vi.hoisted(() => ({ currentOrgId: null as string | null }));
vi.mock('../../stores/orgStore', () => ({ useOrgStore: () => ({ currentOrgId: org.currentOrgId, organizations: [] }) }));
vi.mock('./series/SeriesDrilldown', () => ({
  SeriesDrilldown: ({ detail }: { detail: { series: { id: string } } }) => <div data-testid={`series-drilldown-${detail.series.id}`} />,
}));

import ReportsList from './ReportsList';

const SID = '6f1c1b1e-3b8a-4c52-9a47-0c1d2e3f4a5b';
const base = { type: 'device_inventory', schedule: 'monthly', format: 'pdf', config: {}, portalSelfService: false, lastGeneratedAt: null, createdAt: '', updatedAt: '' };
const single = { ...base, id: 'rep-s', name: 'Acme inventory', orgId: 'org-1', partnerId: null, orgName: 'Acme' };
const combined = { ...base, type: 'ar_aging', id: 'rep-c', name: 'All AR', orgId: null, partnerId: 'p-1' };
const child = { ...base, id: 'rep-child', name: 'Monthly health', orgId: 'org-1', partnerId: null, orgName: 'Acme', seriesId: SID, seriesName: 'Monthly health' };
const sent = { status: 'completed', deliveryStatus: 'sent', recipientCount: 2, completedAt: '2026-10-01T09:00:00Z' };
const SERIES = {
  series: { id: SID, name: 'Monthly health', type: 'device_inventory', format: 'pdf', schedule: 'monthly', config: {}, targetMode: 'all', recipientRule: { primaryContact: true, roles: [] }, internalCc: [], revision: 1, enabled: true, ownerUserId: 'u-1', createdAt: '', updatedAt: '' },
  targets: [],
  orgs: [
    ...Array.from({ length: 17 }, (_, i) => ({ orgId: `o${i}`, orgName: `Org ${i}`, state: 'active', childReportId: `c${i}`, lastRun: sent })),
    { orgId: 'o17', orgName: 'Acme Dental', state: 'blocked_no_recipients', childReportId: 'c17', lastRun: { ...sent, deliveryStatus: 'no_recipients', recipientCount: 0 } },
  ],
};

function mockApi({ list = [single, combined], series = [SERIES] as unknown[] } = {}) {
  fetchWithAuth.mockImplementation((url: string) => {
    if (url === '/reports' || url === '/reports?series=exclude') return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ data: list }) });
    if (url === '/reports/series') return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ data: series }) });
    if (url.startsWith('/reports/runs?')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ data: [] }) });
    return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
  });
}

describe('ReportsList — multi-org series (W03)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    claims.value = { status: 'resolved', claims: { scope: 'partner', orgId: null, partnerId: 'p-1' } };
    org.currentOrgId = null;
    authUser.canManagePartnerWide = true;
    window.location.hash = '';
  });

  it('All organizations: one row per series with its delivery summary; children are not listed', async () => {
    mockApi();
    render(<ReportsList />);
    const row = await screen.findByTestId(`report-series-row-${SID}`);
    expect(within(row).getByText('Monthly health')).toBeInTheDocument();
    const summary = screen.getByTestId(`report-series-summary-${SID}`);
    expect(summary).toHaveTextContent('17/18 delivered');
    expect(summary).toHaveTextContent('1 no recipient');
    expect(fetchWithAuth.mock.calls.some(([u]) => u === '/reports?series=exclude')).toBe(true);
    const seriesCall = fetchWithAuth.mock.calls.find(([u]) => u === '/reports/series');
    expect((seriesCall?.[1] as { skipOrgIdInjection?: boolean }).skipOrgIdInjection).toBe(true);
    expect(screen.queryByTestId('report-row-rep-child')).toBeNull();
  });

  it('expands from the hash and ignores a hash naming a deleted series', async () => {
    window.location.hash = `series/${SID}`;
    mockApi();
    render(<ReportsList />);
    expect(await screen.findByTestId(`series-drilldown-${SID}`)).toBeInTheDocument();
    window.location.hash = 'series/00000000-0000-4000-8000-000000000000';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await waitFor(() => expect(screen.queryByTestId(`series-drilldown-${SID}`)).toBeNull());
    expect(screen.getByTestId(`report-series-row-${SID}`)).toBeInTheDocument();
  });

  it('toggling a series writes the hash', async () => {
    mockApi();
    render(<ReportsList />);
    fireEvent.click(await screen.findByTestId(`report-series-toggle-${SID}`));
    expect(window.location.hash).toBe(`#series/${SID}`);
  });

  it('filter chips narrow the list and live in the hash', async () => {
    mockApi();
    render(<ReportsList />);
    await screen.findByTestId(`report-series-row-${SID}`);
    fireEvent.click(screen.getByTestId('reports-filter-combined'));
    expect(window.location.hash).toBe('#combined');
    expect(screen.getByTestId('report-row-rep-c')).toBeInTheDocument();
    expect(screen.queryByTestId('report-row-rep-s')).toBeNull();
    expect(screen.queryByTestId(`report-series-row-${SID}`)).toBeNull();
    fireEvent.click(screen.getByTestId('reports-filter-multi'));
    expect(screen.getByTestId(`report-series-row-${SID}`)).toBeInTheDocument();
    expect(screen.queryByTestId('report-row-rep-c')).toBeNull();
  });

  it('one org selected: children are ordinary rows with a Multi-org badge linking to the series, and no Delete', async () => {
    org.currentOrgId = 'org-1';
    mockApi({ list: [single, child] });
    render(<ReportsList />);
    const row = await screen.findByTestId('report-row-rep-child');
    const badge = within(row).getByTestId('report-series-badge-rep-child');
    expect(badge.closest('a')).toHaveAttribute('href', `/reports/series/${SID}`);
    expect(within(row).queryByTestId('report-delete-rep-child')).toBeNull();
    expect(fetchWithAuth.mock.calls.some(([u]) => u === '/reports/series')).toBe(false);
    expect(fetchWithAuth.mock.calls.some(([u]) => u === '/reports')).toBe(true);
  });

  it('an organization token never asks for series and shows the badge without a link', async () => {
    claims.value = { status: 'resolved', claims: { scope: 'organization', orgId: 'org-1', partnerId: 'p-1' } };
    mockApi({ list: [child] });
    render(<ReportsList />);
    const row = await screen.findByTestId('report-row-rep-child');
    expect(within(row).getByTestId('report-series-badge-rep-child').closest('a')).toBeNull();
    expect(fetchWithAuth.mock.calls.some(([u]) => u === '/reports/series')).toBe(false);
  });

  it('keeps the other rows when the series listing fails', async () => {
    mockApi();
    fetchWithAuth.mockImplementation((url: string) => {
      if (url === '/reports/series') return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) });
      if (url === '/reports?series=exclude') return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ data: [single] }) });
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ data: [] }) });
    });
    render(<ReportsList />);
    expect(await screen.findByTestId('report-row-rep-s')).toBeInTheDocument();
    expect(screen.getByTestId('reports-series-load-failed')).toBeInTheDocument();
  });

  // W03 final review: a session that passes the client gate but cannot read
  // series (403) must not lose every per-org copy from the grouped list.
  it('falls back to the ungrouped list when the series listing is forbidden', async () => {
    mockApi();
    fetchWithAuth.mockImplementation((url: string) => {
      if (url === '/reports/series') return Promise.resolve({ ok: false, status: 403, json: () => Promise.resolve({}) });
      if (url === '/reports') return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ data: [single, child] }) });
      if (url === '/reports?series=exclude') return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ data: [single] }) });
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ data: [] }) });
    });
    render(<ReportsList />);
    expect(await screen.findByTestId('report-row-rep-child')).toBeInTheDocument();
  });
});
