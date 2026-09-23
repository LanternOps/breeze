import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));

vi.mock('./reportExport', () => ({
  exportReport: vi.fn(),
  downloadBlob: vi.fn(),
  getBrowserTimezone: () => 'UTC',
}));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

const claims = vi.hoisted(() => ({
  value: { status: 'resolved', claims: { scope: 'partner', orgId: null, partnerId: 'p-1' } } as unknown,
}));
vi.mock('@/lib/authScope', () => ({ useJwtClaims: () => claims.value }));
const org = vi.hoisted(() => ({ currentOrgId: null as string | null }));
vi.mock('../../stores/orgStore', () => ({ useOrgStore: () => ({ currentOrgId: org.currentOrgId }) }));

import ReportsList from './ReportsList';

const base = {
  type: 'ar_aging',
  schedule: 'monthly',
  format: 'pdf',
  config: {},
  portalSelfService: false,
  lastGeneratedAt: null,
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
};
const partnerOwned = { ...base, id: 'rep-p', name: 'All-clients AR', orgId: null, partnerId: 'p-1' };
const orgOwned = { ...base, id: 'rep-o', name: 'Acme AR', orgId: 'org-1', partnerId: null };

function mockList(rows: unknown[]) {
  fetchWithAuth.mockImplementation((url: string) => {
    if (url === '/reports') return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: rows }) });
    if (url.startsWith('/reports/runs?')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [] }) });
    return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
  });
}

describe('ReportsList ownership (#3198 W03)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    claims.value = { status: 'resolved', claims: { scope: 'partner', orgId: null, partnerId: 'p-1' } };
    org.currentOrgId = null;
  });

  it('tags every row and badges only the partner-owned (all-organizations) one', async () => {
    mockList([partnerOwned, orgOwned]);
    render(<ReportsList />);

    const partnerRow = await screen.findByTestId('report-row-rep-p');
    const orgRow = screen.getByTestId('report-row-rep-o');
    const badge = within(partnerRow).getByTestId('report-scope-badge-rep-p');
    expect(within(badge).getByTestId('scope-badge')).toBeInTheDocument();
    expect(within(orgRow).queryByTestId('report-scope-badge-rep-o')).toBeNull();
    expect(within(orgRow).queryByTestId('scope-badge')).toBeNull();
  });

  it('keeps the ambient org injection on the list request (no skipOrgIdInjection)', async () => {
    mockList([orgOwned]);
    render(<ReportsList />);
    await screen.findByTestId('report-row-rep-o');
    const listCall = fetchWithAuth.mock.calls.find(([url]) => url === '/reports');
    expect(listCall).toBeDefined();
    expect(listCall?.[1]).toBeUndefined();
  });

  it('tells a partner-scope user with an org focused where all-organizations reports live', async () => {
    org.currentOrgId = 'org-1';
    mockList([orgOwned]);
    render(<ReportsList />);
    await screen.findByTestId('report-row-rep-o');
    expect(screen.getByTestId('reports-partner-wide-hint')).toHaveTextContent(/All organizations/);
  });

  it('shows no hint on the All-organizations view', async () => {
    mockList([partnerOwned]);
    render(<ReportsList />);
    await screen.findByTestId('report-row-rep-p');
    expect(screen.queryByTestId('reports-partner-wide-hint')).toBeNull();
  });

  it('shows no hint to an organization-scope user or while the token is unresolved', async () => {
    org.currentOrgId = 'org-1';
    claims.value = { status: 'resolved', claims: { scope: 'organization', orgId: 'org-1', partnerId: 'p-1' } };
    mockList([orgOwned]);
    const { unmount } = render(<ReportsList />);
    await screen.findByTestId('report-row-rep-o');
    expect(screen.queryByTestId('reports-partner-wide-hint')).toBeNull();
    unmount();

    claims.value = { status: 'unresolved' };
    render(<ReportsList />);
    await waitFor(() => expect(screen.getByTestId('report-row-rep-o')).toBeInTheDocument());
    expect(screen.queryByTestId('reports-partner-wide-hint')).toBeNull();
  });
});
